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

    for (const r of due) {
      try {
        const inv: any = r.invoice;
        if (!inv || inv.status === 'paid') {
          await this.set(r.id, 'skipped');
          continue;
        }
        if (!inv.customer?.email) {
          await this.set(r.id, 'skipped');
          continue;
        }
        await this.email.send(this.buildEmail(r.stage, inv));
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
