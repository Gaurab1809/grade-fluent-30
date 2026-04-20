import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { TopBar } from "@/components/TopBar";
import { FileDropzone } from "@/components/FileDropzone";
import { GradingResults, type EvaluationData } from "@/components/GradingResults";
import { HistorySheet } from "@/components/HistorySheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Sparkles, Wand2, Loader2, Download, FileText, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Workspace,
});

type Stage = "idle" | "uploading" | "extracting" | "extracted" | "evaluating" | "evaluated";

function Workspace() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [evaluationId, setEvaluationId] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<string>("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [rubric, setRubric] = useState<string>("");
  const [evalData, setEvalData] = useState<EvaluationData | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [user, loading, navigate]);

  useEffect(() => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    if (file) {
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      setPreviewUrl(url);
    } else {
      setPreviewUrl(null);
    }
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, [file]);

  const reset = () => {
    setFile(null);
    setEvaluationId(null);
    setExtracted("");
    setConfidence(null);
    setEvalData(null);
    setStage("idle");
  };

  const loadFromHistory = async (id: string) => {
    const { data, error } = await supabase.from("evaluations").select("*").eq("id", id).single();
    if (error || !data) return toast.error(error?.message ?? "Not found");
    setFile(null);
    setPreviewUrl(null);
    setEvaluationId(data.id);
    setExtracted(data.extracted_text ?? "");
    setConfidence(data.ocr_confidence != null ? Number(data.ocr_confidence) : null);
    setRubric(data.rubric ?? "");
    setEvalData((data.evaluation_json as EvaluationData | null) ?? null);
    setStage(data.evaluation_json ? "evaluated" : data.extracted_text ? "extracted" : "idle");
  };

  const onExtract = async () => {
    if (!file || !user) return;
    setStage("uploading");
    try {
      const ext = file.name.split(".").pop() || "bin";
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("exam-papers").upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (upErr) throw upErr;

      const { data: ins, error: insErr } = await supabase
        .from("evaluations")
        .insert({
          user_id: user.id,
          title: file.name,
          file_path: path,
          file_mime: file.type,
          status: "uploaded",
        })
        .select()
        .single();
      if (insErr || !ins) throw insErr ?? new Error("Failed to create record");
      setEvaluationId(ins.id);

      setStage("extracting");
      const { data, error } = await supabase.functions.invoke("extract-text", {
        body: { evaluationId: ins.id, filePath: path, mimeType: file.type },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      setExtracted(data.markdown);
      setConfidence(data.confidence ?? null);
      setStage("extracted");
      toast.success("Text extracted. Edit if needed, then evaluate.");
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "Extraction failed");
      setStage("idle");
    }
  };

  const onEvaluate = async () => {
    if (!evaluationId || !extracted.trim() || !rubric.trim()) {
      toast.error("Add a rubric and extracted text first.");
      return;
    }
    setStage("evaluating");
    try {
      const { data, error } = await supabase.functions.invoke("evaluate-paper", {
        body: { evaluationId, extractedText: extracted, rubric },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setEvalData(data as EvaluationData);
      setStage("evaluated");
      toast.success("Evaluation complete.");
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "Evaluation failed");
      setStage("extracted");
    }
  };

  const downloadReport = () => {
    if (!evalData) return;
    const lines: string[] = [];
    lines.push(`KHATA — Evaluation Report`);
    lines.push(`Date: ${new Date().toLocaleString()}`);
    lines.push(``);
    lines.push(`TOTAL SCORE: ${evalData.total_score} / ${evalData.max_score}`);
    lines.push(``);
    lines.push(`Overall Feedback:`);
    lines.push(evalData.overall_feedback);
    lines.push(``);
    lines.push(`--- Per-Question ---`);
    for (const q of evalData.questions) {
      lines.push(``);
      lines.push(`Q${q.question_number}: ${q.question_summary}`);
      lines.push(`Score: ${q.score_awarded}/${q.score_max}`);
      lines.push(`Feedback: ${q.feedback}`);
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
      evaluating: "Grading against rubric…",
    } as Record<string, string>)[stage],
    [stage],
  );

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
              Upload → Extract → Review → Evaluate.
            </p>
          </div>
          {(file || extracted) && (
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
                Step 1 · Exam paper
              </Label>
              <FileDropzone file={file} previewUrl={previewUrl} onFile={setFile} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="rubric" className="text-xs uppercase tracking-wider text-muted-foreground">
                Step 2 · Grading rubric
              </Label>
              <Textarea
                id="rubric"
                value={rubric}
                onChange={(e) => setRubric(e.target.value)}
                placeholder={`e.g.\nQ1 (10): Definition of photosynthesis. Award full marks for chemical equation.\nQ2 (15): Compare prose styles of Tagore and Nazrul...\nTotal: 100`}
                className="min-h-[180px] font-mono text-sm bg-card"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Button
                onClick={onExtract}
                disabled={!file || busy}
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
                disabled={!extracted || !rubric.trim() || busy}
                variant="secondary"
                size="lg"
                className="w-full"
              >
                {stage === "evaluating" ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Grading…</>
                ) : (
                  <><Wand2 className="h-4 w-4 mr-2" /> Evaluate with Rubric</>
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
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(extracted);
                      toast.success("Copied");
                    }}
                  >
                    Copy
                  </Button>
                )}
              </div>
              <div className="p-5 min-h-[280px]">
                {!extracted && stage === "idle" && (
                  <EmptyState />
                )}
                {(stage === "uploading" || stage === "extracting") && (
                  <SkeletonBlock label={stageLabel ?? "Processing…"} />
                )}
                {extracted && (
                  <Textarea
                    value={extracted}
                    onChange={(e) => setExtracted(e.target.value)}
                    className="prose-extract min-h-[260px] resize-y border-0 bg-transparent p-0 focus-visible:ring-0 shadow-none"
                  />
                )}
              </div>
            </div>

            {/* Grading */}
            {(evalData || stage === "evaluating") && (
              <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
                  <div className="flex items-center gap-2">
                    <Wand2 className="h-4 w-4 text-accent" />
                    <h2 className="font-display text-lg text-foreground">Evaluation</h2>
                  </div>
                  {evalData && (
                    <Button variant="ghost" size="sm" onClick={downloadReport}>
                      <Download className="h-4 w-4 mr-1.5" /> Report
                    </Button>
                  )}
                </div>
                <div className="p-5">
                  {stage === "evaluating" && !evalData && (
                    <SkeletonBlock label="Grading against rubric…" />
                  )}
                  {evalData && <GradingResults data={evalData} />}
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
        Drop a paper on the left and tap <span className="font-medium text-foreground">Extract Text</span>.
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
