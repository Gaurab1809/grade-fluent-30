import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, LineChart, Line, BarChart, Bar, Legend,
} from "recharts";
import { Loader2, RefreshCw, Download, BarChart3, ArrowLeft } from "lucide-react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

export const Route = createFileRoute("/metrics")({
  component: MetricsPage,
});

type Metrics = {
  n: number;
  passThreshold: number;
  regression: { pearson: number; spearman: number; mae: number; rmse: number; r2: number; meanDiff: number; sdDiff: number };
  classification: {
    accuracy: number; macroF1: number; kappa: number;
    labels: string[];
    matrix: Record<string, Record<string, number>>;
    perClass: Record<string, { precision: number; recall: number; f1: number; support: number }>;
  };
  roc: { points: { fpr: number; tpr: number; threshold: number }[]; auc: number };
  perQuestion: { question: string; n: number; mae: number; pearson: number }[];
  pairs: { id: string; title: string; ai: number; human: number }[];
};

function fmt(n: number, d = 3) {
  if (!isFinite(n) || isNaN(n)) return "—";
  return n.toFixed(d);
}

function MetricsPage() {
  const { user, loading } = useAuth();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [pass, setPass] = useState(50);
  const [missingCount, setMissingCount] = useState(0);
  const reportRef = useRef<HTMLDivElement | null>(null);

  const load = async (passVal = pass) => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("compute-metrics", {
        body: {},
        // pass threshold via query string isn't supported by invoke; encode in body and rebuild URL? Use direct fetch instead.
      });
      // Fallback to fetch with query string for threshold
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/compute-metrics?pass=${passVal}`;
      const session = (await supabase.auth.getSession()).data.session;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ""}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setMetrics(json);
      void data; void error;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load metrics");
    } finally {
      setBusy(false);
    }
  };

  const checkMissing = async () => {
    if (!user) return;
    const { count } = await supabase
      .from("evaluations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "evaluated")
      .is("human_total", null)
      .not("rubric", "is", null);
    setMissingCount(count ?? 0);
  };

  const backfill = async () => {
    if (!user) return;
    setBackfilling(true);
    try {
      const { data: rows, error } = await supabase
        .from("evaluations")
        .select("id, rubric")
        .eq("user_id", user.id)
        .eq("status", "evaluated")
        .is("human_total", null)
        .not("rubric", "is", null);
      if (error) throw error;
      const list = rows ?? [];
      let ok = 0, fail = 0;
      for (const r of list) {
        try {
          const { data, error: e } = await supabase.functions.invoke("parse-rubric-scores", {
            body: { evaluationId: r.id, rubric: r.rubric },
          });
          if (e || data?.error) fail++; else ok++;
        } catch { fail++; }
      }
      toast.success(`Backfill done: ${ok} parsed, ${fail} failed`);
      await checkMissing();
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Backfill failed");
    } finally {
      setBackfilling(false);
    }
  };

  useEffect(() => {
    if (user) { void load(); void checkMissing(); }
  }, [user]);

  const scatterData = useMemo(() => metrics?.pairs.map(p => ({ x: p.human, y: p.ai, name: p.title })) ?? [], [metrics]);
  const blandData = useMemo(() => metrics?.pairs.map(p => ({
    x: (p.ai + p.human) / 2,
    y: p.ai - p.human,
    name: p.title,
  })) ?? [], [metrics]);

  const downloadPDF = async () => {
    if (!reportRef.current) return;
    toast.info("Building PDF…");
    const canvas = await html2canvas(reportRef.current, {
      backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
      scale: 2,
    });
    const img = canvas.toDataURL("image/png");
    const pdf = new jsPDF({ orientation: "p", unit: "pt", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const ratio = canvas.width / canvas.height;
    const imgW = pageW - 40;
    const imgH = imgW / ratio;
    let y = 20;
    if (imgH < pageH - 40) {
      pdf.addImage(img, "PNG", 20, y, imgW, imgH);
    } else {
      // Slice across pages
      const pageImgH = pageH - 40;
      const pageCanvasH = (canvas.width * pageImgH) / imgW;
      let sY = 0;
      while (sY < canvas.height) {
        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = Math.min(pageCanvasH, canvas.height - sY);
        const ctx = slice.getContext("2d")!;
        ctx.drawImage(canvas, 0, sY, canvas.width, slice.height, 0, 0, canvas.width, slice.height);
        const sImg = slice.toDataURL("image/png");
        const sH = (slice.height * imgW) / canvas.width;
        if (sY > 0) pdf.addPage();
        pdf.addImage(sImg, "PNG", 20, 20, imgW, sH);
        sY += slice.height;
      }
    }
    pdf.save(`khata-metrics-${Date.now()}.pdf`);
  };

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="min-h-screen bg-background">
      <TopBar />
      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
        <div className="flex items-end justify-between gap-4 flex-wrap mb-6">
          <div>
            <Link to="/" className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground">
              <ArrowLeft className="h-3 w-3" /> Back to workspace
            </Link>
            <h1 className="font-display text-3xl sm:text-4xl text-foreground tracking-tight mt-1">
              <BarChart3 className="inline h-7 w-7 mr-2 text-accent" />
              Evaluation metrics
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              AI-graded vs teacher-graded scores across {metrics?.n ?? "—"} papers.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {missingCount > 0 && (
              <Button onClick={backfill} disabled={backfilling} variant="secondary" size="sm">
                {backfilling ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1.5" />}
                Parse {missingCount} rubric{missingCount === 1 ? "" : "s"}
              </Button>
            )}
            <Button onClick={() => load()} disabled={busy} variant="ghost" size="sm">
              {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1.5" />}
              Refresh
            </Button>
            <Button onClick={downloadPDF} disabled={!metrics || metrics.n === 0} size="sm">
              <Download className="h-4 w-4 mr-1.5" /> Download PDF
            </Button>
          </div>
        </div>

        {!metrics ? (
          <div className="rounded-2xl border border-border bg-card p-10 text-center">
            <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
          </div>
        ) : metrics.n === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-10 text-center">
            <p className="font-display text-lg">No graded papers with parsed rubric scores yet</p>
            <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
              Evaluate at least one paper whose rubric contains the teacher's awarded marks
              (e.g. "Q1: 8/10, Q2: 7/10, Total: 72/100"). Then come back here.
            </p>
            {missingCount > 0 && (
              <Button onClick={backfill} disabled={backfilling} className="mt-4">
                {backfilling ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
                Parse {missingCount} existing rubric{missingCount === 1 ? "" : "s"}
              </Button>
            )}
          </div>
        ) : (
          <div ref={reportRef} className="space-y-6 bg-background p-2">
            {/* Stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Sample size" value={String(metrics.n)} />
              <Stat label="Pearson r" value={fmt(metrics.regression.pearson)} hint="AI vs human (%)" />
              <Stat label="Spearman ρ" value={fmt(metrics.regression.spearman)} />
              <Stat label="R²" value={fmt(metrics.regression.r2)} />
              <Stat label="MAE" value={`${fmt(metrics.regression.mae, 2)} pts`} hint="mean abs error %" />
              <Stat label="RMSE" value={`${fmt(metrics.regression.rmse, 2)} pts`} />
              <Stat label="Bucket accuracy" value={`${fmt(metrics.classification.accuracy * 100, 1)}%`} hint="A/B/C/D/F" />
              <Stat label="Macro F1" value={fmt(metrics.classification.macroF1)} />
              <Stat label="Cohen's κ" value={fmt(metrics.classification.kappa)} />
              <Stat label="ROC AUC" value={fmt(metrics.roc.auc)} hint={`pass ≥ ${metrics.passThreshold}%`} />
              <Stat label="Mean bias" value={`${fmt(metrics.regression.meanDiff, 2)} pts`} hint="AI − human" />
              <Stat label="SD of diff" value={`${fmt(metrics.regression.sdDiff, 2)} pts`} />
            </div>

            {/* Scatter AI vs Human */}
            <Card title="AI vs human total score (%)">
              <ResponsiveContainer width="100%" height={340}>
                <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis type="number" dataKey="x" name="Human %" domain={[0, 100]} label={{ value: "Human score (%)", position: "bottom", offset: 10 }} />
                  <YAxis type="number" dataKey="y" name="AI %" domain={[0, 100]} label={{ value: "AI score (%)", angle: -90, position: "left" }} />
                  <ZAxis range={[60, 60]} />
                  <Tooltip cursor={{ strokeDasharray: "3 3" }} formatter={(v: any) => fmt(Number(v), 1) + "%"} />
                  <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" />
                  <Scatter data={scatterData} fill="hsl(var(--primary))" />
                </ScatterChart>
              </ResponsiveContainer>
            </Card>

            {/* ROC + Bland-Altman */}
            <div className="grid md:grid-cols-2 gap-6">
              <Card title={`ROC curve · pass threshold ${metrics.passThreshold}%`}>
                <div className="flex items-center gap-2 mb-2 text-xs">
                  <Label htmlFor="pass" className="text-muted-foreground">Pass threshold (%)</Label>
                  <Input id="pass" type="number" value={pass} min={0} max={100}
                    onChange={(e) => setPass(Number(e.target.value))}
                    onBlur={() => load(pass)} className="h-7 w-20" />
                </div>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={metrics.roc.points} margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis type="number" dataKey="fpr" domain={[0, 1]} label={{ value: "False positive rate", position: "bottom", offset: 10 }} />
                    <YAxis type="number" dataKey="tpr" domain={[0, 1]} label={{ value: "True positive rate", angle: -90, position: "left" }} />
                    <Tooltip formatter={(v: any) => fmt(Number(v), 3)} />
                    <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="tpr" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
                <p className="text-xs text-muted-foreground text-center mt-1">AUC = {fmt(metrics.roc.auc)}</p>
              </Card>

              <Card title="Bland–Altman plot (agreement)">
                <ResponsiveContainer width="100%" height={340}>
                  <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis type="number" dataKey="x" name="Mean" domain={[0, 100]} label={{ value: "Mean of AI & human (%)", position: "bottom", offset: 10 }} />
                    <YAxis type="number" dataKey="y" name="Diff" label={{ value: "AI − human (pts)", angle: -90, position: "left" }} />
                    <Tooltip formatter={(v: any) => fmt(Number(v), 2)} />
                    <ReferenceLine y={metrics.regression.meanDiff} stroke="hsl(var(--accent))" strokeDasharray="3 3" label={{ value: "bias", position: "right", fontSize: 10 }} />
                    <ReferenceLine y={metrics.regression.meanDiff + 1.96 * metrics.regression.sdDiff} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 4" />
                    <ReferenceLine y={metrics.regression.meanDiff - 1.96 * metrics.regression.sdDiff} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 4" />
                    <Scatter data={blandData} fill="hsl(var(--primary))" />
                  </ScatterChart>
                </ResponsiveContainer>
              </Card>
            </div>

            {/* Confusion matrix */}
            <Card title="Confusion matrix · grade buckets (rows = human, cols = AI)">
              <div className="overflow-x-auto">
                <table className="text-sm w-full max-w-md mx-auto">
                  <thead>
                    <tr>
                      <th className="p-2"></th>
                      {metrics.classification.labels.map(l => (
                        <th key={l} className="p-2 text-xs font-medium text-muted-foreground">AI {l}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.classification.labels.map(h => {
                      const max = Math.max(...metrics.classification.labels.map(a => metrics.classification.matrix[h][a]));
                      return (
                        <tr key={h}>
                          <td className="p-2 text-xs font-medium text-muted-foreground">Human {h}</td>
                          {metrics.classification.labels.map(a => {
                            const v = metrics.classification.matrix[h][a];
                            const intensity = max ? v / max : 0;
                            const isDiag = h === a;
                            return (
                              <td key={a} className="p-1">
                                <div
                                  className="aspect-square flex items-center justify-center rounded text-sm font-medium"
                                  style={{
                                    background: isDiag
                                      ? `color-mix(in oklab, hsl(var(--primary)) ${intensity * 70 + 10}%, transparent)`
                                      : `color-mix(in oklab, hsl(var(--destructive)) ${intensity * 50}%, transparent)`,
                                    color: intensity > 0.5 ? "white" : undefined,
                                  }}
                                >
                                  {v}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="text-xs w-full">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="p-2 text-left">Grade</th>
                      <th className="p-2 text-right">Precision</th>
                      <th className="p-2 text-right">Recall</th>
                      <th className="p-2 text-right">F1</th>
                      <th className="p-2 text-right">Support</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.classification.labels.map(l => {
                      const c = metrics.classification.perClass[l];
                      return (
                        <tr key={l} className="border-b border-border/50">
                          <td className="p-2 font-medium">{l}</td>
                          <td className="p-2 text-right">{fmt(c.precision)}</td>
                          <td className="p-2 text-right">{fmt(c.recall)}</td>
                          <td className="p-2 text-right">{fmt(c.f1)}</td>
                          <td className="p-2 text-right">{c.support}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Per-question */}
            {metrics.perQuestion.length > 0 && (
              <Card title="Per-question MAE">
                <ResponsiveContainer width="100%" height={Math.max(220, metrics.perQuestion.length * 28)}>
                  <BarChart data={metrics.perQuestion} layout="vertical" margin={{ top: 10, right: 20, bottom: 10, left: 30 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis type="number" label={{ value: "MAE (% points)", position: "bottom", offset: -2 }} />
                    <YAxis type="category" dataKey="question" width={50} />
                    <Tooltip formatter={(v: any) => fmt(Number(v), 2) + " pts"} />
                    <Legend />
                    <Bar dataKey="mae" name="Mean abs error" fill="hsl(var(--primary))" />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            )}

            <p className="text-[10px] text-muted-foreground text-center pt-2">
              Generated {new Date().toLocaleString()} · n={metrics.n} papers · pass≥{metrics.passThreshold}% ·
              Buckets: A≥80, B≥70, C≥60, D≥50, F&lt;50
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="font-display text-2xl text-foreground mt-1">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <h3 className="font-display text-lg text-foreground mb-3">{title}</h3>
      {children}
    </div>
  );
}
