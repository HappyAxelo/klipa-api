import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { PrismaService } from '../../common/database/prisma.service';
import { CustomersService } from '../customers/customers.service';
import { EmailService } from '../../integrations/email/email.service';
import { InvoiceNumberService } from './invoice-number.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { formatMoney } from '../../common/money/money';

const REMINDER_STAGES: { stage: string; offsetDays: number }[] = [
  { stage: 'before_due', offsetDays: -3 },
  { stage: 'on_due', offsetDays: 0 },
  { stage: 'overdue_7', offsetDays: 7 },
  { stage: 'overdue_14', offsetDays: 14 },
];

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly numbers: InvoiceNumberService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  list(orgId: string, status?: string) {
    return this.prisma.withTenant(orgId, (tx) =>
      tx.invoice.findMany({
        where: status ? { status } : undefined,
        include: { customer: true },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  get(orgId: string, id: string) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { id },
        include: { customer: true, items: true, payments: true, reminders: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');
      return invoice;
    });
  }

  async create(orgId: string, dto: CreateInvoiceDto) {
    const org = await this.prisma.organisation.findUnique({
      where: { id: orgId },
    });
    if (!org) throw new NotFoundException('Organisation not found');

    const result = await this.prisma.withTenant(orgId, async (tx) => {
      const customer = await this.customers.findOrCreate(tx, orgId, dto.customer);
      const number = await this.numbers.next(tx, orgId);
      const send = dto.send ?? false;

      const invoice = await tx.invoice.create({
        data: {
          organisationId: orgId,
          customerId: customer.id,
          number,
          amountTotal: BigInt(dto.amount),
          currency: org.currency,
          dueDate: new Date(dto.dueDate),
          description: dto.description ?? null,
          status: send ? 'sent' : 'draft',
          publicToken: send ? nanoid(24) : null,
          sentAt: send ? new Date() : null,
        },
        include: { customer: true },
      });

      if (send) {
        await this.scheduleReminders(tx, invoice.id, invoice.dueDate);
      }
      return invoice;
    });

    // Email is sent outside the DB transaction so a slow provider never holds
    // a database lock. In production this becomes a queued job.
    if (result.status === 'sent' && result.customer.email) {
      await this.sendInvoiceEmail(org.name, result);
    }

    return this.decorate(org.name, result);
  }

  async send(orgId: string, id: string) {
    const org = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: orgId },
    });

    const invoice = await this.prisma.withTenant(orgId, async (tx) => {
      const existing = await tx.invoice.findUnique({
        where: { id },
        include: { customer: true },
      });
      if (!existing) throw new NotFoundException('Invoice not found');
      if (existing.status === 'paid') {
        throw new BadRequestException('Invoice is already paid');
      }

      const updated = await tx.invoice.update({
        where: { id },
        data: {
          status: 'sent',
          sentAt: existing.sentAt ?? new Date(),
          publicToken: existing.publicToken ?? nanoid(24),
        },
        include: { customer: true },
      });

      const hasReminders = await tx.reminder.count({ where: { invoiceId: id } });
      if (!hasReminders) {
        await this.scheduleReminders(tx, id, updated.dueDate);
      }
      return updated;
    });

    if (invoice.customer.email) {
      await this.sendInvoiceEmail(org.name, invoice);
    }
    return this.decorate(org.name, invoice);
  }

  async markPaid(orgId: string, id: string) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const invoice = await tx.invoice.findUnique({ where: { id } });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status === 'paid') return invoice;

      await tx.payment.create({
        data: { invoiceId: id, amount: invoice.amountTotal, method: 'manual' },
      });
      // Future Mobile Money writes to the same payment table — no change here.
      await tx.reminder.updateMany({
        where: { invoiceId: id, status: 'scheduled' },
        data: { status: 'skipped' },
      });
      return tx.invoice.update({
        where: { id },
        data: { status: 'paid', paidAt: new Date() },
      });
    });
  }

  // Record a payment of any amount (supports partial / instalment payments).
  // The invoice flips to 'paid' only once the total received reaches the amount.
  async recordPayment(orgId: string, id: string, amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive whole number');
    }
    return this.prisma.withTenant(orgId, async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { id },
        include: { payments: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');

      const already = invoice.payments.reduce((s, p) => s + p.amount, 0n);
      const remaining = invoice.amountTotal - already;
      if (remaining <= 0n) return invoice; // already settled
      if (BigInt(amount) > remaining) {
        throw new BadRequestException('Amount exceeds the outstanding balance');
      }

      await tx.payment.create({
        data: { invoiceId: id, amount: BigInt(amount), method: 'manual' },
      });

      const fullyPaid = already + BigInt(amount) >= invoice.amountTotal;
      if (fullyPaid) {
        await tx.reminder.updateMany({
          where: { invoiceId: id, status: 'scheduled' },
          data: { status: 'skipped' },
        });
      }
      return tx.invoice.update({
        where: { id },
        data: fullyPaid ? { status: 'paid', paidAt: new Date() } : {},
        include: { payments: true, customer: true },
      });
    });
  }

  // --- helpers ---

  private scheduleReminders(
    tx: Prisma.TransactionClient,
    invoiceId: string,
    dueDate: Date,
  ) {
    const rows = REMINDER_STAGES.map(({ stage, offsetDays }) => {
      const when = new Date(dueDate);
      when.setDate(when.getDate() + offsetDays);
      return {
        invoiceId,
        stage,
        channel: 'email',
        status: when > new Date() || offsetDays >= 0 ? 'scheduled' : 'skipped',
        scheduledFor: when,
      };
    });
    return tx.reminder.createMany({ data: rows });
  }

  private publicLink(token: string): string {
    const base = this.config.get<string>('PUBLIC_APP_URL', 'https://k-lipa.rw');
    return `${base}/i/${token}`;
  }

  private whatsappText(
    businessName: string,
    invoice: { number: string; amountTotal: bigint; currency: string; dueDate: Date },
    customerName: string,
    link: string,
  ): string {
    const amount = formatMoney(invoice.amountTotal, invoice.currency);
    const due = invoice.dueDate.toISOString().slice(0, 10);
    return `Hi ${customerName}, here is your invoice ${invoice.number} from ${businessName} for ${amount}, due ${due}. View it here: ${link}`;
  }

  private decorate(businessName: string, invoice: any) {
    const link = invoice.publicToken ? this.publicLink(invoice.publicToken) : null;
    return {
      ...invoice,
      amountTotal: invoice.amountTotal.toString(),
      public_link: link,
      whatsapp_share_text: link
        ? this.whatsappText(businessName, invoice, invoice.customer.name, link)
        : null,
    };
  }

  private async sendInvoiceEmail(businessName: string, invoice: any) {
    const link = this.publicLink(invoice.publicToken);
    const amount = formatMoney(invoice.amountTotal, invoice.currency);
    await this.email.send({
      to: invoice.customer.email,
      subject: `Invoice ${invoice.number} from ${businessName}`,
      html: `
        <p>Hi ${invoice.customer.name},</p>
        <p>${businessName} has sent you invoice <strong>${invoice.number}</strong>
        for <strong>${amount}</strong>, due ${invoice.dueDate
        .toISOString()
        .slice(0, 10)}.</p>
        <p><a href="${link}">View your invoice</a></p>
      `,
    });
  }
}
