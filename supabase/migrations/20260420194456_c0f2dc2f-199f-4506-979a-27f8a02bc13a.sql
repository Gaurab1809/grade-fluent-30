
-- Profiles table
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Profiles are viewable by owner"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Evaluations table (each uploaded paper)
create table public.evaluations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled paper',
  file_path text,
  file_mime text,
  extracted_text text,
  ocr_confidence numeric,
  rubric text,
  evaluation_json jsonb,
  total_score numeric,
  max_score numeric,
  status text not null default 'uploaded', -- uploaded | extracted | evaluated
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.evaluations enable row level security;

create policy "Owner can read evaluations"
  on public.evaluations for select using (auth.uid() = user_id);
create policy "Owner can insert evaluations"
  on public.evaluations for insert with check (auth.uid() = user_id);
create policy "Owner can update evaluations"
  on public.evaluations for update using (auth.uid() = user_id);
create policy "Owner can delete evaluations"
  on public.evaluations for delete using (auth.uid() = user_id);

create index on public.evaluations (user_id, created_at desc);

-- updated_at trigger
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger evaluations_touch before update on public.evaluations
  for each row execute function public.touch_updated_at();
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Storage bucket for exam papers (private)
insert into storage.buckets (id, name, public) values ('exam-papers', 'exam-papers', false);

create policy "Users can read own papers"
  on storage.objects for select
  using (bucket_id = 'exam-papers' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "Users can upload own papers"
  on storage.objects for insert
  with check (bucket_id = 'exam-papers' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "Users can delete own papers"
  on storage.objects for delete
  using (bucket_id = 'exam-papers' and auth.uid()::text = (storage.foldername(name))[1]);
