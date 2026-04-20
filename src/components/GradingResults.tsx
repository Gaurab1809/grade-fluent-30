type EvaluationData = {
  questions: {
    question_number: string;
    question_summary: string;
    score_awarded: number;
    score_max: number;
    feedback: string;
  }[];
  total_score: number;
  max_score: number;
  overall_feedback: string;
};

export function GradingResults({ data }: { data: EvaluationData }) {
  const pct = data.max_score > 0 ? Math.round((data.total_score / data.max_score) * 100) : 0;

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
          const tone =
            qpct >= 75 ? "text-success" : qpct >= 40 ? "text-warning" : "text-destructive";
          return (
            <div key={i} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">Question {q.question_number}</div>
                  <div className="font-medium text-foreground mt-0.5 truncate">{q.question_summary}</div>
                </div>
                <div className={`font-display text-lg shrink-0 ${tone}`}>
                  {q.score_awarded}/{q.score_max}
                </div>
              </div>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{q.feedback}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export type { EvaluationData };
