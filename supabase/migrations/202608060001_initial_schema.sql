create extension if not exists pgcrypto;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  level text not null check (level in ('cet4', 'cet6')),
  description text not null,
  selling_points jsonb not null default '[]'::jsonb
    check (jsonb_typeof(selling_points) = 'array'),
  prohibited_claims jsonb not null default '[]'::jsonb
    check (jsonb_typeof(prohibited_claims) = 'array'),
  product_assets jsonb not null default '[]'::jsonb
    check (jsonb_typeof(product_assets) = 'array'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name, level)
);

create table public.content_topics (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  topic text not null,
  content_type text not null,
  module text,
  target_user text,
  priority integer not null default 0,
  planned_date date,
  used_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, topic)
);

create table public.content_jobs (
  id uuid primary key default gen_random_uuid(),
  job_date date not null,
  platform text not null default 'xiaohongshu',
  product_id uuid not null references public.products(id) on delete restrict,
  topic_id uuid references public.content_topics(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'retry', 'completed', 'failed')),
  stage text not null default 'generate_copy',
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_date, platform, product_id)
);

create table public.generated_posts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.content_jobs(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  topic text not null,
  content_type text not null,
  target_user text not null,
  title_candidates jsonb not null default '[]'::jsonb
    check (jsonb_typeof(title_candidates) = 'array'),
  selected_title text not null,
  body text not null,
  hashtags jsonb not null default '[]'::jsonb
    check (jsonb_typeof(hashtags) = 'array'),
  cover_copy jsonb not null default '{}'::jsonb
    check (jsonb_typeof(cover_copy) = 'object'),
  image_briefs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(image_briefs) = 'array'),
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'needs_review')),
  review_notes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(review_notes) = 'array'),
  publish_status text not null default 'unpublished'
    check (publish_status in ('unpublished', 'published')),
  feishu_record_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.generated_assets (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.generated_posts(id) on delete cascade,
  asset_index integer not null check (asset_index between 1 and 4),
  asset_type text not null check (asset_type in ('cover', 'content')),
  prompt text not null,
  provider text,
  model text,
  external_task_id text,
  storage_bucket text,
  storage_path text,
  mime_type text,
  width integer,
  height integer,
  byte_size integer,
  feishu_file_token text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (post_id, asset_index)
);

create table public.model_call_logs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.content_jobs(id) on delete set null,
  post_id uuid references public.generated_posts(id) on delete set null,
  call_type text not null check (call_type in ('text', 'image', 'image_poll', 'review')),
  provider text,
  model text,
  request_id text,
  input_tokens integer,
  output_tokens integer,
  cost numeric(12, 6),
  latency_ms integer,
  status text not null check (status in ('success', 'error')),
  error_message text,
  created_at timestamptz not null default now()
);

create index content_jobs_claim_idx
  on public.content_jobs (run_after, created_at)
  where status in ('queued', 'retry');
create index content_jobs_stale_idx
  on public.content_jobs (locked_at)
  where status = 'running';
create index content_topics_selection_idx
  on public.content_topics (planned_date, priority desc, created_at)
  where is_active = true;
create index generated_assets_status_idx
  on public.generated_assets (post_id, status, asset_index);
create index model_call_logs_job_idx
  on public.model_call_logs (job_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger products_set_updated_at
before update on public.products
for each row execute function public.set_updated_at();

create trigger content_topics_set_updated_at
before update on public.content_topics
for each row execute function public.set_updated_at();

create trigger content_jobs_set_updated_at
before update on public.content_jobs
for each row execute function public.set_updated_at();

create trigger generated_posts_set_updated_at
before update on public.generated_posts
for each row execute function public.set_updated_at();

create trigger generated_assets_set_updated_at
before update on public.generated_assets
for each row execute function public.set_updated_at();

create or replace function public.claim_content_job(
  p_worker_id text,
  p_stale_after interval default interval '20 minutes'
)
returns setof public.content_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(p_worker_id), '') is null then
    raise exception 'worker id is required';
  end if;

  return query
  with candidate as (
    select id
    from public.content_jobs
    where (
      status in ('queued', 'retry')
      and run_after <= now()
    ) or (
      status = 'running'
      and locked_at < now() - p_stale_after
    )
    order by run_after asc, created_at asc
    for update skip locked
    limit 1
  )
  update public.content_jobs as job
  set
    status = 'running',
    locked_at = now(),
    locked_by = p_worker_id,
    started_at = coalesce(job.started_at, now()),
    error_code = null,
    error_message = null
  from candidate
  where job.id = candidate.id
  returning job.*;
end;
$$;

revoke all on function public.claim_content_job(text, interval) from public;
grant execute on function public.claim_content_job(text, interval) to service_role;

alter table public.products enable row level security;
alter table public.content_topics enable row level security;
alter table public.content_jobs enable row level security;
alter table public.generated_posts enable row level security;
alter table public.generated_assets enable row level security;
alter table public.model_call_logs enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'generated-content',
  'generated-content',
  false,
  20971520,
  array['image/png', 'image/jpeg', 'image/webp', 'application/json']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
