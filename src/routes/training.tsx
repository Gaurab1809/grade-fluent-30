import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { TopBar } from "@/components/TopBar";
import { FileDropzone } from "@/components/FileDropzone";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { GraduationCap, Loader2, Sparkles, Upload, Wand2, BarChart3, Trash2, ArrowRight } from "lucide-react";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

const MODELS = [
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "openai/gpt-5-mini",       label: "GPT-5 Mini" },
];

type Split = "train" | "val" | "test";
type Stage = "queued" | "uploading" | "extracting" | "ready" | "evaluating" | "done" | "error";

type LabeledPaper = {
  localId: string;
  file: File;
  title: string;
  split: Split;
  humanTotal: string; // string for input flexibility
  stage: Stage;
  evaluationId?: string;
  error?: string;
};

async function parseRubricFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt") || name.endsWith(".md") || file.type.startsWith("text/")) return await file.text();
  if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv")) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    return wb.SheetNames.map((s) => XLSX.utils.sheet_to_csv(wb.Sheets[s]).trim()).filter(Boolean).join("\n\n");
  }
  if (name.endsWith(".docx")) {
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return value.trim();
  }
  throw new Error("Unsupported rubric file type");
}

// Deterministic 70/15/15 split by index
function autoAssignSplit(idx: number, total: number): Split {
  const ratio = total === 0 ? 0 : idx / total;
  if (ratio < 0.7) return "train";
  if (ratio < 0.85) return "val";
  return "test";
}

export const Route = createFileRoute("/training")({
  head: () => ({
    meta: [
      { title: "Training — Khata" },
      { name: "description", content: "Bulk-upload labeled papers, auto-split, and calibrate models." },
    ],
  }),
  component: TrainingPage,
});

function TrainingPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  const [rubric, setRubric] = useState("");
  const [rubricFileName, setRubricFileName] = useState<string | null>(null);
  const [papers, setPapers] = useState<LabeledPaper[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: "" });

  const counts = useMemo(() => {
    const c = { train: 0, val: 0, test: 0 };
    papers.forEach((p) => c[p.split]++);
    return c;
  }, [papers]);

  const onAddFiles = (files: File[]) => {
    setPapers((prev) => {
      const next = [...prev];
      for (const f of files) {
        next.push({
          localId: crypto.randomUUID(),
          file: f,
          title: f.name.replace(/\.[^.]+$/, ""),
          split: "train", // temp; reassigned below
          humanTotal: "",
          stage: "queued",
        });
      }
      // Re-balance splits across all papers (deterministic)
      return next.map((p, i) => ({ ...p, split: autoAssignSplit(i, next.length) }));
    });
  };

  const reshuffle = () => {
    setPapers((prev) => {
      const arr = [...prev];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr.map((p, i) => ({ ...p, split: autoAssignSplit(i, arr.length) }));
    });
  };

  const onRubricFile = async (files: File[]) => {
    if (!files[0]) return;
    try {
      const text = await parseRubricFile(files[0]);
      setRubric(text);
      setRubricFileName(files[0].name);
      toast.success("Rubric loaded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to parse rubric");
    }
  };

  const updatePaper = (id: string, patch: Partial<LabeledPaper>) =>
    setPapers((prev) => prev.map((p) => (p.localId === id ? { ...p, ...patch } : p)));

  const removePaper = (id: string) => setPapers((prev) => prev.filter((p) => p.localId !== id));

  // Upload + extract a single paper, persist split + human_total
  const ingestPaper = async (paper: LabeledPaper): Promise<string | null> => {
    if (!user) return null;
    try {
      updatePaper(paper.localId, { stage: "uploading", error: undefined });
      const ext = paper.file.name.split(".").pop() || "bin";
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("exam-papers")
        .upload(path, paper.file, { contentType: paper.file.type, upsert: false });
      if (upErr) throw upErr;
      const uploaded = [{ path, mime: paper.file.type, name: paper.file.name }];

      const humanTotalNum = paper.humanTotal.trim() === "" ? null : Number(paper.humanTotal);
      const { data: ins, error: insErr } = await supabase
        .from("evaluations")
        .insert({
          user_id: user.id,
          title: paper.title,
          file_path: path,
          file_mime: paper.file.type,
          paper_files: uploaded,
          status: "uploaded",
          split: paper.split,
          rubric,
          human_total: humanTotalNum,
        })
        .select()
        .single();
      if (insErr || !ins) throw insErr ?? new Error("Failed to create record");

      updatePaper(paper.localId, { evaluationId: ins.id, stage: "extracting" });
      const { data, error } = await supabase.functions.invoke("extract-text", {
        body: { evaluationId: ins.id, files: uploaded },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      updatePaper(paper.localId, { stage: "ready" });
      return ins.id;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed";
      updatePaper(paper.localId, { stage: "error", error: msg });
      return null;
    }
  };

  // Run ALL models × {baseline, few-shot} on val+test papers (calibration sweep)
  const evaluateOne = async (paper: LabeledPaper, model: string, variant: string) => {
    if (!paper.evaluationId) return;
    const { data, error } = await supabase.functions.invoke("evaluate-paper", {
      body: {
        evaluationId: paper.evaluationId,
        extractedText: "", // backend pulls latest from evaluations row if empty? — we send rubric+text from DB
        rubric,
        model,
        promptVariant: variant,
      },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
  };

  const startCalibration = async () => {
    if (!user) return;
    if (papers.length < 2) {
      toast.error("Add at least 2 papers (ideally 5+ in train).");
      return;
    }
    if (!rubric.trim()) {
      toast.error("Add a rubric first.");
      return;
    }
    if (counts.train < 1) {
      toast.error("You need at least 1 paper in the Train split for few-shot calibration.");
      return;
    }

    setBusy(true);
    try {
      // Phase 1: Ingest (upload + extract) all papers
      setProgress({ done: 0, total: papers.length, label: "Uploading & extracting" });
      const ids: { paper: LabeledPaper; id: string }[] = [];
      let done = 0;
      for (const p of papers) {
        const id = p.evaluationId ?? (await ingestPaper(p));
        done++;
        setProgress({ done, total: papers.length, label: "Uploading & extracting" });
        if (id) ids.push({ paper: { ...p, evaluationId: id }, id });
      }

      if (ids.length === 0) {
        toast.error("No papers ingested successfully.");
        return;
      }

      // We need extracted text for evaluate-paper. Re-read from DB.
      const { data: rows, error: rowsErr } = await supabase
        .from("evaluations")
        .select("id,extracted_text,rubric,split")
        .in("id", ids.map((x) => x.id));
      if (rowsErr) throw rowsErr;
      const byId = new Map(rows!.map((r) => [r.id, r]));

      // Phase 2: Evaluate val + test papers across all models and variants
      const evalTargets = ids.filter((x) => x.paper.split !== "train");
      const variants = ["baseline", "few-shot"];
      const totalEvals = evalTargets.length * MODELS.length * variants.length;
      setProgress({ done: 0, total: totalEvals, label: "Running calibration" });

      let evalDone = 0;
      for (const tgt of evalTargets) {
        const row = byId.get(tgt.id);
        if (!row?.extracted_text) {
          evalDone += MODELS.length * variants.length;
          setProgress({ done: evalDone, total: totalEvals, label: "Running calibration" });
          updatePaper(tgt.paper.localId, { stage: "error", error: "No extracted text" });
          continue;
        }
        updatePaper(tgt.paper.localId, { stage: "evaluating" });

        for (const model of MODELS) {
          for (const variant of variants) {
            try {
              const { data, error } = await supabase.functions.invoke("evaluate-paper", {
                body: {
                  evaluationId: tgt.id,
                  extractedText: row.extracted_text,
                  rubric: row.rubric ?? rubric,
                  model: model.id,
                  promptVariant: variant,
                },
              });
              if (error) throw error;
              if (data?.error) throw new Error(data.error);
            } catch (e) {
              console.warn(`Eval failed for ${tgt.paper.title} ${model.id}/${variant}:`, e);
            }
            evalDone++;
            setProgress({ done: evalDone, total: totalEvals, label: "Running calibration" });
          }
        }
        updatePaper(tgt.paper.localId, { stage: "done" });
      }

      // Mark train papers done
      ids.filter((x) => x.paper.split === "train").forEach((x) =>
        updatePaper(x.paper.localId, { stage: "done" }),
      );

      toast.success(`Calibration complete. ${evalTargets.length} papers × ${MODELS.length} models × 2 variants.`);
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "Calibration failed");
    } finally {
      setBusy(false);
      setProgress({ done: 0, total: 0, label: "" });
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8 space-y-6">
        <header className="space-y-2">
          <div className="flex items-center gap-2 text-accent">
            <GraduationCap className="h-5 w-5" />
            <span className="font-display text-xl">Training & Calibration</span>
          </div>
          <p className="text-muted-foreground max-w-2xl">
            Bulk-upload labeled student papers. We'll auto-assign Train (70%) / Val (15%) / Test (15%) splits,
            extract text, then sweep every model × prompt variant against your val+test set so you can pick the
            best one in <Link to="/metrics" className="underline">Metrics</Link>.
          </p>
        </header>

        {/* Rubric */}
        <section className="rounded-xl border border-border bg-card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <Label className="font-display text-base">Rubric (shared across all papers)</Label>
            {rubricFileName && <Badge variant="secondary">{rubricFileName}</Badge>}
          </div>
          <label className="block rounded-lg border-2 border-dashed border-border bg-background hover:border-accent hover:bg-accent/5 cursor-pointer text-center px-4 py-6 transition-colors">
            <input
              type="file"
              accept=".txt,.md,.csv,.xlsx,.xls,.docx"
              className="hidden"
              onChange={(e) => e.target.files && onRubricFile(Array.from(e.target.files))}
            />
            <div className="text-sm text-muted-foreground">
              {rubricFileName ? "Replace rubric file" : "Drop rubric file (.xlsx, .csv, .docx, .txt)"}
            </div>
          </label>
          <Textarea
            value={rubric}
            onChange={(e) => setRubric(e.target.value)}
            placeholder="Or paste the rubric here…"
            className="min-h-[120px] font-mono text-xs"
          />
        </section>

        {/* Papers bulk upload */}
        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <Label className="font-display text-base">Labeled papers</Label>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">Train: {counts.train}</Badge>
              <Badge variant="outline">Val: {counts.val}</Badge>
              <Badge variant="outline">Test: {counts.test}</Badge>
              {papers.length > 1 && (
                <Button variant="ghost" size="sm" onClick={reshuffle} disabled={busy}>
                  Reshuffle
                </Button>
              )}
            </div>
          </div>

          <FileDropzone files={[]} onFiles={onAddFiles} />

          {papers.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2">Title</th>
                    <th className="text-left px-3 py-2">Split</th>
                    <th className="text-left px-3 py-2">Human total</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="px-3 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {papers.map((p) => (
                    <tr key={p.localId} className="border-t border-border">
                      <td className="px-3 py-2">
                        <Input
                          value={p.title}
                          onChange={(e) => updatePaper(p.localId, { title: e.target.value })}
                          className="h-8 text-sm"
                          disabled={busy}
                        />
                        <div className="text-[11px] text-muted-foreground mt-0.5 truncate max-w-[260px]">{p.file.name}</div>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={p.split}
                          onChange={(e) => updatePaper(p.localId, { split: e.target.value as Split })}
                          disabled={busy}
                          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                        >
                          <option value="train">Train</option>
                          <option value="val">Val</option>
                          <option value="test">Test</option>
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          inputMode="decimal"
                          step="0.5"
                          value={p.humanTotal}
                          onChange={(e) => updatePaper(p.localId, { humanTotal: e.target.value })}
                          placeholder="e.g. 78"
                          className="h-8 w-24 text-sm"
                          disabled={busy}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <StageBadge stage={p.stage} error={p.error} />
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => removePaper(p.localId)}
                          disabled={busy}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Action bar */}
        <section className="rounded-xl border border-border bg-card p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              <Sparkles className="inline h-4 w-4 mr-1 text-accent" />
              Will run <strong>{Math.max(0, counts.val + counts.test)}</strong> papers ×{" "}
              <strong>{MODELS.length}</strong> models × <strong>2</strong> variants ={" "}
              <strong>{Math.max(0, (counts.val + counts.test) * MODELS.length * 2)}</strong> evaluations.
            </div>
            <div className="flex gap-2">
              <Link to="/metrics">
                <Button variant="outline" size="sm">
                  <BarChart3 className="h-4 w-4 mr-1.5" /> View metrics
                </Button>
              </Link>
              <Button onClick={startCalibration} disabled={busy || papers.length === 0 || !rubric.trim()}>
                {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Wand2 className="h-4 w-4 mr-1.5" />}
                Start calibration
              </Button>
            </div>
          </div>

          {busy && progress.total > 0 && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{progress.label}</span>
                <span>{progress.done} / {progress.total}</span>
              </div>
              <Progress value={(progress.done / progress.total) * 100} />
            </div>
          )}
        </section>

        <div className="flex justify-end">
          <Link to="/metrics">
            <Button variant="ghost" size="sm">
              Compare models in Metrics <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
          </Link>
        </div>
      </main>
    </div>
  );
}

function StageBadge({ stage, error }: { stage: Stage; error?: string }) {
  if (stage === "error") return <Badge variant="destructive" title={error}>Error</Badge>;
  if (stage === "queued") return <Badge variant="outline">Queued</Badge>;
  if (stage === "uploading") return <Badge variant="secondary"><Upload className="h-3 w-3 mr-1" />Uploading</Badge>;
  if (stage === "extracting") return <Badge variant="secondary"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Extracting</Badge>;
  if (stage === "ready") return <Badge variant="secondary">Ready</Badge>;
  if (stage === "evaluating") return <Badge variant="secondary"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Evaluating</Badge>;
  return <Badge className="bg-emerald-600 hover:bg-emerald-600">Done</Badge>;
}
