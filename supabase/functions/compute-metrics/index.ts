// Compute AI-vs-human grading metrics per (model, prompt_variant) for the authenticated user.
// Optional filters: split=train|val|test|all (default all), pass=<int>.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type Pair = { id: string; title: string; ai: number; human: number; ai_pct: number; human_pct: number; max: number };

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? NaN : num / den;
}
function rank(arr: number[]): number[] {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}
function spearman(x: number[], y: number[]): number { return pearson(rank(x), rank(y)); }
function bucket(pct: number): string {
  if (pct >= 80) return "A";
  if (pct >= 70) return "B";
  if (pct >= 60) return "C";
  if (pct >= 50) return "D";
  return "F";
}

function computeForPairs(pairs: Pair[], passThreshold: number) {
  const n = pairs.length;
  const aiArr = pairs.map(p => p.ai_pct);
  const humanArr = pairs.map(p => p.human_pct);

  const r_pearson = pearson(aiArr, humanArr);
  const r_spearman = spearman(aiArr, humanArr);
  const diffs = pairs.map(p => p.ai_pct - p.human_pct);
  const mae = n ? diffs.reduce((s, d) => s + Math.abs(d), 0) / n : NaN;
  const rmse = n ? Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / n) : NaN;
  const meanH = n ? humanArr.reduce((s, v) => s + v, 0) / n : 0;
  const ssTot = humanArr.reduce((s, v) => s + (v - meanH) ** 2, 0);
  const ssRes = pairs.reduce((s, p) => s + (p.human_pct - p.ai_pct) ** 2, 0);
  const r2 = ssTot === 0 ? NaN : 1 - ssRes / ssTot;
  const meanDiff = n ? diffs.reduce((s, d) => s + d, 0) / n : NaN;
  const sdDiff = n > 1 ? Math.sqrt(diffs.reduce((s, d) => s + (d - meanDiff) ** 2, 0) / (n - 1)) : NaN;

  const labels = ["A", "B", "C", "D", "F"];
  const matrix: Record<string, Record<string, number>> = {};
  for (const lh of labels) { matrix[lh] = {}; for (const la of labels) matrix[lh][la] = 0; }
  for (const p of pairs) matrix[bucket(p.human_pct)][bucket(p.ai_pct)]++;
  let correct = 0;
  for (const l of labels) correct += matrix[l][l];
  const accuracy = n ? correct / n : NaN;

  const perClass: Record<string, { precision: number; recall: number; f1: number; support: number }> = {};
  for (const l of labels) {
    const tp = matrix[l][l];
    const fp = labels.reduce((s, h) => s + (h !== l ? matrix[h][l] : 0), 0);
    const fn = labels.reduce((s, a) => s + (a !== l ? matrix[l][a] : 0), 0);
    const support = labels.reduce((s, a) => s + matrix[l][a], 0);
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perClass[l] = { precision, recall, f1, support };
  }
  const macroF1 = labels.reduce((s, l) => s + perClass[l].f1, 0) / labels.length;

  const po = accuracy;
  const rowTot: Record<string, number> = {};
  const colTot: Record<string, number> = {};
  for (const l of labels) {
    rowTot[l] = labels.reduce((s, a) => s + matrix[l][a], 0);
    colTot[l] = labels.reduce((s, h) => s + matrix[h][l], 0);
  }
  const pe = n === 0 ? 0 : labels.reduce((s, l) => s + (rowTot[l] / n) * (colTot[l] / n), 0);
  const kappa = pe === 1 ? NaN : (po - pe) / (1 - pe);

  const labelsBin = pairs.map(p => (p.human_pct >= passThreshold ? 1 : 0));
  const scores = pairs.map(p => p.ai_pct);
  const thresholds = Array.from(new Set([0, ...scores, 100])).sort((a, b) => b - a);
  const roc: { fpr: number; tpr: number; threshold: number }[] = [];
  const P = labelsBin.reduce((s, v) => s + v, 0);
  const N = labelsBin.length - P;
  for (const t of thresholds) {
    let tp = 0, fp = 0;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] >= t) { if (labelsBin[i] === 1) tp++; else fp++; }
    }
    roc.push({ fpr: N === 0 ? 0 : fp / N, tpr: P === 0 ? 0 : tp / P, threshold: t });
  }
  roc.sort((a, b) => a.fpr - b.fpr || a.tpr - b.tpr);
  let auc = 0;
  for (let i = 1; i < roc.length; i++) {
    auc += ((roc[i].fpr - roc[i - 1].fpr) * (roc[i].tpr + roc[i - 1].tpr)) / 2;
  }

  return {
    n,
    regression: { pearson: r_pearson, spearman: r_spearman, mae, rmse, r2, meanDiff, sdDiff },
    classification: { accuracy, macroF1, kappa, labels, matrix, perClass },
    roc: { points: roc, auc },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const passThreshold = Number(url.searchParams.get("pass") ?? "50");
    const splitFilter = (url.searchParams.get("split") ?? "all").toLowerCase();

    // Pull every evaluation with a human total
    let evalQuery = supabase
      .from("evaluations")
      .select("id, title, max_score, human_total, human_max, human_scores, evaluation_json, split, primary_run_id")
      .eq("user_id", userData.user.id);
    if (splitFilter !== "all") evalQuery = evalQuery.eq("split", splitFilter);
    const { data: evalRows, error: evalErr } = await evalQuery;
    if (evalErr) throw evalErr;

    const evalsById = new Map<string, any>();
    for (const r of evalRows ?? []) evalsById.set(r.id, r);
    const evalIds = [...evalsById.keys()];

    // Pull every model_run for those evaluations
    const { data: runRows, error: runErr } = await supabase
      .from("model_runs")
      .select("id, evaluation_id, model, prompt_variant, total_score, max_score, latency_ms, error")
      .in("evaluation_id", evalIds.length ? evalIds : ["00000000-0000-0000-0000-000000000000"]);
    if (runErr) throw runErr;

    // Group by (model, prompt_variant)
    type Group = { model: string; variant: string; pairs: Pair[]; latencies: number[]; errors: number };
    const groups = new Map<string, Group>();
    for (const run of runRows ?? []) {
      const ev = evalsById.get(run.evaluation_id);
      if (!ev) continue;
      const key = `${run.model}|${run.prompt_variant}`;
      let g = groups.get(key);
      if (!g) { g = { model: run.model, variant: run.prompt_variant, pairs: [], latencies: [], errors: 0 }; groups.set(key, g); }
      if (run.error) { g.errors++; continue; }
      if (run.total_score == null || ev.human_total == null) continue;
      const max = Number(run.max_score ?? ev.max_score ?? ev.human_max ?? 100);
      if (!max) continue;
      const ai = Number(run.total_score);
      const human = Number(ev.human_total);
      g.pairs.push({
        id: ev.id, title: ev.title, ai, human, max,
        ai_pct: (ai / max) * 100,
        human_pct: (human / Number(ev.human_max ?? max)) * 100,
      });
      if (run.latency_ms != null) g.latencies.push(Number(run.latency_ms));
    }

    // Per-group metrics + leaderboard
    const leaderboard = [...groups.values()].map((g) => {
      const m = computeForPairs(g.pairs, passThreshold);
      const avgLatency = g.latencies.length ? g.latencies.reduce((s, v) => s + v, 0) / g.latencies.length : null;
      return {
        model: g.model, variant: g.variant, n: m.n, errors: g.errors,
        avgLatencyMs: avgLatency,
        mae: m.regression.mae,
        rmse: m.regression.rmse,
        pearson: m.regression.pearson,
        r2: m.regression.r2,
        accuracy: m.classification.accuracy,
        macroF1: m.classification.macroF1,
        kappa: m.classification.kappa,
        auc: m.roc.auc,
      };
    }).sort((a, b) => {
      // Lower MAE wins; require at least 2 paired samples
      const aOk = a.n >= 2, bOk = b.n >= 2;
      if (aOk && !bOk) return -1;
      if (!aOk && bOk) return 1;
      const aMae = isFinite(a.mae) ? a.mae : Infinity;
      const bMae = isFinite(b.mae) ? b.mae : Infinity;
      return aMae - bMae;
    });

    const best = leaderboard.find((g) => g.n >= 2 && isFinite(g.mae)) ?? leaderboard[0] ?? null;

    // Detailed metrics for best (or a requested) (model, variant) — used for charts
    const requestedModel = url.searchParams.get("model");
    const requestedVariant = url.searchParams.get("variant");
    const focusKey = requestedModel && requestedVariant
      ? `${requestedModel}|${requestedVariant}`
      : best ? `${best.model}|${best.variant}` : null;
    const focus = focusKey ? groups.get(focusKey) : null;
    const detail = focus ? computeForPairs(focus.pairs, passThreshold) : null;

    return new Response(JSON.stringify({
      passThreshold,
      split: splitFilter,
      leaderboard,
      best: best ? { model: best.model, variant: best.variant } : null,
      focus: focus ? { model: focus.model, variant: focus.variant } : null,
      detail: detail ? {
        ...detail,
        pairs: focus!.pairs.map(p => ({ id: p.id, title: p.title, ai: p.ai_pct, human: p.human_pct })),
      } : null,
      counts: {
        evaluations: evalRows?.length ?? 0,
        runs: runRows?.length ?? 0,
        groups: groups.size,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("compute-metrics error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
