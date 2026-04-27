import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { TopBar } from "@/components/TopBar";
import { FileDropzone } from "@/components/FileDropzone";
import { GradingResults, type EvaluationData, type HumanCriterion } from "@/components/GradingResults";
import { HistorySheet } from "@/components/HistorySheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Sparkles, Wand2, Loader2, Download, FileText, RefreshCw, Upload, Check,
} from "lucide-react";
import * as XLSX from "xlsx";
import mammoth from "mammoth";

// ---------- Models ----------
type ModelOption = { id: string; label: string; short: string };
const MODELS: ModelOption[] = [
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", short: "Gemini" },
  { id: "openai/gpt-5-mini",       label: "GPT-5 Mini",       short: "GPT-5" },
];

async function parseRubricFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt") || name.endsWith(".md") || file.type.startsWith("text/")) {
    return await file.text();
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv")) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const parts: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]).trim();
      if (!csv) continue;
      parts.push(wb.SheetNames.length > 1 ? `# ${sheetName}\n${csv}` : csv);
    }
    return parts.join("\n\n");
  }
  if (name.endsWith(".docx")) {
    const buf = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
    return value.trim();
  }
  throw new Error("Unsupported file type. Use .xlsx, .xls, .csv, .docx, .txt or paste below.");
}

export const Route = createFileRoute("/")({
  component: Workspace,
});

type Stage = "idle" | "uploading" | "extracting" | "extracted" | "evaluating" | "evaluated";

type ModelRunResult = {
  model: string;
  data?: EvaluationData;
  error?: string;
  latency_ms?: number;
};

function Workspace() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>("idle");
  const [files, setFiles] = useState<File[]>([]);
  const [evaluationId, setEvaluationId] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<string>("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [rubric, setRubric] = useState<string>("");
  const [selectedModels, setSelectedModels] = useState<string[]>(MODELS.map((m) => m.id));
  const [runs, setRuns] = useState<ModelRunResult[]>([]);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [humanCriteria, setHumanCriteria] = useState<HumanCriterion[] | undefined>(undefined);
  const [historyOpen, setHistoryOpen] = useState(false);
  const rubricFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [user, loading, navigate]);

  const reset = () => {
    setFiles([]);
    setEvaluationId(null);
    setExtracted("");
    setConfidence(null);
    setRuns([]);
    setActiveModel(null);
    setHumanCriteria(undefined);
    setStage("idle");
  };

  const loadFromHistory = async (id: string) => {
    const { data, error } = await supabase.from("evaluations").select("*").eq("id", id).single();
    if (error || !data) return toast.error(error?.message ?? "Not found");
    setFiles([]);
    setEvaluationId(data.id);
    setExtracted(data.extracted_text ?? "");
    setConfidence(data.ocr_confidence != null ? Number(data.ocr_confidence) : null);
    setRubric(data.rubric ?? "");
    setHumanCriteria((data.criterion_scores_human as HumanCriterion[] | null) ?? undefined);

    const { data: runRows } = await supabase
      .from("model_runs")
      .select("*")
      .eq("evaluation_id", id)
      .order("created_at", { ascending: true });
    const loaded: ModelRunResult[] = (runRows ?? []).map((r) => ({
      model: r.model,
      data: r.evaluation_json as EvaluationData | undefined,
      error: r.error ?? undefined,
      latency_ms: r.latency_ms ?? undefined,
    }));
    setRuns(loaded);
    setActiveModel(loaded.find((r) => r.data)?.model ?? null);
    setStage(loaded.length ? "evaluated" : data.extracted_text ? "extracted" : "idle");
  };

  const onExtract = async () => {
    if (files.length === 0 || !user) return;
    setStage("uploading");
    try {
      // Upload all files to storage
      const uploaded: { path: string; mime: string; name: string }[] = [];
      for (const f of files) {
        const ext = f.name.split(".").pop() || "bin";
        const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage.from("exam-papers").upload(path, f, {
          contentType: f.type, upsert: false,
        });
        if (upErr) throw upErr;
        uploaded.push({ path, mime: f.type, name: f.name });
      }

      const title = files.length === 1 ? files[0].name : `${files[0].name} (+${files.length - 1} more)`;
      const { data: ins, error: insErr } = await supabase
        .from("evaluations")
        .insert({
          user_id: user.id,
          title,
          file_path: uploaded[0].path,
          file_mime: uploaded[0].mime,
          paper_files: uploaded,
          status: "uploaded",
        })
        .select()
        .single();
      if (insErr || !ins) throw insErr ?? new Error("Failed to create record");
      setEvaluationId(ins.id);

      setStage("extracting");
      const { data, error } = await supabase.functions.invoke("extract-text", {
        body: { evaluationId: ins.id, files: uploaded },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      setExtracted(data.markdown);
      setConfidence(data.confidence ?? null);
      setStage("extracted");
      toast.success(`Transcribed ${data.pages ?? 1} page${data.pages === 1 ? "" : "s"}.`);
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "Extraction failed");
      setStage("idle");
    }
  };

  const onEvaluate = async () => {
    if (!evaluationId || !extracted.trim() || !rubric.trim() || selectedModels.length === 0) {
      toast.error("Add a rubric, extracted text, and at least one model.");
      return;
    }
    setStage("evaluating");
    setRuns(selectedModels.map((m) => ({ model: m })));
    setActiveModel(null);
    try {
      // Kick off all models in parallel
      const settled = await Promise.allSettled(
        selectedModels.map(async (model) => {
          const { data, error } = await supabase.functions.invoke("evaluate-paper", {
            body: { evaluationId, extractedText: extracted, rubric, model, promptVariant: "baseline" },
          });
          if (error) throw error;
          if (data?.error) throw new Error(data.error);
          return { model, data: data as EvaluationData, latency_ms: data.latency_ms };
        }),
      );
      const results: ModelRunResult[] = settled.map((s, i) => {
        const model = selectedModels[i];
        if (s.status === "fulfilled") return s.value;
        return { model, error: s.reason instanceof Error ? s.reason.message : "Failed" };
      });
      setRuns(results);
      const firstOk = results.find((r) => r.data);
      setActiveModel(firstOk?.model ?? null);
      setStage("evaluated");
      const okCount = results.filter((r) => r.data).length;
      toast.success(`${okCount}/${results.length} model${results.length === 1 ? "" : "s"} finished.`);

      // Fire-and-forget rubric parsing (per-question + per-criterion)
      supabase.functions
        .invoke("parse-rubric-scores", { body: { evaluationId, rubric } })
        .then(({ data }) => {
          if (data?.criteria) setHumanCriteria(data.criteria as HumanCriterion[]);
        })
        .catch((err) => console.warn("rubric parse failed:", err));
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "Evaluation failed");
      setStage("extracted");
    }
  };

  const setPrimary = async (model: string) => {
    if (!evaluationId) return;
    const run = runs.find((r) => r.model === model);
    if (!run?.data) return;
    // Find the run row
    const { data: row } = await supabase
      .from("model_runs")
      .select("id, total_score, max_score, evaluation_json")
      .eq("evaluation_id", evaluationId)
      .eq("model", model)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (!row) return;
    await supabase.from("evaluations").update({
      primary_run_id: row.id,
      total_score: row.total_score,
      max_score: row.max_score,
      evaluation_json: row.evaluation_json,
    }).eq("id", evaluationId);
    toast.success(`${MODELS.find((m) => m.id === model)?.short ?? model} set as primary.`);
  };

  const downloadReport = () => {
    const active = runs.find((r) => r.model === activeModel)?.data;
    if (!active) return;
    const lines: string[] = [];
    lines.push(`KHATA — Evaluation Report`);
    lines.push(`Date: ${new Date().toLocaleString()}`);
    lines.push(`Model: ${MODELS.find((m) => m.id === activeModel)?.label ?? activeModel}`);
    lines.push(``);
    lines.push(`TOTAL SCORE: ${active.total_score} / ${active.max_score}`);
    lines.push(``);
    lines.push(`Overall Feedback:`);
    lines.push(active.overall_feedback);
    lines.push(``);
    lines.push(`--- Per-Question ---`);
    for (const q of active.questions) {
      lines.push(``);
      lines.push(`Q${q.question_number}: ${q.question_summary}`);
      lines.push(`Score: ${q.score_awarded}/${q.score_max}`);
      lines.push(`Feedback: ${q.feedback}`);
    }
    if (active.criterion_scores?.length) {
      lines.push(``);
      lines.push(`--- Per-Criterion ---`);
      for (const c of active.criterion_scores) {
        lines.push(`Q${c.question_number} · ${c.criterion}: ${c.awarded}/${c.max}`);
        if (c.feedback) lines.push(`  ${c.feedback}`);
      }
    }
    lines.push(``);
    lines.push(`--- Extracted Transcript ---`);
    lines.push(extracted);
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `khata-report-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const busy = stage === "uploading" || stage === "extracting" || stage === "evaluating";
  const stageLabel = useMemo(
    () => ({
      uploading: "Uploading paper…",
      extracting: "Reading handwriting…",
      evaluating: `Grading with ${selectedModels.length} model${selectedModels.length === 1 ? "" : "s"}…`,
    } as Record<string, string>)[stage],
    [stage, selectedModels.length],
  );

  const activeRun = runs.find((r) => r.model === activeModel);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!user) return null;

  return (
    <div className="min-h-screen bg-background">
      <TopBar onOpenHistory={() => setHistoryOpen(true)} />
      <HistorySheet open={historyOpen} onOpenChange={setHistoryOpen} onSelect={loadFromHistory} />

      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
        <div className="mb-6 flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-display text-3xl sm:text-4xl text-foreground tracking-tight">
              New evaluation
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Upload pages → Extract → Review → Evaluate with one or more models.
            </p>
          </div>
          {(files.length > 0 || extracted) && (
            <Button variant="ghost" size="sm" onClick={reset}>
              <RefreshCw className="h-4 w-4 mr-1.5" /> Start over
            </Button>
          )}
        </div>

        <div className="grid lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] gap-6">
          {/* LEFT */}
          <section className="space-y-5">
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Step 1 · Exam paper (multiple pages OK)
              </Label>
              <FileDropzone files={files} onFiles={setFiles} />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="rubric" className="text-xs uppercase tracking-wider text-muted-foreground">
                  Step 2 · Grading rubric
                </Label>
                <input
                  ref={rubricFileRef}
                  type="file"
                  accept=".xlsx,.xls,.csv,.docx,.txt,.md,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (!f) return;
                    try {
                      const text = await parseRubricFile(f);
                      if (!text.trim()) throw new Error("File appears empty.");
                      setRubric(text);
                      toast.success(`Loaded rubric from ${f.name}`);
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "Failed to read file");
                    }
                  }}
                />
                <Button
                  type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs"
                  onClick={() => rubricFileRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5 mr-1.5" /> Upload file
                </Button>
              </div>
              <Textarea
                id="rubric"
                value={rubric}
                onChange={(e) => setRubric(e.target.value)}
                placeholder={`Paste rubric or upload .xlsx / .docx / .txt\n\ne.g.\nQ1 (10): Definition (5), Example (3), Diagram (2). Awarded: 8\nQ2 (15): ...\nTotal: 100`}
                className="min-h-[160px] font-mono text-sm bg-card"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Step 3 · Models
              </Label>
              <div className="flex flex-wrap gap-2">
                {MODELS.map((m) => {
                  const on = selectedModels.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() =>
                        setSelectedModels((s) => (on ? s.filter((x) => x !== m.id) : [...s, m.id]))
                      }
                      className={
                        "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors " +
                        (on
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-card text-muted-foreground border-border hover:border-foreground/30")
                      }
                    >
                      {on && <Check className="inline h-3 w-3 mr-1 -mt-0.5" />}
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Button
                onClick={onExtract}
                disabled={files.length === 0 || busy}
                size="lg"
                className="w-full"
              >
                {stage === "uploading" || stage === "extracting" ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {stageLabel}</>
                ) : (
                  <><Sparkles className="h-4 w-4 mr-2" /> Extract Text</>
                )}
              </Button>
              <Button
                onClick={onEvaluate}
                disabled={!extracted || !rubric.trim() || busy || selectedModels.length === 0}
                variant="secondary"
                size="lg"
                className="w-full"
              >
                {stage === "evaluating" ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {stageLabel}</>
                ) : (
                  <><Wand2 className="h-4 w-4 mr-2" /> Evaluate with {selectedModels.length} model{selectedModels.length === 1 ? "" : "s"}</>
                )}
              </Button>
            </div>
          </section>

          {/* RIGHT */}
          <section className="space-y-5">
            {/* Extracted */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <h2 className="font-display text-lg text-foreground">Extracted text</h2>
                  {confidence != null && (
                    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                      Confidence {Math.round(confidence * 100)}%
                    </span>
                  )}
                </div>
                {extracted && (
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => { navigator.clipboard.writeText(extracted); toast.success("Copied"); }}
                  >
                    Copy
                  </Button>
                )}
              </div>
              <div className="p-5 min-h-[260px]">
                {!extracted && stage === "idle" && <EmptyState />}
                {(stage === "uploading" || stage === "extracting") && (
                  <SkeletonBlock label={stageLabel ?? "Processing…"} />
                )}
                {extracted && (
                  <Textarea
                    value={extracted}
                    onChange={(e) => setExtracted(e.target.value)}
                    className="prose-extract min-h-[240px] resize-y border-0 bg-transparent p-0 focus-visible:ring-0 shadow-none"
                  />
                )}
              </div>
            </div>

            {/* Grading: model tabs + active result */}
            {(runs.length > 0 || stage === "evaluating") && (
              <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Wand2 className="h-4 w-4 text-accent" />
                    <h2 className="font-display text-lg text-foreground">Evaluation</h2>
                    <div className="flex flex-wrap gap-1 ml-2">
                      {runs.map((r) => {
                        const meta = MODELS.find((m) => m.id === r.model);
                        const isActive = r.model === activeModel;
                        const failed = !!r.error;
                        const pending = !r.data && !r.error && stage === "evaluating";
                        return (
                          <button
                            key={r.model}
                            disabled={!r.data}
                            onClick={() => setActiveModel(r.model)}
                            className={
                              "px-2.5 py-1 rounded-md text-xs border transition-colors flex items-center gap-1.5 " +
                              (isActive
                                ? "bg-primary text-primary-foreground border-primary"
                                : failed
                                ? "bg-destructive/10 text-destructive border-destructive/30"
                                : "bg-card text-muted-foreground border-border hover:border-foreground/30")
                            }
                          >
                            {pending && <Loader2 className="h-3 w-3 animate-spin" />}
                            {meta?.short ?? r.model}
                            {r.data && <span className="opacity-70">· {r.data.total_score}/{r.data.max_score}</span>}
                            {failed && <span>· failed</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {activeRun?.data && (
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setPrimary(activeRun.model)}>
                        <Check className="h-4 w-4 mr-1.5" /> Set as primary
                      </Button>
                      <Button variant="ghost" size="sm" onClick={downloadReport}>
                        <Download className="h-4 w-4 mr-1.5" /> Report
                      </Button>
                    </div>
                  )}
                </div>
                <div className="p-5">
                  {stage === "evaluating" && !activeRun?.data && (
                    <SkeletonBlock label="Grading against rubric…" />
                  )}
                  {activeRun?.data && (
                    <GradingResults data={activeRun.data} humanCriteria={humanCriteria} />
                  )}
                  {activeRun?.error && (
                    <p className="text-sm text-destructive">
                      This model failed: {activeRun.error}
                    </p>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-10">
      <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
        <Sparkles className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="font-display text-lg text-foreground">Ready when you are</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
        Drop one or more pages on the left and tap{" "}
        <span className="font-medium text-foreground">Extract Text</span>.
        Bangla and English handwriting are both supported.
      </p>
    </div>
  );
}

function SkeletonBlock({ label }: { label: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {label}
      </div>
      <div className="space-y-2">
        <div className="h-3 rounded bg-muted animate-pulse w-3/4" />
        <div className="h-3 rounded bg-muted animate-pulse w-full" />
        <div className="h-3 rounded bg-muted animate-pulse w-5/6" />
        <div className="h-3 rounded bg-muted animate-pulse w-2/3" />
      </div>
    </div>
  );
}
