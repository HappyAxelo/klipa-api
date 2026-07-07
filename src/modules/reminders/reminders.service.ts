import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/database/prisma.service';
import { EmailService } from '../../integrations/email/email.service';
import { PushService } from '../push/push.service';
import { formatMoney } from '../../common/money/money';
import { escapeHtml } from '../../common/security/security.util';

/**
 * Sends the reminders that invoices schedule into the DB (before-due, on-due,
 * overdue). Runs hourly: any reminder whose time has passed and whose invoice
 * is still unpaid gets emailed to the customer, then marked sent.
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly push: PushService,
  ) {}

  // Keep invoice status accurate without anyone touching it: unpaid invoices
  // become "overdue" once past due, and "due_soon" within 3 days. Paid/draft
  // are never changed. Runs before the reminder pass each hour.
  @Cron(CronExpression.EVERY_HOUR)
  async syncStatuses(): Promise<void> {
    // Capture which invoices are ABOUT to flip so their owners get one push.
    const flipping = await this.prisma.$queryRaw<
      { id: string; organisation_id: string; number: string; amount_total: bigint; currency: string; name: string }[]
    >`select i.id, i.organisation_id, i.number, i.amount_total, i.currency, c.name
       from invoice i join customer c on c.id = i.customer_id
       where i.status in ('sent', 'due_soon') and i.due_date < current_date limit 100`;
    await this.prisma.$executeRaw`
      update invoice set status = 'overdue'
      where status in ('sent', 'due_soon') and due_date < current_date`;
    for (const inv of flipping) {
      void this.push.sendToOrg(
        inv.organisation_id,
        `Invoice ${inv.number} is now overdue`,
        `${inv.name} has not paid ${formatMoney(BigInt(inv.amount_total), inv.currency)}. A reminder is being sent.`,
      );
    }
    await this.prisma.$executeRaw`
      update invoice set status = 'due_soon'
      where status = 'sent'
        and due_date >= current_date and due_date <= current_date + 3`;
  }

  @Cron(CronExpression.EVERY_HOUR)
  async dispatchDue(): Promise<number> {
    await this.syncStatuses();
    const now = new Date();
    const due = await this.prisma.reminder.findMany({
      where: { status: 'scheduled', scheduledFor: { lte: now } },
      orderBy: { scheduledFor: 'asc' },
      take: 200,
      include: { invoice: { include: { customer: true, organisation: true } } },
    });
    if (!due.length) return 0;
    this.logger.log(`Dispatching ${due.length} due reminder(s)`);

    const ownerEmailCache = new Map<string, string | null>();
    for (const r of due) {
      try {
        const inv: any = r.invoice;
        if (!inv || inv.status === 'paid') {
          await this.set(r.id, 'skipped');
          continue;
        }
        // The owner can switch reminders off for their business.
        if (inv.organisation && inv.organisation.remindersEnabled === false) {
          await this.set(r.id, 'skipped');
          continue;
        }
        if (!inv.customer?.email) {
          await this.set(r.id, 'skipped');
          continue;
        }
        // 1) Remind the customer (the payer).
        await this.email.send(this.buildEmail(r.stage, inv));
        // 2) Remind the business owner (the payee) at the email they signed
        //    up with, so they know to follow up. Best-effort, never blocks.
        const ownerEmail = await this.ownerEmail(inv.organisationId, ownerEmailCache);
        if (ownerEmail) {
          try { await this.email.send(this.buildOwnerEmail(r.stage, inv, ownerEmail)); } catch { /* best-effort */ }
        }
        await this.set(r.id, 'sent', now);
      } catch (e) {
        this.logger.warn(
          `Reminder ${r.id} failed: ${e instanceof Error ? e.message : e}`,
        );
        await this.set(r.id, 'failed');
      }
    }
    return due.length;
  }

  private set(id: string, status: string, sentAt?: Date) {
    return this.prisma.reminder.update({
      where: { id },
      data: { status, ...(sentAt ? { sentAt } : {}) },
    });
  }

  // The owner's email (the payee) for this org, cached for the run.
  private async ownerEmail(
    orgId: string,
    cache: Map<string, string | null>,
  ): Promise<string | null> {
    if (cache.has(orgId)) return cache.get(orgId)!;
    const owner = await this.prisma.membership.findFirst({
      where: { organisationId: orgId, role: 'owner' },
      include: { user: { select: { email: true } } },
    });
    const email = owner?.user.email ?? null;
    cache.set(orgId, email);
    return email;
  }

  // The copy that goes to the business owner: "your customer owes you".
  private buildOwnerEmail(stage: string, inv: any, to: string) {
    const business = inv.organisation?.name || 'your business';
    const amount = formatMoney(inv.amountTotal, inv.currency);
    const due = new Date(inv.dueDate).toISOString().slice(0, 10);
    const overdue = stage === 'overdue_7' || stage === 'overdue_14';
    const dueToday = stage === 'on_due';
    const cust = escapeHtml(inv.customer?.name || 'Your customer');
    const base = this.config.get<string>('PUBLIC_APP_URL', 'https://klipwa.app');
    const link = inv.publicToken ? `${base}/i/${inv.publicToken}` : null;
    const subject = overdue
      ? `Action needed: ${inv.customer?.name || 'a customer'} is overdue on ${inv.number}`
      : dueToday
        ? `${inv.customer?.name || 'A customer'} owes you ${amount} today (${inv.number})`
        : `Reminder: ${inv.number} to ${inv.customer?.name || 'a customer'} is due soon`;
    const lead = overdue
      ? `Invoice <strong>${inv.number}</strong> to ${cust} is overdue.`
      : dueToday
        ? `Invoice <strong>${inv.number}</strong> to ${cust} is due today.`
        : `Invoice <strong>${inv.number}</strong> to ${cust} is due on ${due}.`;
    return {
      to,
      subject,
      html: `
        <p>Hi,</p>
        <p>${lead}</p>
        <p>Amount: <strong>${amount}</strong> · Due: ${due}</p>
        <p>We have reminded ${cust} by email. You may want to follow up too.</p>
        ${link ? `<p><a href="${link}">View the invoice</a></p>` : ''}
        <p style="color:#64748B;font-size:12px">You are getting this because reminders are on for ${escapeHtml(business)}. Turn them off in Klipwa &gt; Settings &gt; Notifications.</p>
      `,
    };
  }

  private buildEmail(stage: string, inv: any) {
    const org = inv.organisation;
    const business = org?.name || 'Your supplier';
    const amount = formatMoney(inv.amountTotal, inv.currency);
    const due = new Date(inv.dueDate).toISOString().slice(0, 10);
    const overdue = stage === 'overdue_7' || stage === 'overdue_14';
    const dueToday = stage === 'on_due';

    const subject = overdue
      ? `Overdue: invoice ${inv.number} from ${business}`
      : dueToday
        ? `Invoice ${inv.number} from ${business} is due today`
        : `Reminder: invoice ${inv.number} from ${business} is due soon`;

    const lead = overdue
      ? `This is a reminder that invoice <strong>${inv.number}</strong> is overdue.`
      : dueToday
        ? `This is a reminder that invoice <strong>${inv.number}</strong> is due today.`
        : `This is a friendly reminder that invoice <strong>${inv.number}</strong> is due on ${due}.`;

    const base = this.config.get<string>('PUBLIC_APP_URL', 'https://klipwa.netlify.app');
    const link = inv.publicToken ? `${base}/i/${inv.publicToken}` : null;

    // Escape all user-entered values before HTML interpolation.
    const eBiz = escapeHtml(business);
    const pay =
      org?.momoCode || org?.bankAccount
        ? `<div style="margin:16px 0;padding:14px 16px;background:#EEF3F9;border-radius:8px">
             <p style="margin:0 0 6px;font-weight:bold">How to pay ${eBiz}</p>
             ${org.momoCode ? `<p style="margin:2px 0">Mobile Money: <strong>${escapeHtml(org.momoCode)}</strong></p>` : ''}
             ${org.bankAccount ? `<p style="margin:2px 0">Bank: <strong>${escapeHtml(org.bankAccount)}</strong></p>` : ''}
           </div>`
        : '';

    return {
      to: inv.customer.email,
      subject,
      html: `
        <p>Hi ${escapeHtml(inv.customer.name)},</p>
        <p>${lead}</p>
        <p>Amount due: <strong>${amount}</strong> · Due: ${due}</p>
        ${pay}
        ${link ? `<p><a href="${link}">View your invoice</a></p>` : ''}
        <p style="color:#64748B;font-size:12px">Sent by ${eBiz} via K-Lipwa.</p>
      `,
    };
  }
}
