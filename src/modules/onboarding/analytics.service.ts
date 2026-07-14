import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service';
import { PLANS, PlanId } from '../billing/plans';

/**
 * Platform analytics for the owner dashboard. Every number is computed from
 * real rows (users, orgs, invoices, payments, subscriptions, app events).
 * No sampling, no estimates: at Klipwa's scale exact SQL is cheap.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(days: number) {
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 3600 * 1000);

    const [series, funnel, active, screens, devices, revenue, feed, invoiceSignups] =
      await Promise.all([
        this.dailySeries(since),
        this.funnel(),
        this.activeUsers(),
        this.topScreens(since),
        this.deviceSplit(since),
        this.revenue(now, since),
        this.activityFeed(),
        this.prisma.appEvent.count({
          where: { event: 'signup_from_invoice', createdAt: { gt: since } },
        }),
      ]);

    const insights = this.insights({ series, funnel, active, devices, revenue, days });

    return {
      generatedAt: now,
      rangeDays: days,
      series,
      funnel,
      active,
      screens,
      devices,
      revenue,
      feed,
      invoiceSignups,
      insights,
    };
  }

  // Signups, invoices, quotations and money collected per day.
  private async dailySeries(since: Date) {
    const rows = await this.prisma.$queryRaw<
      { day: Date; signups: bigint; invoices: bigint; quotations: bigint; collected: bigint }[]
    >`
      with days as (
        select generate_series(date_trunc('day', ${since}::timestamptz), date_trunc('day', now()), '1 day') as day
      )
      select d.day,
        (select count(*) from user_profile u where date_trunc('day', u.created_at) = d.day) as signups,
        (select count(*) from invoice i where i.doc_type = 'invoice' and date_trunc('day', i.created_at) = d.day) as invoices,
        (select count(*) from invoice q where q.doc_type = 'quotation' and date_trunc('day', q.created_at) = d.day) as quotations,
        coalesce((select sum(p.amount) from payment p where date_trunc('day', p.paid_at) = d.day), 0) as collected
      from days d order by d.day`;
    return rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      signups: Number(r.signups),
      invoices: Number(r.invoices),
      quotations: Number(r.quotations),
      collected: Number(r.collected),
    }));
  }

  // Where users get to in the product lifecycle, and where they stop.
  private async funnel() {
    const [users, onboarded, invoiced, gotPaid, subscribed] = await Promise.all([
      this.prisma.userProfile.count(),
      this.prisma.$queryRaw<{ n: bigint }[]>`select count(distinct user_id) n from membership`,
      this.prisma.$queryRaw<{ n: bigint }[]>`
        select count(distinct organisation_id) n from invoice where doc_type = 'invoice'`,
      this.prisma.$queryRaw<{ n: bigint }[]>`
        select count(distinct i.organisation_id) n from payment p join invoice i on i.id = p.invoice_id`,
      this.prisma.organisation.count({ where: { subscribedUntil: { gt: new Date() } } }),
    ]);
    const steps = [
      { step: 'Signed up', count: users },
      { step: 'Created their business', count: Number(onboarded[0]?.n ?? 0) },
      { step: 'Sent first invoice', count: Number(invoiced[0]?.n ?? 0) },
      { step: 'Recorded first payment', count: Number(gotPaid[0]?.n ?? 0) },
      { step: 'Paying subscriber', count: subscribed },
    ];
    return steps.map((s, i) => ({
      ...s,
      pctOfTop: steps[0].count ? Math.round((s.count / steps[0].count) * 100) : 0,
      dropFromPrev:
        i === 0 || !steps[i - 1].count
          ? 0
          : Math.max(0, Math.round((1 - s.count / steps[i - 1].count) * 100)),
    }));
  }

  // Distinct users seen in app events per window; "online" = last 5 minutes.
  private async activeUsers() {
    const r = await this.prisma.$queryRaw<
      { online: bigint; today: bigint; d7: bigint; d30: bigint }[]
    >`select
        count(distinct user_id) filter (where created_at > now() - interval '5 minutes') as online,
        count(distinct user_id) filter (where created_at > date_trunc('day', now())) as today,
        count(distinct user_id) filter (where created_at > now() - interval '7 days') as d7,
        count(distinct user_id) filter (where created_at > now() - interval '30 days') as d30
      from app_event`;
    const x = r[0];
    return {
      onlineNow: Number(x?.online ?? 0),
      today: Number(x?.today ?? 0),
      last7Days: Number(x?.d7 ?? 0),
      last30Days: Number(x?.d30 ?? 0),
    };
  }

  private async topScreens(since: Date) {
    const rows = await this.prisma.$queryRaw<{ path: string; views: bigint; users: bigint }[]>`
      select path, count(*) views, count(distinct user_id) users
      from app_event where event = 'screen' and path is not null and created_at > ${since}
      group by path order by views desc limit 12`;
    return rows.map((r) => ({ screen: r.path, views: Number(r.views), users: Number(r.users) }));
  }

  private async deviceSplit(since: Date) {
    const rows = await this.prisma.$queryRaw<{ device: string; users: bigint }[]>`
      select coalesce(device, 'other') device, count(distinct user_id) users
      from app_event where created_at > ${since}
      group by 1 order by users desc`;
    return rows.map((r) => ({ device: r.device, users: Number(r.users) }));
  }

  // Subscription money. MRR = active subscriptions x plan price (list price).
  private async revenue(now: Date, since: Date) {
    const activeSubs = await this.prisma.organisation.findMany({
      where: { subscribedUntil: { gt: now } },
      select: { id: true, name: true, plan: true, subscribedUntil: true, autoRenew: true },
    });
    const byPlan: Record<string, { count: number; mrr: number }> = {};
    let mrr = 0;
    for (const o of activeSubs) {
      const p = PLANS[(o.plan as PlanId)] ?? PLANS.starter;
      const price = p.priceMonthly > 0 ? p.priceMonthly : 0;
      byPlan[p.id] = byPlan[p.id] || { count: 0, mrr: 0 };
      byPlan[p.id].count += 1;
      byPlan[p.id].mrr += price;
      mrr += price;
    }
    // Churn in range: paid periods that ended in the window and were not renewed.
    const churned = await this.prisma.organisation.count({
      where: { subscribedUntil: { gt: since, lt: now } },
    });
    const churnRate =
      activeSubs.length + churned > 0
        ? Math.round((churned / (activeSubs.length + churned)) * 100)
        : 0;
    return {
      mrr,
      arr: mrr * 12,
      activeSubscriptions: activeSubs.length,
      churnedInRange: churned,
      churnRatePct: churnRate,
      byPlan: Object.entries(byPlan).map(([plan, v]) => ({ plan, ...v })),
      subscribers: activeSubs
        .map((o) => ({
          name: o.name,
          plan: o.plan,
          renewsAt: o.subscribedUntil,
          autoRenew: o.autoRenew,
          monthly: (PLANS[(o.plan as PlanId)] ?? PLANS.starter).priceMonthly,
        }))
        .sort((a, b) => b.monthly - a.monthly)
        .slice(0, 15),
    };
  }

  // Latest platform activity (what is happening right now).
  private async activityFeed() {
    const rows = await this.prisma.$queryRaw<
      { event: string; path: string | null; device: string | null; created_at: Date }[]
    >`select event, path, device, created_at from app_event order by created_at desc limit 20`;
    return rows.map((r) => ({
      event: r.event,
      path: r.path,
      device: r.device,
      at: r.created_at,
    }));
  }

  // Plain-language findings computed from the same numbers the charts show.
  // Deterministic on purpose: every sentence is checkable against the data.
  private insights(d: {
    series: { signups: number; invoices: number; collected: number }[];
    funnel: { step: string; count: number; dropFromPrev: number }[];
    active: { last7Days: number; last30Days: number };
    devices: { device: string; users: number }[];
    revenue: { mrr: number; activeSubscriptions: number; churnedInRange: number };
    days: number;
  }): string[] {
    const out: string[] = [];
    const half = Math.floor(d.series.length / 2);
    const sum = (rows: typeof d.series, k: 'signups' | 'invoices' | 'collected') =>
      rows.reduce((s, r) => s + r[k], 0);
    const firstHalf = d.series.slice(0, half);
    const secondHalf = d.series.slice(half);

    const trend = (k: 'signups' | 'invoices', label: string) => {
      const a = sum(firstHalf, k);
      const b = sum(secondHalf, k);
      if (a === 0 && b === 0) return;
      if (a === 0) { out.push(`${label} started appearing in the recent half of this period (${b} total).`); return; }
      const pct = Math.round(((b - a) / a) * 100);
      if (pct >= 15) out.push(`${label} are up ${pct}% in the second half of this period (${a} to ${b}).`);
      else if (pct <= -15) out.push(`${label} are down ${Math.abs(pct)}% in the second half of this period (${a} to ${b}).`);
    };
    trend('signups', 'Signups');
    trend('invoices', 'Invoices');

    const worst = [...d.funnel.slice(1)].sort((x, y) => y.dropFromPrev - x.dropFromPrev)[0];
    if (worst && worst.dropFromPrev >= 30) {
      out.push(`Biggest drop-off: ${worst.dropFromPrev}% of users are lost before "${worst.step}". That is the step to improve first.`);
    }
    const inv = d.funnel.find((f) => f.step === 'Sent first invoice');
    const onb = d.funnel.find((f) => f.step === 'Created their business');
    if (inv && onb && onb.count > 0 && inv.count / onb.count >= 0.6) {
      out.push(`Activation is healthy: ${Math.round((inv.count / onb.count) * 100)}% of onboarded businesses have sent an invoice.`);
    }
    if (d.revenue.activeSubscriptions === 0) {
      out.push('No paying subscribers yet. Watch the funnel: every business that hits the 5-invoice limit is a conversion moment.');
    } else {
      out.push(`MRR is RWF ${d.revenue.mrr.toLocaleString('en-RW')} from ${d.revenue.activeSubscriptions} subscriber(s).`);
      if (d.revenue.churnedInRange > 0) out.push(`${d.revenue.churnedInRange} subscription(s) lapsed in this period. Check "Renewals due" and follow up.`);
    }
    if (d.devices.length) {
      const top = d.devices[0];
      const total = d.devices.reduce((s, x) => s + x.users, 0);
      if (total > 0 && top.users / total >= 0.6) {
        out.push(`${Math.round((top.users / total) * 100)}% of active users are on ${top.device}. Design and test mobile-first for that platform.`);
      }
    }
    if (d.active.last30Days === 0) {
      out.push('Usage tracking just went live: activity numbers fill in as people use the app from today onward.');
    }
    return out;
  }
}
