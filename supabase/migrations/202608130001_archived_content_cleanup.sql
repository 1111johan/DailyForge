create or replace function public.list_archived_content_jobs(
  p_finished_before timestamptz,
  p_limit integer default 20
)
returns table(job_id uuid, job_date date, post_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_finished_before > now() - interval '24 hours' then
    raise exception 'cleanup cutoff must be at least 24 hours old';
  end if;
  if p_limit < 1 or p_limit > 100 then
    raise exception 'cleanup limit must be between 1 and 100';
  end if;

  return query
  select job.id, job.job_date, post.id
  from public.content_jobs as job
  join public.generated_posts as post on post.job_id = job.id
  where job.status = 'completed'
    and job.finished_at < p_finished_before
    and nullif(post.feishu_record_id, '') is not null
  order by job.finished_at, job.created_at
  limit p_limit;
end;
$$;

create or replace function public.delete_archived_content_jobs(
  p_job_ids uuid[],
  p_finished_before timestamptz
)
returns table(deleted_jobs integer, deleted_batches integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  job_count integer := 0;
  batch_count integer := 0;
begin
  if p_finished_before > now() - interval '24 hours' then
    raise exception 'cleanup cutoff must be at least 24 hours old';
  end if;

  delete from public.model_call_logs as log
  where exists (
    select 1
    from public.content_jobs as job
    join public.generated_posts as post on post.job_id = job.id
    where job.id = any(p_job_ids)
      and job.status = 'completed'
      and job.finished_at < p_finished_before
      and nullif(post.feishu_record_id, '') is not null
      and (log.job_id = job.id or log.post_id = post.id)
  );

  delete from public.content_jobs as job
  where job.id = any(p_job_ids)
    and job.status = 'completed'
    and job.finished_at < p_finished_before
    and exists (
      select 1
      from public.generated_posts as post
      where post.job_id = job.id
        and nullif(post.feishu_record_id, '') is not null
    );
  get diagnostics job_count = row_count;

  delete from public.generation_batches as batch
  where batch.created_at < p_finished_before
    and batch.status in ('populated', 'failed')
    and not exists (
      select 1 from public.content_jobs as job where job.batch_id = batch.id
    );
  get diagnostics batch_count = row_count;

  return query select job_count, batch_count;
end;
$$;

revoke all on function public.list_archived_content_jobs(timestamptz, integer) from public;
revoke all on function public.delete_archived_content_jobs(uuid[], timestamptz) from public;
grant execute on function public.list_archived_content_jobs(timestamptz, integer) to service_role;
grant execute on function public.delete_archived_content_jobs(uuid[], timestamptz) to service_role;
