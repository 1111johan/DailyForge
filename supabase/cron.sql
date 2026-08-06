-- Run after deployment. Store secrets in Supabase Vault first:
-- select vault.create_secret('https://your-app.vercel.app', 'dailyforge_base_url');
-- select vault.create_secret('your-cron-secret', 'dailyforge_cron_secret');
-- select vault.create_secret('your-worker-secret', 'dailyforge_worker_secret');

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'dailyforge-create-daily-job',
  '0 0 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'dailyforge_base_url') || '/api/cron/create-daily-job',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'dailyforge_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  );
  $$
);

select cron.schedule(
  'dailyforge-run-worker',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'dailyforge_base_url') || '/api/worker/run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'dailyforge_worker_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 285000
  );
  $$
);
