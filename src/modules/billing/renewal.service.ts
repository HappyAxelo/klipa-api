import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/database/prisma.service';
import { EmailService } from '../../integrations/email/email.service';
import { escapeHtml } from '../../common/security/security.util';
import { effectivePlan } from './plans';

/**
 * Anniversary renewals. A subscription always expires at the exact hour it
 * started (activateSubscription extends from subscribedUntil, preserving the
 * time of day). This worker runs hourly and, for orgs with autoRenew on:
 *
 *  - ~3 days before expiry: emails the owner a renewal payment request.
 *  - At/just after expiry: emails a final notice. Access pauses by itself the
 *    moment subscribedUntil passes (every limit check compares to now()).
 *
 * When a payment provider that can charge a stored method is connected, the
 * charge happens here instead of the email. One notice per billing cycle is
 * enforced with lastRenewalNoticeAt.
 */
@Injectable()
export class RenewalService {
  private readonly logger = new Logger(RenewalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async run(): Promise<void> {
    const now = new Date();
    const soon = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
    const graceFloor = new Date(now.getTime() - 24 * 3600 * 1000);

    // Orgs whose paid period ends within 3 days, or ended within the last day.
    const due = await this.prisma.organisation.findMany({
      where: {
        autoRenew: true,
        subscribedUntil: { not: null, gt: graceFloor, lt: soon },
      },
      select: {
        id: true,
        name: true,
        plan: true,
        subscribedUntil: true,
        lastRenewalNoticeAt: true,
      },
    });

    for (const org of due) {
      // One notice per cycle: skip if we already notified after the previous
      // cycle's 3-day window opened.
      const windowOpen = new Date(org.subscribedUntil!.getTime() - 3 * 24 * 3600 * 1000);
      if (org.lastRenewalNoticeAt && org.lastRenewalNoticeAt >= windowOpen) continue;

      try {
        await this.notify(org.id, org.name, org.plan, org.subscribedUntil!);
        await this.prisma.organisation.update({
          where: { id: org.id },
          data: { lastRenewalNoticeAt: now },
        });
      } catch (e) {
        this.logger.warn(
          `Renewal notice for org ${org.id} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  private async notify(orgId: string, orgName: string, planId: string, until: Date) {
    // The owner gets the renewal email.
    const owner = await this.prisma.membership.findFirst({
      where: { organisationId: orgId, role: 'owner' },
      include: { user: { select: { email: true, fullName: true } } },
    });
    if (!owner?.user.email) return;

    const plan = effectivePlan(planId, until);
    const instructions = this.config.get<string>(
      'SUBSCRIPTION_INSTRUCTIONS',
      'Pay by Mobile Money or bank transfer, then your plan is extended immediately.',
    );
    const when = until.toLocaleString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const price =
      plan.priceMonthly > 0 ? `RWF ${plan.priceMonthly.toLocaleString('en-RW')}` : '';
    const expired = until <= new Date();

    await this.email.send({
      to: owner.user.email,
      subject: expired
        ? `Your Klipwa ${plan.name} plan has expired`
        : `Your Klipwa ${plan.name} plan renews on ${when}`,
      html: `
        <p>Hi ${escapeHtml(owner.user.fullName || '')},</p>
        <p>The <strong>${escapeHtml(plan.name)}</strong> plan for
        <strong>${escapeHtml(orgName)}</strong> ${expired ? 'expired' : 'renews'} on
        <strong>${escapeHtml(when)}</strong>${price ? ` (${price}/month)` : ''}.</p>
        <p>${escapeHtml(instructions)}</p>
        <p>${expired
          ? 'Invoicing is paused until the renewal payment arrives. Your data is safe and nothing is deleted.'
          : 'Pay before then and your plan continues without interruption, always renewing at this same time.'}</p>
        <p>To stop renewing, open Klipwa &gt; Billing &amp; Subscription and turn off renewal.</p>
      `,
    });
    this.logger.log(`Renewal notice sent for org ${orgId} (${expired ? 'expired' : 'upcoming'})`);
  }
}
