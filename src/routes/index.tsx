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
  Sparkles, Wand2, Loader2, Download, FileText, RefreshCw, Upload, Check, Files,
} from "lucide-react";
import * as XLSX from "xlsx";
import mammoth from "mammoth";

// ---------- Models & Prompt Variants ----------
type ModelOption = { id: string; label: string; short: string };
const MODELS: ModelOption[] = [
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", short: "Gemini" },
  { id: "openai/gpt-5-mini",       label: "GPT-5 Mini",       short: "GPT-5" },
];
type VariantOption = { id: string; label: string; hint: string };
const VARIANTS: VariantOption[] = [
  { id: "baseline", label: "Baseline",  hint: "Default fair grading" },
  { id: "strict",   label: "Strict",    hint: "Penalize gaps, no rounding up" },
  { id: "lenient",  label: "Lenient",   hint: "Reward partial understanding" },
  { id: "few-shot", label: "Few-shot",  hint: "Calibrate using train-split examples" },
];
type Split = "unassigned" | "train" | "val" | "test";
const SPLITS: { id: Split; label: string }[] = [
  { id: "unassigned", label: "—" },
  { id: "train", label: "Train" },
  { id: "val",   label: "Val" },
  { id: "test",  label: "Test" },
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

type Stage = "idle" | "extracting" | "extracted" | "evaluating" | "evaluated";
type UploadMode = "single" | "separate";

type ModelRunResult = {
  model: string;
  data?: EvaluationData;
  error?: string;
  latency_ms?: number;
};

type Paper = {
  // Local id only — for keys
  localId: string;
  title: string;
  files: File[];
  evaluationId: string | null;
  extracted: string;
  confidence: number | null;
  runs: ModelRunResult[];
  activeModel: string | null;
  stage: Stage;
  split: Split;
};

function newPaper(files: File[], title?: string): Paper {
  return {
    localId: crypto.randomUUID(),
    title: title ?? (files[0]?.name ?? "Untitled paper"),
    files,
    evaluationId: null,
    extracted: "",
    confidence: null,
    runs: [],
    activeModel: null,
    stage: "idle",
    split: "unassigned",
  };
}

function Workspace() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  const [uploadMode, setUploadMode] = useState<UploadMode>("single");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]); // staging area in dropzone
  const [papers, setPapers] = useState<Paper[]>([]);
  const [activePaperIdx, setActivePaperIdx] = useState(0);

  const [rubric, setRubric] = useState<string>("");
  const [selectedModels, setSelectedModels] = useState<string[]>(MODELS.map((m) => m.id));
  const [promptVariant, setPromptVariant] = useState<string>("baseline");
  const [humanCriteria, setHumanCriteria] = useState<HumanCriterion[] | undefined>(undefined);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const rubricFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [user, loading, navigate]);

  // Materialise pendingFiles -> papers whenever the user adds/removes files or switches mode.
  // Guarded against infinite loops by reading `papers` via a ref.
  const papersRef = useRef(papers);
  papersRef.current = papers;
  useEffect(() => {
    if (papersRef.current.some((p) => p.evaluationId)) return; // don't disturb after extraction
    if (pendingFiles.length === 0) {
      setPapers([]);
      setActivePaperIdx(0);
      return;
    }
    if (uploadMode === "single") {
      setPapers([
        newPaper(
          pendingFiles,
          pendingFiles.length === 1
            ? pendingFiles[0].name
            : `${pendingFiles[0].name} (+${pendingFiles.length - 1} more)`,
        ),
      ]);
    } else {
      setPapers(pendingFiles.map((f) => newPaper([f], f.name)));
    }
    setActivePaperIdx(0);
  }, [pendingFiles, uploadMode]);

  const updatePaper = (idx: number, patch: Partial<Paper>) => {
    setPapers((ps) => ps.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const reset = () => {
    setPendingFiles([]);
    setPapers([]);
    setActivePaperIdx(0);
    setHumanCriteria(undefined);
  };

  const loadFromHistory = async (id: string) => {
    const { data, error } = await supabase.from("evaluations").select("*").eq("id", id).single();
    if (error || !data) return toast.error(error?.message ?? "Not found");

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

    const restored: Paper = {
      localId: crypto.randomUUID(),
      title: data.title ?? "Untitled paper",
      files: [],
      evaluationId: data.id,
      extracted: data.extracted_text ?? "",
      confidence: data.ocr_confidence != null ? Number(data.ocr_confidence) : null,
      runs: loaded,
      activeModel: loaded.find((r) => r.data)?.model ?? null,
      stage: loaded.length ? "evaluated" : data.extracted_text ? "extracted" : "idle",
      split: ((data.split as Split) ?? "unassigned"),
    };
    setPapers([restored]);
    setActivePaperIdx(0);
    setRubric(data.rubric ?? "");
    setHumanCriteria((data.criterion_scores_human as HumanCriterion[] | null) ?? undefined);
    setPendingFiles([]);
  };

  // Extract one paper. Returns true on success.
  const extractPaper = async (idx: number): Promise<boolean> => {
    const paper = papers[idx];
    if (!paper || !user || paper.files.length === 0) return false;
    updatePaper(idx, { stage: "extracting" });
    try {
      // Upload files
      const uploaded: { path: string; mime: string; name: string }[] = [];
      for (const f of paper.files) {
        const ext = f.name.split(".").pop() || "bin";
        const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage.from("exam-papers").upload(path, f, {
          contentType: f.type, upsert: false,
        });
        if (upErr) throw upErr;
        uploaded.push({ path, mime: f.type, name: f.name });
      }

      const { data: ins, error: insErr } = await supabase
        .from("evaluations")
        .insert({
          user_id: user.id,
          title: paper.title,
          file_path: uploaded[0].path,
          file_mime: uploaded[0].mime,
          paper_files: uploaded,
          status: "uploaded",
        })
        .select()
        .single();
      if (insErr || !ins) throw insErr ?? new Error("Failed to create record");

      const { data, error } = await supabase.functions.invoke("extract-text", {
        body: { evaluationId: ins.id, files: uploaded },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      updatePaper(idx, {
        evaluationId: ins.id,
        extracted: data.markdown,
        confidence: data.confidence ?? null,
        stage: "extracted",
      });
      return true;
    } catch (e) {
      console.error(e);
      toast.error(`${paper.title}: ${e instanceof Error ? e.message : "Extraction failed"}`);
      updatePaper(idx, { stage: "idle" });
      return false;
    }
  };

  const evaluatePaper = async (idx: number): Promise<boolean> => {
    const paper = papers[idx];
    if (!paper?.evaluationId || !paper.extracted.trim() || !rubric.trim() || selectedModels.length === 0) {
      return false;
    }
    updatePaper(idx, {
      stage: "evaluating",
      runs: selectedModels.map((m) => ({ model: m })),
      activeModel: null,
    });
    try {
      const settled = await Promise.allSettled(
        selectedModels.map(async (model) => {
          const { data, error } = await supabase.functions.invoke("evaluate-paper", {
            body: {
              evaluationId: paper.evaluationId,
              extractedText: paper.extracted,
              rubric,
              model,
              promptVariant,
            },
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
      const firstOk = results.find((r) => r.data);
      updatePaper(idx, { runs: results, activeModel: firstOk?.model ?? null, stage: "evaluated" });

      // Fire-and-forget rubric parsing once
      if (!humanCriteria) {
        supabase.functions
          .invoke("parse-rubric-scores", { body: { evaluationId: paper.evaluationId, rubric } })
          .then(({ data }) => {
            if (data?.criteria) setHumanCriteria(data.criteria as HumanCriterion[]);
          })
          .catch((err) => console.warn("rubric parse failed:", err));
      }
      return true;
    } catch (e) {
      console.error(e);
      toast.error(`${paper.title}: ${e instanceof Error ? e.message : "Evaluation failed"}`);
      updatePaper(idx, { stage: "extracted" });
      return false;
    }
  };

  const onExtractAll = async () => {
    if (papers.length === 0) return;
    setBatchBusy(true);
    let ok = 0;
    for (let i = 0; i < papers.length; i++) {
      if (papers[i].stage !== "idle") continue;
      const success = await extractPaper(i);
      if (success) ok++;
      setActivePaperIdx(i);
    }
    setBatchBusy(false);
    if (ok > 0) toast.success(`Transcribed ${ok}/${papers.length} paper${papers.length === 1 ? "" : "s"}.`);
  };

  const onEvaluateAll = async () => {
    if (!rubric.trim()) {
      toast.error("Add a rubric first.");
      return;
    }
    setBatchBusy(true);
    let ok = 0;
    let total = 0;
    for (let i = 0; i < papers.length; i++) {
      if (!papers[i].evaluationId || !papers[i].extracted) continue;
      total++;
      const success = await evaluatePaper(i);
      if (success) ok++;
      setActivePaperIdx(i);
    }
    setBatchBusy(false);
    if (total > 0) toast.success(`Graded ${ok}/${total} paper${total === 1 ? "" : "s"}.`);
  };

  const setPrimary = async (idx: number, model: string) => {
    const paper = papers[idx];
    if (!paper?.evaluationId) return;
    const run = paper.runs.find((r) => r.model === model);
    if (!run?.data) return;
    const { data: row } = await supabase
      .from("model_runs")
      .select("id, total_score, max_score, evaluation_json")
      .eq("evaluation_id", paper.evaluationId)
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
    }).eq("id", paper.evaluationId);
    toast.success(`${MODELS.find((m) => m.id === model)?.short ?? model} set as primary.`);
  };

  const setPaperSplit = async (idx: number, split: Split) => {
    const paper = papers[idx];
    updatePaper(idx, { split });
    if (!paper?.evaluationId) return;
    const { error } = await supabase.from("evaluations").update({ split }).eq("id", paper.evaluationId);
    if (error) toast.error(error.message);
  };
    const paper = papers[idx];
    const active = paper?.runs.find((r) => r.model === paper.activeModel)?.data;
    if (!active || !paper) return;
    const lines: string[] = [];
    lines.push(`KHATA — Evaluation Report`);
    lines.push(`Paper: ${paper.title}`);
    lines.push(`Date: ${new Date().toLocaleString()}`);
    lines.push(`Model: ${MODELS.find((m) => m.id === paper.activeModel)?.label ?? paper.activeModel}`);
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
    lines.push(paper.extracted);
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `khata-${paper.title.replace(/[^\w]+/g, "_")}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const activePaper = papers[activePaperIdx];
  const anyBusy = batchBusy || papers.some((p) => p.stage === "extracting" || p.stage === "evaluating");
  const anyExtracted = papers.some((p) => p.extracted);
  const allIdle = papers.length > 0 && papers.every((p) => p.stage === "idle");
  const allExtracted = papers.length > 0 && papers.every((p) => p.extracted);

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
          {(pendingFiles.length > 0 || papers.length > 0) && (
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
                Step 1 · Exam papers
              </Label>

              {/* Mode toggle */}
              <div className="grid grid-cols-2 rounded-lg border border-border bg-card p-1 text-xs">
                <button
                  type="button"
                  disabled={papers.some((p) => p.evaluationId)}
                  onClick={() => setUploadMode("single")}
                  className={
                    "flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md transition-colors " +
                    (uploadMode === "single"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  <FileText className="h-3.5 w-3.5" /> One paper, many pages
                </button>
                <button
                  type="button"
                  disabled={papers.some((p) => p.evaluationId)}
                  onClick={() => setUploadMode("separate")}
                  className={
                    "flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md transition-colors " +
                    (uploadMode === "separate"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  <Files className="h-3.5 w-3.5" /> Separate papers
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {uploadMode === "single"
                  ? "All files belong to the same student paper and will be combined."
                  : "Each file is a different student's paper, evaluated independently."}
              </p>

              <FileDropzone files={pendingFiles} onFiles={setPendingFiles} />
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
                onClick={onExtractAll}
                disabled={papers.length === 0 || !allIdle || anyBusy}
                size="lg"
                className="w-full"
              >
                {anyBusy && papers.some((p) => p.stage === "extracting") ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Reading handwriting…</>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-2" />
                    Extract Text{papers.length > 1 ? ` (${papers.length} papers)` : ""}
                  </>
                )}
              </Button>
              <Button
                onClick={onEvaluateAll}
                disabled={!anyExtracted || !rubric.trim() || anyBusy || selectedModels.length === 0}
                variant="secondary"
                size="lg"
                className="w-full"
              >
                {anyBusy && papers.some((p) => p.stage === "evaluating") ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Grading…</>
                ) : (
                  <>
                    <Wand2 className="h-4 w-4 mr-2" />
                    Evaluate{papers.length > 1 ? ` ${papers.length} papers` : ""} · {selectedModels.length} model{selectedModels.length === 1 ? "" : "s"}
                  </>
                )}
              </Button>
              {papers.length > 1 && allExtracted && !anyBusy && (
                <p className="text-[11px] text-muted-foreground text-center">
                  Each paper is graded independently against the same rubric.
                </p>
              )}
            </div>
          </section>

          {/* RIGHT */}
          <section className="space-y-5">
            {/* Paper picker (only when multiple papers) */}
            {papers.length > 1 && (
              <div className="rounded-2xl border border-border bg-card p-2">
                <div className="flex items-center gap-1.5 overflow-x-auto">
                  {papers.map((p, i) => {
                    const isActive = i === activePaperIdx;
                    const primary = p.runs.find((r) => r.model === p.activeModel)?.data;
                    return (
                      <button
                        key={p.localId}
                        onClick={() => setActivePaperIdx(i)}
                        className={
                          "shrink-0 px-3 py-1.5 rounded-md text-xs border transition-colors flex items-center gap-1.5 " +
                          (isActive
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-card text-muted-foreground border-border hover:border-foreground/30")
                        }
                      >
                        {p.stage === "extracting" || p.stage === "evaluating" ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <FileText className="h-3 w-3" />
                        )}
                        <span className="max-w-[140px] truncate">{p.title}</span>
                        {primary && (
                          <span className="opacity-70 tabular-nums">
                            · {primary.total_score}/{primary.max_score}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {!activePaper && (
              <div className="rounded-2xl border border-border bg-card p-10">
                <EmptyState />
              </div>
            )}

            {activePaper && (
              <>
                {/* Extracted */}
                <div className="rounded-2xl border border-border bg-card overflow-hidden">
                  <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <h2 className="font-display text-lg text-foreground truncate">
                        {activePaper.title}
                      </h2>
                      {activePaper.confidence != null && (
                        <span className="ml-1 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">
                          {Math.round(activePaper.confidence * 100)}%
                        </span>
                      )}
                    </div>
                    {activePaper.extracted && (
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => { navigator.clipboard.writeText(activePaper.extracted); toast.success("Copied"); }}
                      >
                        Copy
                      </Button>
                    )}
                  </div>
                  <div className="p-5 min-h-[200px]">
                    {!activePaper.extracted && activePaper.stage === "idle" && <EmptyState />}
                    {(activePaper.stage === "extracting") && (
                      <SkeletonBlock label="Reading handwriting…" />
                    )}
                    {activePaper.extracted && (
                      <Textarea
                        value={activePaper.extracted}
                        onChange={(e) => updatePaper(activePaperIdx, { extracted: e.target.value })}
                        className="prose-extract min-h-[200px] resize-y border-0 bg-transparent p-0 focus-visible:ring-0 shadow-none"
                      />
                    )}
                  </div>
                </div>

                {/* Grading */}
                {(activePaper.runs.length > 0 || activePaper.stage === "evaluating") && (
                  <div className="rounded-2xl border border-border bg-card overflow-hidden">
                    <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Wand2 className="h-4 w-4 text-accent" />
                        <h2 className="font-display text-lg text-foreground">Evaluation</h2>
                        <div className="flex flex-wrap gap-1 ml-2">
                          {activePaper.runs.map((r) => {
                            const meta = MODELS.find((m) => m.id === r.model);
                            const isActive = r.model === activePaper.activeModel;
                            const failed = !!r.error;
                            const pending = !r.data && !r.error && activePaper.stage === "evaluating";
                            return (
                              <button
                                key={r.model}
                                disabled={!r.data}
                                onClick={() => updatePaper(activePaperIdx, { activeModel: r.model })}
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
                      {activePaper.activeModel && activePaper.runs.find((r) => r.model === activePaper.activeModel)?.data && (
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="sm" onClick={() => setPrimary(activePaperIdx, activePaper.activeModel!)}>
                            <Check className="h-4 w-4 mr-1.5" /> Set as primary
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => downloadReport(activePaperIdx)}>
                            <Download className="h-4 w-4 mr-1.5" /> Report
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="p-5">
                      {activePaper.stage === "evaluating" && !activePaper.runs.find((r) => r.model === activePaper.activeModel)?.data && (
                        <SkeletonBlock label="Grading against rubric…" />
                      )}
                      {activePaper.activeModel && activePaper.runs.find((r) => r.model === activePaper.activeModel)?.data && (
                        <GradingResults
                          data={activePaper.runs.find((r) => r.model === activePaper.activeModel)!.data!}
                          humanCriteria={humanCriteria}
                        />
                      )}
                      {activePaper.activeModel && activePaper.runs.find((r) => r.model === activePaper.activeModel)?.error && (
                        <p className="text-sm text-destructive">
                          This model failed: {activePaper.runs.find((r) => r.model === activePaper.activeModel)!.error}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </>
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
        Drop one or more pages on the left, choose whether they're one paper or
        separate papers, then tap{" "}
        <span className="font-medium text-foreground">Extract Text</span>.
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
