-- DailyForge uses Supabase only as an online heartbeat. All business data stays in Feishu.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Keep exactly one DailyForge heartbeat job when this script is run again.
select cron.unschedule(jobid)
from cron.job
where jobname like 'dailyforge-%';

select cron.schedule(
  'dailyforge-online-heartbeat',
  '* * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'dailyforge_base_url'
    ) || '/api/cron/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'dailyforge_cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 285000
  );
  $$
);

-- The result must contain one active row named dailyforge-online-heartbeat.
select jobid, jobname, schedule, active
from cron.job
where jobname like 'dailyforge-%'
order by jobname;

-- Check names only. Never query or print decrypted_secret during verification.
select name
from vault.decrypted_secrets
where name in ('dailyforge_base_url', 'dailyforge_cron_secret')
order by name;
