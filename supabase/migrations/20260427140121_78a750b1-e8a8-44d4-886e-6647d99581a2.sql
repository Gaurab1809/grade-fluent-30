-- Multi-file + split tagging on evaluations
ALTER TABLE public.evaluations
  ADD COLUMN IF NOT EXISTS paper_files jsonb,         -- array of {path, mime, name}
  ADD COLUMN IF NOT EXISTS split text DEFAULT 'unassigned', -- train | validation | test | unassigned
  ADD COLUMN IF NOT EXISTS primary_run_id uuid;

-- Per-criterion human scores (richer than the per-question human_scores we already have)
ALTER TABLE public.evaluations
  ADD COLUMN IF NOT EXISTS criterion_scores_human jsonb;  -- [{criterion, awarded, max}]

-- One row per (paper, model, prompt_variant)
CREATE TABLE IF NOT EXISTS public.model_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL REFERENCES public.evaluations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model text NOT NULL,                  -- e.g. 'google/gemini-2.5-flash', 'openai/gpt-5'
  prompt_variant text NOT NULL DEFAULT 'baseline',
  evaluation_json jsonb,                -- {questions:[...], total_score, max_score, overall_feedback}
  criterion_scores jsonb,               -- [{criterion, awarded, max, feedback}]
  total_score numeric,
  max_score numeric,
  latency_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.model_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner can read model_runs"
  ON public.model_runs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Owner can insert model_runs"
  ON public.model_runs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owner can update model_runs"
  ON public.model_runs FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Owner can delete model_runs"
  ON public.model_runs FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS model_runs_eval_idx ON public.model_runs(evaluation_id);
CREATE INDEX IF NOT EXISTS model_runs_user_model_idx ON public.model_runs(user_id, model);
CREATE INDEX IF NOT EXISTS evaluations_split_idx ON public.evaluations(user_id, split);