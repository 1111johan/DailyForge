create table public.generation_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  run_time time without time zone not null,
  weekdays smallint[] not null default array[1, 2, 3, 4, 5, 6, 7]::smallint[]
    check (
      cardinality(weekdays) between 1 and 7
      and weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
    ),
  post_count integer not null default 3 check (post_count between 1 and 20),
  product_mode text not null default 'rotate'
    check (product_mode in ('rotate', 'cet4', 'cet6')),
  is_enabled boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.generation_batches (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('manual', 'schedule')),
  schedule_id uuid references public.generation_schedules(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  scheduled_for timestamptz,
  idempotency_key text not null unique,
  requested_count integer not null check (requested_count between 1 and 20),
  created_count integer not null default 0 check (created_count between 0 and 20),
  product_mode text not null default 'rotate'
    check (product_mode in ('rotate', 'cet4', 'cet6')),
  prompt_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(prompt_snapshot) = 'object'),
  status text not null default 'pending'
    check (status in ('pending', 'populated', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (schedule_id, scheduled_for)
);

alter table public.content_jobs
  add column batch_id uuid references public.generation_batches(id) on delete set null,
  add column sequence_no integer check (sequence_no is null or sequence_no >= 1),
  add column start_delay_seconds integer not null default 0
    check (start_delay_seconds between 0 and 180);

alter table public.content_jobs
  drop constraint if exists content_jobs_job_date_platform_product_id_key;

alter table public.content_jobs
  add constraint content_jobs_batch_sequence_key
  unique (batch_id, sequence_no);

create index content_jobs_batch_idx
  on public.content_jobs (batch_id, sequence_no)
  where batch_id is not null;

create index generation_schedules_due_idx
  on public.generation_schedules (next_run_at)
  where is_enabled = true;

create index generation_batches_pending_idx
  on public.generation_batches (created_at)
  where status = 'pending';

create trigger generation_schedules_set_updated_at
before update on public.generation_schedules
for each row execute function public.set_updated_at();

create trigger generation_batches_set_updated_at
before update on public.generation_batches
for each row execute function public.set_updated_at();

create or replace function public.next_generation_schedule_at(
  p_run_time time without time zone,
  p_weekdays smallint[],
  p_after timestamptz default now()
)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare
  local_day date;
  candidate timestamptz;
  offset_days integer;
begin
  if cardinality(p_weekdays) = 0 then
    raise exception 'at least one weekday is required';
  end if;

  for offset_days in 0..7 loop
    local_day := (p_after at time zone 'Asia/Shanghai')::date + offset_days;
    if extract(isodow from local_day)::smallint = any(p_weekdays) then
      candidate := (local_day + p_run_time) at time zone 'Asia/Shanghai';
      if candidate > p_after then
        return candidate;
      end if;
    end if;
  end loop;

  raise exception 'unable to calculate next schedule run';
end;
$$;

create or replace function public.refresh_generation_schedule_next_run()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_enabled then
    new.next_run_at := public.next_generation_schedule_at(
      new.run_time,
      new.weekdays,
      now()
    );
  else
    new.next_run_at := null;
  end if;
  return new;
end;
$$;

create trigger generation_schedules_refresh_next_run
before insert or update of run_time, weekdays, is_enabled
on public.generation_schedules
for each row execute function public.refresh_generation_schedule_next_run();

create or replace function public.claim_due_generation_batches(
  p_limit integer default 10
)
returns setof public.generation_batches
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_limit < 1 or p_limit > 50 then
    raise exception 'limit must be between 1 and 50';
  end if;

  return query
  with due as materialized (
    select schedule.*
    from public.generation_schedules as schedule
    where schedule.is_enabled = true
      and schedule.next_run_at <= now()
    order by schedule.next_run_at, schedule.created_at
    for update skip locked
    limit p_limit
  ), inserted as (
    insert into public.generation_batches (
      source,
      schedule_id,
      scheduled_for,
      idempotency_key,
      requested_count,
      product_mode,
      prompt_snapshot
    )
    select
      'schedule',
      due.id,
      due.next_run_at,
      'schedule:' || due.id::text || ':' || extract(epoch from due.next_run_at)::bigint::text,
      due.post_count,
      due.product_mode,
      coalesce(
        (
          select setting.value
          from public.app_settings as setting
          where setting.key = 'xiaohongshu_generation_prompts'
        ),
        '{}'::jsonb
      )
    from due
    on conflict (idempotency_key) do update
      set idempotency_key = excluded.idempotency_key
    returning public.generation_batches.*
  ), advanced as (
    update public.generation_schedules as schedule
    set
      last_run_at = due.next_run_at,
      next_run_at = public.next_generation_schedule_at(
        due.run_time,
        due.weekdays,
        due.next_run_at
      )
    from due
    where schedule.id = due.id
    returning schedule.id
  )
  select inserted.*
  from inserted
  cross join (select count(*) from advanced) as advanced_count;
end;
$$;

drop function if exists public.claim_content_job(text, interval);

create function public.claim_content_job(
  p_worker_id text,
  p_stale_after interval default interval '6 minutes',
  p_image_concurrency integer default 2
)
returns setof public.content_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  active_image_jobs integer;
begin
  if nullif(trim(p_worker_id), '') is null then
    raise exception 'worker id is required';
  end if;
  if p_image_concurrency < 1 or p_image_concurrency > 8 then
    raise exception 'image concurrency must be between 1 and 8';
  end if;

  perform pg_advisory_xact_lock(hashtext('dailyforge_claim_content_job'));

  select count(*)
  into active_image_jobs
  from public.content_jobs
  where status = 'running'
    and locked_at >= now() - p_stale_after
    and (stage like 'generate_image_%' or stage like 'poll_image_%');

  return query
  with candidate as (
    select job.id
    from public.content_jobs as job
    where (
      (
        job.status in ('queued', 'retry')
        and job.run_after <= now()
      ) or (
        job.status = 'running'
        and job.locked_at < now() - p_stale_after
      )
    )
    and (
      (job.stage not like 'generate_image_%' and job.stage not like 'poll_image_%')
      or active_image_jobs < p_image_concurrency
    )
    order by job.run_after, job.created_at
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

revoke all on function public.next_generation_schedule_at(time without time zone, smallint[], timestamptz) from public;
revoke all on function public.claim_due_generation_batches(integer) from public;
revoke all on function public.claim_content_job(text, interval, integer) from public;
grant execute on function public.next_generation_schedule_at(time without time zone, smallint[], timestamptz) to service_role;
grant execute on function public.claim_due_generation_batches(integer) to service_role;
grant execute on function public.claim_content_job(text, interval, integer) to service_role;

alter table public.generation_schedules enable row level security;
alter table public.generation_batches enable row level security;

insert into public.generation_schedules (
  name,
  run_time,
  weekdays,
  post_count,
  product_mode,
  is_enabled
)
select
  '每日内容',
  time '08:00',
  array[1, 2, 3, 4, 5, 6, 7]::smallint[],
  3,
  'rotate',
  true
where not exists (select 1 from public.generation_schedules);
