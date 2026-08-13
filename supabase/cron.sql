-- Run after deployment. Store secrets in Supabase Vault first:
-- select vault.create_secret('https://daily-forge-iota.vercel.app', 'dailyforge_base_url');
-- select vault.create_secret('your-cron-secret', 'dailyforge_cron_secret');
-- select vault.create_secret('your-worker-secret', 'dailyforge_worker_secret');

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid)
from cron.job
where jobname in (
  'dailyforge-create-daily-job',
  'dailyforge-dispatch-schedules',
  'dailyforge-run-worker',
  'dailyforge-cleanup-history',
  'dailyforge-trim-automation-logs'
);

select cron.schedule(
  'dailyforge-dispatch-schedules',
  '30 seconds',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'dailyforge_base_url') || '/api/cron/dispatch-schedules',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'dailyforge_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  )
  where exists (
    select 1
    from public.generation_schedules
    where is_enabled = true and next_run_at <= now()
  ) or exists (
    select 1
    from public.generation_batches
    where status = 'pending'
  );
  $$
);

select cron.schedule(
  'dailyforge-run-worker',
  '5 seconds',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'dailyforge_base_url') || '/api/worker/run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'dailyforge_worker_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 285000
  )
  where exists (
    select 1
    from public.content_jobs as job
    where (
      job.status in ('queued', 'retry') and job.run_after <= now()
    ) or (
      job.status = 'running' and job.locked_at < now() - interval '6 minutes'
    )
  );
  $$
);

select cron.schedule(
  'dailyforge-cleanup-history',
  '30 3 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'dailyforge_base_url') || '/api/cron/cleanup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'dailyforge_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

select cron.schedule(
  'dailyforge-trim-automation-logs',
  '45 3 * * *',
  $$
  delete from cron.job_run_details
  where end_time < now() - interval '24 hours';

  delete from net._http_response
  where created < now() - interval '24 hours';
  $$
);
