# K-Lipa API

Invoicing, collections and cash-flow for African SMEs. NestJS + Prisma + Supabase (Postgres, Auth, Storage).

This is the Phase 0 + Phase 1 core: auth, tenant isolation, onboarding, customers, invoices (create / send / mark paid), the public invoice link, and email reminder scheduling.

## What's here

```
src/
  common/
    auth/        Supabase JWT guard + @CurrentUser / @CurrentOrg decorators
    database/    PrismaService with withTenant() RLS wrapper
    money/       BigInt money formatting + JSON-safe serialiser
  integrations/
    email/       provider-agnostic email (console adapter for dev, Resend for prod)
  modules/
    onboarding/  create org + membership after signup
    customers/   list / create / profile (with computed balance)
    invoices/    create-and-send in one call, mark paid, reminders, WhatsApp text
    public-invoice/  the unauthenticated /i/:token route
prisma/
  schema.prisma  the data model
  rls.sql        Row-Level Security policies + customer_balance view
```

## Setup

1. Create a Supabase project. Note the database connection strings and the JWT secret (Project Settings > API).

2. Configure env:
   ```bash
   cp .env.example .env
   # fill in DATABASE_URL, DIRECT_URL, SUPABASE_JWT_SECRET
   ```

3. Install, generate the client, migrate, then apply RLS:
   ```bash
   npm install
   npm run prisma:generate
   npm run prisma:migrate -- --name init
   npm run db:rls          # applies prisma/rls.sql (needs psql on PATH)
   ```

4. Run:
   ```bash
   npm run start:dev
   # K-Lipa API on http://localhost:4000
   ```

In dev, leave `EMAIL_PROVIDER=console` so invoice emails are logged, not sent. The app runs fully without an email provider.

## The first-invoice flow (what to test)

The client signs in with Supabase Auth and gets an access token. Every call below sends `Authorization: Bearer <token>`, except the public route.

```
POST /v1/onboarding         { businessName, category, currency, fullName }
GET  /v1/me                 confirms organisationId is set
POST /v1/invoices           { customer: {name,email}, amount, dueDate, send:true }
                            -> returns public_link + whatsapp_share_text
GET  /v1/public/invoice/:token   (no auth) what the customer sees
POST /v1/invoices/:id/mark-paid  records a manual payment, status -> paid
```

See `requests.http` for ready-to-run examples (VS Code REST Client / IntelliJ).

## Tenant isolation

Every tenant query runs through `prisma.withTenant(orgId, tx => ...)`, which sets
`app.current_org` on the transaction. The RLS policies in `rls.sql` read that value
and refuse to return another org's rows. Application scoping and RLS are independent,
so a bug in one does not breach isolation.

Test it: sign in as org A, try to GET an invoice id that belongs to org B. You should
get 404, not the invoice.

## Not built yet (next sessions)

- PDF generation (the `pdf_url` field exists; generation is stubbed)
- Logo upload to Supabase Storage
- The reminder dispatch worker (reminders are scheduled into the DB; a cron/queue
  worker that sends them is Phase 3)
- Dashboard metrics endpoint, reports, team members, subscription enforcement
- Payments gateway (the `payment` table and `manual` method are ready for it)
