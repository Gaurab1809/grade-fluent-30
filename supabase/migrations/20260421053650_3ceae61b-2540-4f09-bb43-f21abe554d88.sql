ALTER TABLE public.evaluations
  ADD COLUMN IF NOT EXISTS human_scores jsonb,
  ADD COLUMN IF NOT EXISTS human_total numeric,
  ADD COLUMN IF NOT EXISTS human_max numeric;