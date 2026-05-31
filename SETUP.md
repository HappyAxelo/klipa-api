# K-Lipa API — Go Live Guide

This turns the demo into a real backend where data survives and logins are real.
Stack: NestJS + Prisma + Supabase (Postgres, Auth, Storage), deployed on Railway.

Estimated time first run: about an hour, most of it waiting on Supabase and Railway.

---

## The shape of it

```
Mobile / Web client ──(Supabase login → JWT)──┐
                                              ▼
                                   NestJS API (Railway)
                                   verifies JWT, scopes to org
                                              ▼
                                   Supabase Postgres (RLS on)
```

The client logs in directly with Supabase and gets a token. Every API call carries
that token. The API verifies it, figures out which organisation the user belongs to,
and every database query is locked to that organisation by Row-Level Security.

---

## Step 1 — Create the Supabase project (~10 min)

1. Go to supabase.com, create a project. Pick the region closest to Rwanda
   (eu-central or similar). Save the database password somewhere safe.
2. Project Settings > Database > Connection string. Copy two strings:
   - The **pooled** one (port 6543) → this is `DATABASE_URL`
   - The **direct** one (port 5432) → this is `DIRECT_URL`
3. Project Settings > API > copy the **JWT Secret** → this is `SUPABASE_JWT_SECRET`.
4. Authentication > Providers > make sure **Email** is enabled. Turn on
   "Confirm email" later; leave off while testing.

## Step 2 — Run it locally first (~15 min)

```bash
npm install
cp .env.example .env          # paste your DATABASE_URL, DIRECT_URL, SUPABASE_JWT_SECRET
npm run prisma:generate
npm run prisma:migrate         # creates all tables in Supabase
npm run db:rls                 # applies Row-Level Security (needs psql installed)
npm run seed                   # inserts a demo org so you can see data
npm run start:dev
```

Open http://localhost:4000/health — you should see `{"status":"ok","db":"up"}`.
That single response proves the API is talking to a real, persistent database.

If `npm run db:rls` fails because `psql` isn't installed, open the Supabase
Dashboard > SQL Editor, paste the contents of `prisma/rls.sql`, and run it once.

## Step 3 — Prove persistence (~5 min)

The point of this phase. To call authenticated routes you need a real token:

1. In Supabase Dashboard > Authentication > Users, "Add user" with an email + password.
2. Get a token for that user. Easiest: in the SQL editor isn't enough — use the
   Supabase JS client or the Auth REST endpoint:
   ```bash
   curl -X POST "https://[ref].supabase.co/auth/v1/token?grant_type=password" \
     -H "apikey: [your-anon-key]" -H "Content-Type: application/json" \
     -d '{"email":"you@test.rw","password":"yourpassword"}'
   ```
   Copy the `access_token` from the response.
3. Put it in `requests.http` as the token, then run the onboarding + create-invoice
   calls. Stop the server, start it again, call `GET /v1/invoices`. The invoice is
   still there. That is the whole milestone: data survives a restart.

## Step 4 — Deploy to Railway (~20 min)

1. Push this folder to a GitHub repo.
2. railway.app > New Project > Deploy from GitHub repo > pick it.
   Railway reads `railway.json` and builds the `Dockerfile` automatically.
3. In the service's **Variables**, add everything from your `.env`
   (DATABASE_URL, DIRECT_URL, SUPABASE_JWT_SECRET, PUBLIC_APP_URL,
   CURRENT_TERMS_VERSION, EMAIL_PROVIDER=console for now).
4. Railway gives you a public URL. Migrations run automatically on deploy
   (the Dockerfile runs `prisma migrate deploy` before starting).
5. Hit `https://your-app.up.railway.app/health` → `{"status":"ok"}`.

Point the web/mobile app's API base URL at that Railway URL. Done — the app now
persists to a real database in the cloud.

## Step 5 — Connect the front end

The React app currently keeps everything in browser memory. To use this backend,
replace the local state writes with calls to these endpoints, sending the Supabase
token as `Authorization: Bearer <token>`:

```
POST /v1/onboarding              { businessName, category, currency, fullName,
                                   termsVersion, consentLanguage }
GET  /v1/me
POST /v1/invoices                { customer:{name,email}, amount, dueDate, send }
GET  /v1/invoices
POST /v1/invoices/:id/mark-paid
GET  /v1/customers, GET /v1/customers/:id
GET  /v1/public/invoice/:token   (no auth — the shareable link)
GET  /health                     (no auth — monitoring)
```

---

## What this phase delivers

Data survives. Logins are real. Consent is recorded with its timestamp, version,
and language. Tenants are isolated three ways (app scoping, repository filter,
Postgres RLS). The app is deployed and monitorable.

## What's deliberately NOT here yet (next phases)

- **Reminder worker + email sending** — reminders are scheduled into the DB; the
  worker that sends them is the next build. Until then `EMAIL_PROVIDER=console`
  just logs them.
- **Real payments** — the `payment` table and manual "mark paid" exist. The in-app
  pay button through a licensed aggregator (IntouchPay / MTN / Flutterwave) comes
  only once real invoice volume exists.
- **Events log, idempotency keys** — recommended hardening before you scale.

## Monthly cost at launch

Supabase Pro ~$25, Railway ~$5–20, email ~$20, domain ~$15/yr.
Roughly RWF 70,000/month. Free tiers cover the pilot.

## Security checklist before real users

- [ ] `prisma/rls.sql` applied (run the cross-tenant test: log in as org A, try to
      GET org B's invoice by id — must return 404)
- [ ] Service-role key never in the client; only the anon key ships to the browser
- [ ] SPF, DKIM, DMARC on the sending domain before switching email off `console`
- [ ] Registered as a data controller under Rwanda's data protection law
- [ ] Database backups confirmed (Supabase does daily; test a restore once)
