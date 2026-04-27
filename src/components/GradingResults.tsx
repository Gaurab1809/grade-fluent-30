type CriterionScore = {
  question_number: string;
  criterion: string;
  awarded: number;
  max: number;
  feedback?: string;
};

type EvaluationData = {
  questions: {
    question_number: string;
    question_summary: string;
    score_awarded: number;
    score_max: number;
    feedback: string;
  }[];
  criterion_scores?: CriterionScore[];
  total_score: number;
  max_score: number;
  overall_feedback: string;
};

type HumanCriterion = { question_number?: string; criterion?: string; awarded: number | null; max: number };

export function GradingResults({
  data,
  humanCriteria,
}: {
  data: EvaluationData;
  humanCriteria?: HumanCriterion[];
}) {
  const pct = data.max_score > 0 ? Math.round((data.total_score / data.max_score) * 100) : 0;

  // Lookup teacher mark for an AI criterion (match by question + criterion text, fuzzy)
  const findHuman = (qn: string, crit: string): HumanCriterion | undefined => {
    if (!humanCriteria) return undefined;
    const lc = crit.toLowerCase();
    return humanCriteria.find(
      (h) =>
        String(h.question_number ?? "") === String(qn) &&
        h.criterion &&
        (h.criterion.toLowerCase().includes(lc) || lc.includes(h.criterion.toLowerCase())),
    );
  };

  // Group criteria by question
  const byQ = new Map<string, CriterionScore[]>();
  for (const c of data.criterion_scores ?? []) {
    if (!byQ.has(c.question_number)) byQ.set(c.question_number, []);
    byQ.get(c.question_number)!.push(c);
  }

  return (
    <div className="space-y-5">
      {/* Score summary */}
      <div className="rounded-2xl border border-border bg-gradient-to-br from-card to-muted/40 p-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Total score</div>
            <div className="font-display text-5xl text-foreground mt-1 leading-none">
              {data.total_score}
              <span className="text-2xl text-muted-foreground"> / {data.max_score}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Grade</div>
            <div className="font-display text-4xl text-accent leading-none mt-1">{pct}%</div>
          </div>
        </div>
        <div className="mt-4 h-2 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-accent transition-all duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
        {data.overall_feedback && (
          <p className="mt-4 text-sm text-foreground/80 leading-relaxed">{data.overall_feedback}</p>
        )}
      </div>

      {/* Per-question */}
      <div className="space-y-3">
        {data.questions.map((q, i) => {
          const qpct = q.score_max > 0 ? (q.score_awarded / q.score_max) * 100 : 0;
          const tone = qpct >= 75 ? "text-success" : qpct >= 40 ? "text-warning" : "text-destructive";
          const criteria = byQ.get(q.question_number) ?? [];
          return (
            <div key={i} className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">Question {q.question_number}</div>
                  <div className="font-medium text-foreground mt-0.5">{q.question_summary}</div>
                </div>
                <div className={`font-display text-lg shrink-0 ${tone}`}>
                  {q.score_awarded}/{q.score_max}
                </div>
              </div>
              {q.feedback && (
                <p className="px-4 pb-3 text-sm text-muted-foreground leading-relaxed">{q.feedback}</p>
              )}
              {criteria.length > 0 && (
                <div className="border-t border-border bg-muted/30">
                  <div className="px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Criteria
                  </div>
                  <table className="w-full text-sm">
                    <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      <tr className="border-t border-border/60">
                        <th className="text-left px-4 py-1.5 font-normal">Criterion</th>
                        <th className="text-right px-2 py-1.5 font-normal">AI</th>
                        {humanCriteria && (
                          <th className="text-right px-2 py-1.5 font-normal">Teacher</th>
                        )}
                        {humanCriteria && (
                          <th className="text-right px-4 py-1.5 font-normal">Δ</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {criteria.map((c, idx) => {
                        const human = findHuman(c.question_number, c.criterion);
                        const diff = human?.awarded != null ? c.awarded - human.awarded : null;
                        return (
                          <tr key={idx} className="border-t border-border/40">
                            <td className="px-4 py-1.5 text-foreground/90">
                              <div>{c.criterion}</div>
                              {c.feedback && (
                                <div className="text-xs text-muted-foreground mt-0.5 leading-snug">
                                  {c.feedback}
                                </div>
                              )}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                              {c.awarded}/{c.max}
                            </td>
                            {humanCriteria && (
                              <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                                {human?.awarded != null ? `${human.awarded}/${human.max}` : "—"}
                              </td>
                            )}
                            {humanCriteria && (
                              <td
                                className={`px-4 py-1.5 text-right tabular-nums whitespace-nowrap ${
                                  diff == null ? "text-muted-foreground" :
                                  Math.abs(diff) < 0.5 ? "text-success" :
                                  Math.abs(diff) <= 1 ? "text-warning" : "text-destructive"
                                }`}
                              >
                                {diff == null ? "—" : (diff > 0 ? `+${diff}` : diff)}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export type { EvaluationData, CriterionScore, HumanCriterion };
