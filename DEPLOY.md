# Deploying the Klipwa API (Render free plan)

The API is a Docker container (see `Dockerfile`). It previously ran on
Railway; it runs identically on Render's free plan.

## One-time setup

1. Create an account at https://render.com (sign in with GitHub).
2. New + -> Web Service -> connect the `HappyAxelo/klipa-api` repository.
   Render detects the Dockerfile automatically. Pick the **Free** plan.
3. Add the environment variables below (Environment tab), then deploy.
4. The service URL will look like `https://klipa-api.onrender.com` - share it
   so the frontend and admin panel can be pointed at it.

## Environment variables

| Name | Value / where to find it |
|---|---|
| DATABASE_URL | Supabase dashboard -> Connect -> Connection string (Transaction pooler). Uses your database password. |
| SUPABASE_PROJECT_URL | https://slextsyyytjpdfsoawge.supabase.co |
| EMAIL_PROVIDER | resend |
| RESEND_API_KEY | resend.com dashboard -> API keys |
| EMAIL_FROM | K-Lipwa <invoices@klipwa.app> |
| PUBLIC_APP_URL | https://klipwa.app |
| API_PUBLIC_URL | the Render URL of this service (set after first deploy) |
| ADMIN_TOKEN | your admin token (same one the admin panel uses) |
| SUBSCRIPTION_INSTRUCTIONS | the payment instructions text shown on the billing page |
| VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT | from RAILWAY-PUSH-KEYS.txt (push notifications) |
| ANTHROPIC_API_KEY | optional - Klipwa AI (needs credits) |
| FREE_INVOICE_LIMIT | 5 (optional, default 5) |

Values previously lived in Railway -> klipa-api -> Variables; they can be
copied from there while the dashboard is still accessible.

## Keeping the free instance awake + running background jobs

The free instance sleeps after ~15 minutes idle, which also pauses the
in-process hourly jobs (payment reminders, renewals, overdue flipping).
Create a free account at https://cron-job.org and add two jobs:

1. **Keep-alive** - GET `https://<service>.onrender.com/health`
   every 10 minutes.
2. **Hourly jobs** - POST `https://<service>.onrender.com/v1/admin/run-jobs`
   every hour, with request header `x-admin-token: <ADMIN_TOKEN>`.

Both jobs are idempotent - calling them more often than needed is harmless.
