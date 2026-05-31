-- FlowPay tenant isolation. Run AFTER `prisma migrate`.
-- Every tenant-owned table only returns rows for the org set on the
-- transaction via set_config('app.current_org', <uuid>, true).
-- The NestJS TenantPrisma service sets that value at the start of every
-- tenant-scoped transaction. This is the database wall behind the
-- application-level scoping — a bug in app code cannot leak across tenants.

-- Helper: read the current org, NULL if unset.
create or replace function app_current_org() returns uuid
language sql stable as $$
  select nullif(current_setting('app.current_org', true), '')::uuid
$$;

-- ----- organisation: a user sees only orgs they belong to via the GUC -----
alter table organisation enable row level security;
drop policy if exists org_self on organisation;
create policy org_self on organisation
  using (id = app_current_org());

-- ----- customer -----
alter table customer enable row level security;
drop policy if exists customer_isolation on customer;
create policy customer_isolation on customer
  using (organisation_id = app_current_org())
  with check (organisation_id = app_current_org());

-- ----- invoice -----
alter table invoice enable row level security;
drop policy if exists invoice_isolation on invoice;
create policy invoice_isolation on invoice
  using (organisation_id = app_current_org())
  with check (organisation_id = app_current_org());

-- ----- invoice_item (scoped through its invoice) -----
alter table invoice_item enable row level security;
drop policy if exists invoice_item_isolation on invoice_item;
create policy invoice_item_isolation on invoice_item
  using (exists (
    select 1 from invoice i
    where i.id = invoice_item.invoice_id
      and i.organisation_id = app_current_org()
  ));

-- ----- reminder (scoped through its invoice) -----
alter table reminder enable row level security;
drop policy if exists reminder_isolation on reminder;
create policy reminder_isolation on reminder
  using (exists (
    select 1 from invoice i
    where i.id = reminder.invoice_id
      and i.organisation_id = app_current_org()
  ));

-- ----- payment (scoped through its invoice) -----
alter table payment enable row level security;
drop policy if exists payment_isolation on payment;
create policy payment_isolation on payment
  using (exists (
    select 1 from invoice i
    where i.id = payment.invoice_id
      and i.organisation_id = app_current_org()
  ));

-- membership is read during auth, before an org is chosen, so the app
-- queries it with the service role (RLS bypassed). Keep RLS off here,
-- or add a policy keyed on auth.uid() if you move auth into Postgres.

-- ----- Computed balances. Never store these. -----
create or replace view customer_balance as
select
  c.id                                                          as customer_id,
  c.organisation_id,
  coalesce(sum(i.amount_total), 0)                              as total_invoiced,
  coalesce(sum(p.paid), 0)                                      as total_paid,
  coalesce(sum(i.amount_total), 0) - coalesce(sum(p.paid), 0)   as outstanding
from customer c
left join invoice i on i.customer_id = c.id
left join lateral (
  select sum(amount) as paid from payment where invoice_id = i.id
) p on true
group by c.id, c.organisation_id;
