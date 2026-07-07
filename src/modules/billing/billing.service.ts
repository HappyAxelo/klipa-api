import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/database/prisma.service';
import { effectivePlan, PLANS } from './plans';

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Everything the billing page needs: current plan, usage, catalog, how to pay. */
  async overview(orgId: string) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const org = await tx.organisation.findUnique({ where: { id: orgId } });
      const plan = effectivePlan(org?.plan, org?.subscribedUntil);
      const subscribed =
        org?.subscribedUntil != null && org.subscribedUntil > new Date();

      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const [lifetimeInvoices, monthInvoices, quotations] = await Promise.all([
        tx.invoice.count({ where: { organisationId: orgId, docType: 'invoice' } }),
        tx.invoice.count({
          where: {
            organisationId: orgId,
            docType: 'invoice',
            createdAt: { gte: monthStart },
          },
        }),
        tx.invoice.count({ where: { organisationId: orgId, docType: 'quotation' } }),
      ]);

      const used = plan.limitPeriod === 'month' ? monthInvoices : lifetimeInvoices;
      const remaining =
        plan.invoiceLimit == null ? null : Math.max(0, plan.invoiceLimit - used);

      return {
        plan: {
          id: plan.id,
          name: plan.name,
          tagline: plan.tagline,
          priceMonthly: plan.priceMonthly,
          invoiceLimit: plan.invoiceLimit,
          limitPeriod: plan.limitPeriod,
        },
        subscribed,
        subscribedUntil: org?.subscribedUntil ?? null,
        // Renewal lands on the same hour the subscription started.
        autoRenew: org?.autoRenew ?? true,
        renewsAt: subscribed && (org?.autoRenew ?? true) ? org?.subscribedUntil : null,
        usage: {
          invoicesUsed: used,
          invoicesLifetime: lifetimeInvoices,
          invoicesThisMonth: monthInvoices,
          quotations,
          limit: plan.invoiceLimit,
          remaining,
        },
        plans: Object.values(PLANS),
        currency: 'RWF',
        // How to pay: shown verbatim on the upgrade screen. The money goes
        // directly to the founder's business account; activation is manual.
        paymentInstructions: this.config.get<string>(
          'SUBSCRIPTION_INSTRUCTIONS',
          'Pay for your plan by Mobile Money or bank transfer, then send proof to support and your account is activated immediately.',
        ),
      };
    });
  }

  /** Record that a business wants to upgrade, so the owner admin shows it as
   *  a "someone wants to pay" item to activate after payment lands. */
  requestUpgrade(orgId: string, plan: string) {
    const valid = ['starter', 'business', 'enterprise'].includes(plan) ? plan : 'business';
    return this.prisma.withTenant(orgId, async (tx) => {
      await tx.upgradeRequest.upsert({
        where: { organisationId: orgId },
        update: { plan: valid, status: 'pending' },
        create: { organisationId: orgId, plan: valid, status: 'pending' },
      });
      return { requested: true, plan: valid };
    });
  }

  /** Turn monthly renewal on/off. Off = the plan simply runs out at period end. */
  setAutoRenew(orgId: string, autoRenew: boolean) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const org = await tx.organisation.update({
        where: { id: orgId },
        data: { autoRenew },
        select: { autoRenew: true, subscribedUntil: true },
      });
      return {
        autoRenew: org.autoRenew,
        subscribedUntil: org.subscribedUntil,
      };
    });
  }
}
