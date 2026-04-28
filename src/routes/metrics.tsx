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
import { Loader2, RefreshCw, Download, BarChart3, ArrowLeft, Trophy, Check } from "lucide-react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

export const Route = createFileRoute("/metrics")({
  component: MetricsPage,
});

type LeaderboardRow = {
  model: string; variant: string; n: number; errors: number;
  avgLatencyMs: number | null;
  mae: number; rmse: number; pearson: number; r2: number;
  accuracy: number; macroF1: number; kappa: number; auc: number;
};

type Detail = {
  n: number;
  regression: { pearson: number; spearman: number; mae: number; rmse: number; r2: number; meanDiff: number; sdDiff: number };
  classification: {
    accuracy: number; macroF1: number; kappa: number;
    labels: string[];
    matrix: Record<string, Record<string, number>>;
    perClass: Record<string, { precision: number; recall: number; f1: number; support: number }>;
  };
  roc: { points: { fpr: number; tpr: number; threshold: number }[]; auc: number };
  pairs: { id: string; title: string; ai: number; human: number }[];
};

type Metrics = {
  passThreshold: number;
  split: string;
  leaderboard: LeaderboardRow[];
  best: { model: string; variant: string } | null;
  focus: { model: string; variant: string } | null;
  detail: Detail | null;
  counts: { evaluations: number; runs: number; groups: number };
};

function fmt(n: number, d = 3) {
  if (n == null || !isFinite(n) || isNaN(n)) return "—";
  return n.toFixed(d);
}
function modelShort(id: string) {
  if (id.includes("gemini")) return "Gemini 2.5 Flash";
  if (id.includes("gpt-5")) return "GPT-5 Mini";
  return id;
}

const SPLITS = ["all", "train", "val", "test"];

function MetricsPage() {
  const { user, loading } = useAuth();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [pass, setPass] = useState(50);
  const [split, setSplit] = useState<string>("all");
  const [focus, setFocus] = useState<{ model: string; variant: string } | null>(null);
  const reportRef = useRef<HTMLDivElement | null>(null);

  const load = async (overrides?: { pass?: number; split?: string; focus?: { model: string; variant: string } | null }) => {
    setBusy(true);
    try {
      const passVal = overrides?.pass ?? pass;
      const splitVal = overrides?.split ?? split;
      const focusVal = overrides?.focus !== undefined ? overrides.focus : focus;
      const params = new URLSearchParams({ pass: String(passVal), split: splitVal });
      if (focusVal) { params.set("model", focusVal.model); params.set("variant", focusVal.variant); }
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/compute-metrics?${params}`;
      const session = (await supabase.auth.getSession()).data.session;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${session?.access_token ?? ""}` } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setMetrics(json);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load metrics");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { if (user) void load({ split: "all", focus: null }); }, [user]);

  const detail = metrics?.detail;
  const scatterData = useMemo(() => detail?.pairs.map(p => ({ x: p.human, y: p.ai, name: p.title })) ?? [], [detail]);
  const blandData = useMemo(() => detail?.pairs.map(p => ({
    x: (p.ai + p.human) / 2, y: p.ai - p.human, name: p.title,
  })) ?? [], [detail]);

  const downloadPDF = async () => {
    if (!reportRef.current) return;
    toast.info("Building PDF…");
    const canvas = await html2canvas(reportRef.current, {
      backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff", scale: 2,
    });
    const img = canvas.toDataURL("image/png");
    const pdf = new jsPDF({ orientation: "p", unit: "pt", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const ratio = canvas.width / canvas.height;
    const imgW = pageW - 40;
    const imgH = imgW / ratio;
    if (imgH < pageH - 40) {
      pdf.addImage(img, "PNG", 20, 20, imgW, imgH);
    } else {
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

  const setAsPrimaryAcrossSplit = async (model: string, variant: string) => {
    // For every evaluation in the active split, set primary_run_id to the latest run matching (model,variant).
    const splitFilter = metrics?.split ?? "all";
    let q = supabase.from("evaluations").select("id").eq("user_id", user!.id);
    if (splitFilter !== "all") q = q.eq("split", splitFilter);
    const { data: evs, error } = await q;
    if (error) { toast.error(error.message); return; }
    let ok = 0;
    for (const ev of evs ?? []) {
      const { data: run } = await supabase
        .from("model_runs")
        .select("id, total_score, max_score, evaluation_json")
        .eq("evaluation_id", ev.id)
        .eq("model", model).eq("prompt_variant", variant)
        .order("created_at", { ascending: false }).limit(1).single();
      if (!run) continue;
      const { error: upErr } = await supabase.from("evaluations").update({
        primary_run_id: run.id, total_score: run.total_score,
        max_score: run.max_score, evaluation_json: run.evaluation_json,
      }).eq("id", ev.id);
      if (!upErr) ok++;
    }
    toast.success(`${modelShort(model)} · ${variant} set as primary on ${ok} paper${ok === 1 ? "" : "s"}.`);
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
              Model performance
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {metrics
                ? `${metrics.counts.runs} run${metrics.counts.runs === 1 ? "" : "s"} across ${metrics.counts.groups} model/variant combination${metrics.counts.groups === 1 ? "" : "s"}.`
                : "Loading…"}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1 rounded-md border border-border p-0.5 text-xs">
              {SPLITS.map((s) => (
                <button
                  key={s}
                  onClick={() => { setSplit(s); setFocus(null); void load({ split: s, focus: null }); }}
                  className={
                    "px-2 py-1 rounded transition-colors capitalize " +
                    (split === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")
                  }
                >
                  {s}
                </button>
              ))}
            </div>
            <Button onClick={() => load()} disabled={busy} variant="ghost" size="sm">
              {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1.5" />}
              Refresh
            </Button>
            <Button onClick={downloadPDF} disabled={!metrics || !metrics.detail} size="sm">
              <Download className="h-4 w-4 mr-1.5" /> Download PDF
            </Button>
          </div>
        </div>

        {!metrics ? (
          <div className="rounded-2xl border border-border bg-card p-10 text-center">
            <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
          </div>
        ) : metrics.leaderboard.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-10 text-center">
            <p className="font-display text-lg">No model runs yet</p>
            <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
              Evaluate at least one paper that has a teacher's total score in the rubric. Try several models and prompt variants — they'll appear here.
            </p>
          </div>
        ) : (
          <div ref={reportRef} className="space-y-6 bg-background p-2">
            {/* Best model card */}
            {metrics.best && (
              <div className="rounded-2xl border border-accent/40 bg-card p-5 flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-accent/15 flex items-center justify-center">
                    <Trophy className="h-5 w-5 text-accent" />
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Recommended</p>
                    <p className="font-display text-lg text-foreground">
                      {modelShort(metrics.best.model)} <span className="text-muted-foreground">·</span> {metrics.best.variant}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Lowest MAE on {metrics.split === "all" ? "all" : metrics.split} split.
                    </p>
                  </div>
                </div>
                <Button size="sm" onClick={() => setAsPrimaryAcrossSplit(metrics.best!.model, metrics.best!.variant)}>
                  <Check className="h-4 w-4 mr-1.5" /> Use for all papers in this split
                </Button>
              </div>
            )}

            {/* Leaderboard */}
            <div className="rounded-2xl border border-border bg-card p-5">
              <h3 className="font-display text-lg text-foreground mb-3">Leaderboard</h3>
              <div className="overflow-x-auto">
                <table className="text-xs w-full">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="p-2 text-left">Model</th>
                      <th className="p-2 text-left">Variant</th>
                      <th className="p-2 text-right">N</th>
                      <th className="p-2 text-right">MAE ↓</th>
                      <th className="p-2 text-right">RMSE ↓</th>
                      <th className="p-2 text-right">Pearson ↑</th>
                      <th className="p-2 text-right">R² ↑</th>
                      <th className="p-2 text-right">Bucket Acc ↑</th>
                      <th className="p-2 text-right">Macro F1 ↑</th>
                      <th className="p-2 text-right">κ ↑</th>
                      <th className="p-2 text-right">AUC ↑</th>
                      <th className="p-2 text-right">Latency</th>
                      <th className="p-2 text-right">Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.leaderboard.map((r, i) => {
                      const isBest = i === 0 && r.n >= 2;
                      const isFocus = focus?.model === r.model && focus?.variant === r.variant;
                      return (
                        <tr
                          key={`${r.model}|${r.variant}`}
                          onClick={() => { const f = { model: r.model, variant: r.variant }; setFocus(f); void load({ focus: f }); }}
                          className={
                            "border-b border-border/50 cursor-pointer transition-colors " +
                            (isFocus ? "bg-primary/10" : "hover:bg-muted/40")
                          }
                        >
                          <td className="p-2 font-medium flex items-center gap-1.5">
                            {isBest && <Trophy className="h-3 w-3 text-accent" />}
                            {modelShort(r.model)}
                          </td>
                          <td className="p-2 capitalize">{r.variant}</td>
                          <td className="p-2 text-right tabular-nums">{r.n}</td>
                          <td className="p-2 text-right tabular-nums">{fmt(r.mae, 2)}</td>
                          <td className="p-2 text-right tabular-nums">{fmt(r.rmse, 2)}</td>
                          <td className="p-2 text-right tabular-nums">{fmt(r.pearson)}</td>
                          <td className="p-2 text-right tabular-nums">{fmt(r.r2)}</td>
                          <td className="p-2 text-right tabular-nums">{fmt(r.accuracy * 100, 1)}%</td>
                          <td className="p-2 text-right tabular-nums">{fmt(r.macroF1)}</td>
                          <td className="p-2 text-right tabular-nums">{fmt(r.kappa)}</td>
                          <td className="p-2 text-right tabular-nums">{fmt(r.auc)}</td>
                          <td className="p-2 text-right tabular-nums">{r.avgLatencyMs ? `${(r.avgLatencyMs / 1000).toFixed(1)}s` : "—"}</td>
                          <td className="p-2 text-right tabular-nums text-destructive">{r.errors || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">
                Click any row to view detailed charts below. ↑ higher is better; ↓ lower is better.
              </p>
            </div>

            {/* Detail charts for focus */}
            {detail && metrics.focus && detail.n >= 2 && (
              <>
                <div className="text-xs text-muted-foreground -mb-2 px-1">
                  Detailed view: <span className="font-medium text-foreground">{modelShort(metrics.focus.model)}</span> · {metrics.focus.variant} · n={detail.n}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Stat label="Pearson r" value={fmt(detail.regression.pearson)} hint="AI vs human (%)" />
                  <Stat label="Spearman ρ" value={fmt(detail.regression.spearman)} />
                  <Stat label="R²" value={fmt(detail.regression.r2)} />
                  <Stat label="MAE" value={`${fmt(detail.regression.mae, 2)} pts`} />
                  <Stat label="RMSE" value={`${fmt(detail.regression.rmse, 2)} pts`} />
                  <Stat label="Bucket accuracy" value={`${fmt(detail.classification.accuracy * 100, 1)}%`} />
                  <Stat label="Macro F1" value={fmt(detail.classification.macroF1)} />
                  <Stat label="Cohen's κ" value={fmt(detail.classification.kappa)} />
                  <Stat label="ROC AUC" value={fmt(detail.roc.auc)} hint={`pass ≥ ${metrics.passThreshold}%`} />
                  <Stat label="Mean bias" value={`${fmt(detail.regression.meanDiff, 2)} pts`} hint="AI − human" />
                  <Stat label="SD of diff" value={`${fmt(detail.regression.sdDiff, 2)} pts`} />
                  <Stat label="Sample size" value={String(detail.n)} />
                </div>

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

                <div className="grid md:grid-cols-2 gap-6">
                  <Card title={`ROC curve · pass threshold ${metrics.passThreshold}%`}>
                    <div className="flex items-center gap-2 mb-2 text-xs">
                      <Label htmlFor="pass" className="text-muted-foreground">Pass threshold (%)</Label>
                      <Input id="pass" type="number" value={pass} min={0} max={100}
                        onChange={(e) => setPass(Number(e.target.value))}
                        onBlur={() => load({ pass })} className="h-7 w-20" />
                    </div>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={detail.roc.points} margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                        <XAxis type="number" dataKey="fpr" domain={[0, 1]} label={{ value: "FPR", position: "bottom", offset: 10 }} />
                        <YAxis type="number" dataKey="tpr" domain={[0, 1]} label={{ value: "TPR", angle: -90, position: "left" }} />
                        <Tooltip formatter={(v: any) => fmt(Number(v), 3)} />
                        <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" />
                        <Line type="monotone" dataKey="tpr" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                    <p className="text-xs text-muted-foreground text-center mt-1">AUC = {fmt(detail.roc.auc)}</p>
                  </Card>

                  <Card title="Bland–Altman plot (agreement)">
                    <ResponsiveContainer width="100%" height={340}>
                      <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                        <XAxis type="number" dataKey="x" name="Mean" domain={[0, 100]} label={{ value: "Mean of AI & human (%)", position: "bottom", offset: 10 }} />
                        <YAxis type="number" dataKey="y" name="Diff" label={{ value: "AI − human (pts)", angle: -90, position: "left" }} />
                        <Tooltip formatter={(v: any) => fmt(Number(v), 2)} />
                        <ReferenceLine y={detail.regression.meanDiff} stroke="hsl(var(--accent))" strokeDasharray="3 3" />
                        <ReferenceLine y={detail.regression.meanDiff + 1.96 * detail.regression.sdDiff} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 4" />
                        <ReferenceLine y={detail.regression.meanDiff - 1.96 * detail.regression.sdDiff} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 4" />
                        <Scatter data={blandData} fill="hsl(var(--primary))" />
                      </ScatterChart>
                    </ResponsiveContainer>
                  </Card>
                </div>

                <Card title="Confusion matrix · grade buckets (rows = human, cols = AI)">
                  <div className="overflow-x-auto">
                    <table className="text-sm w-full max-w-md mx-auto">
                      <thead>
                        <tr>
                          <th className="p-2"></th>
                          {detail.classification.labels.map(l => (
                            <th key={l} className="p-2 text-xs font-medium text-muted-foreground">AI {l}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {detail.classification.labels.map(h => {
                          const max = Math.max(...detail.classification.labels.map(a => detail.classification.matrix[h][a]));
                          return (
                            <tr key={h}>
                              <td className="p-2 text-xs font-medium text-muted-foreground">Human {h}</td>
                              {detail.classification.labels.map(a => {
                                const v = detail.classification.matrix[h][a];
                                const intensity = max ? v / max : 0;
                                const isDiag = h === a;
                                return (
                                  <td key={a} className="p-1">
                                    <div className="aspect-square flex items-center justify-center rounded text-sm font-medium"
                                      style={{
                                        background: isDiag
                                          ? `color-mix(in oklab, hsl(var(--primary)) ${intensity * 70 + 10}%, transparent)`
                                          : `color-mix(in oklab, hsl(var(--destructive)) ${intensity * 50}%, transparent)`,
                                        color: intensity > 0.5 ? "white" : undefined,
                                      }}>{v}</div>
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
                        {detail.classification.labels.map(l => {
                          const c = detail.classification.perClass[l];
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

                {/* Per-model MAE bar */}
                <Card title="MAE comparison across all models & variants">
                  <ResponsiveContainer width="100%" height={Math.max(220, metrics.leaderboard.length * 36)}>
                    <BarChart
                      data={metrics.leaderboard.map(r => ({ name: `${modelShort(r.model)} · ${r.variant}`, mae: isFinite(r.mae) ? r.mae : 0 }))}
                      layout="vertical"
                      margin={{ top: 10, right: 20, bottom: 10, left: 30 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                      <XAxis type="number" label={{ value: "MAE (% pts)", position: "bottom", offset: -2 }} />
                      <YAxis type="category" dataKey="name" width={180} />
                      <Tooltip formatter={(v: any) => fmt(Number(v), 2) + " pts"} />
                      <Legend />
                      <Bar dataKey="mae" name="Mean abs error" fill="hsl(var(--primary))" />
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              </>
            )}

            <p className="text-[10px] text-muted-foreground text-center pt-2">
              Generated {new Date().toLocaleString()} · split={metrics.split} · pass≥{metrics.passThreshold}%
              · Buckets: A≥80, B≥70, C≥60, D≥50, F&lt;50
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
