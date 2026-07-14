import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
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
import { escapeHtml } from '../../common/security/security.util';
import { PdfService } from '../../integrations/pdf/pdf.service';
import { effectivePlan, PLANS } from '../billing/plans';
import { PushService } from '../push/push.service';
import { parseBankLine } from '../../common/format/bank';

const REMINDER_STAGES: { stage: string; offsetDays: number }[] = [
  { stage: 'before_due', offsetDays: -3 },
  { stage: 'on_due', offsetDays: 0 },
  { stage: 'overdue_7', offsetDays: 7 },
  { stage: 'overdue_14', offsetDays: 14 },
];

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly numbers: InvoiceNumberService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly pdf: PdfService,
    private readonly push: PushService,
  ) {}

  // "Invoice viewed" pushes are throttled per invoice so a customer refreshing
  // the page doesn't spam the owner's phone.
  private lastViewPush = new Map<string, number>();

  /**
   * Enforces the plan's invoice allowance. Free: 5 invoices lifetime.
   * Starter: 50 per calendar month. Business/Enterprise: unlimited.
   * Throws 402 with everything the upgrade modal needs to render.
   */
  private async assertCanCreateInvoice(tx: Prisma.TransactionClient, orgId: string) {
    const org = await tx.organisation.findUnique({
      where: { id: orgId },
      select: { plan: true, subscribedUntil: true },
    });
    const plan = effectivePlan(org?.plan, org?.subscribedUntil);
    if (plan.invoiceLimit == null) return; // unlimited

    // Quotations don't count — only real invoices consume the allowance.
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const used = await tx.invoice.count({
      where: {
        organisationId: orgId,
        docType: 'invoice',
        ...(plan.limitPeriod === 'month' ? { createdAt: { gte: monthStart } } : {}),
      },
    });
    if (used < plan.invoiceLimit) return;

    const instructions = this.config.get<string>(
      'SUBSCRIPTION_INSTRUCTIONS',
      'Pay for your plan by Mobile Money or bank transfer, then your account is activated.',
    );
    const period = plan.limitPeriod === 'month' ? 'this month' : '';
    throw new HttpException(
      {
        statusCode: 402,
        error: 'Payment Required',
        message:
          plan.id === 'free'
            ? `You have used all ${plan.invoiceLimit} free invoices. Upgrade to keep sending invoices.`
            : `You have used all ${plan.invoiceLimit} ${plan.name} invoices ${period}. Upgrade to Business for unlimited invoices.`,
        plan: plan.id,
        used,
        limit: plan.invoiceLimit,
        // Legacy field older frontend builds read.
        freeLimit: plan.invoiceLimit,
        recommendedPlan: plan.id === 'free' ? 'starter' : 'business',
        plans: Object.values(PLANS).map((p) => ({
          id: p.id,
          name: p.name,
          priceMonthly: p.priceMonthly,
          invoiceLimit: p.invoiceLimit,
          highlighted: p.highlighted,
        })),
        subscriptionInstructions: instructions,
      },
      402,
    );
  }

  list(orgId: string, status?: string) {
    return this.prisma.withTenant(orgId, (tx) =>
      tx.invoice.findMany({
        // Scope to the org explicitly — never rely on RLS alone, since the API's
        // DB role may bypass it. status is an optional extra filter.
        where: { organisationId: orgId, ...(status ? { status } : {}) },
        // payments are needed for accurate "collected" / paid status / P&L.
        include: { customer: true, payments: true },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  get(orgId: string, id: string) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id, organisationId: orgId },
        include: { customer: true, items: true, payments: true, reminders: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');
      return invoice;
    });
  }

  // Delete a mistake before it reaches anyone: drafts and quotations only.
  // A sent invoice is immutable — the customer may already hold its link/PDF.
  async remove(orgId: string, id: string) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const inv = await tx.invoice.findFirst({
        where: { id, organisationId: orgId },
        select: { status: true, docType: true },
      });
      if (!inv) throw new NotFoundException('Invoice not found');
      const deletable = inv.status === 'draft' || inv.docType === 'quotation';
      if (!deletable) {
        throw new BadRequestException(
          'Only drafts and quotations can be deleted. Sent invoices are permanent records.',
        );
      }
      await tx.invoice.delete({ where: { id } });
      return { deleted: true };
    });
  }

  // Turn a quotation into a real invoice: gives it an INV-… number and now
  // counts toward the free limit (checked here). Retries on number collisions.
  async convertToInvoice(orgId: string, id: string) {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = await this.prisma.withTenant(orgId, async (tx) => {
          const org = await tx.organisation.findUniqueOrThrow({ where: { id: orgId } });
          const q = await tx.invoice.findFirst({
            where: { id, organisationId: orgId },
            include: { customer: true },
          });
          if (!q) throw new NotFoundException('Quotation not found');
          if (q.docType !== 'quotation') {
            throw new BadRequestException('Only quotations can be converted');
          }
          await this.assertCanCreateInvoice(tx, orgId);
          const number = await this.numbers.next(tx, orgId, attempt, 'INV');
          // Converting a quotation IS sending it: it becomes a real invoice,
          // gets a public link, and the customer is emailed the invoice.
          const updated = await tx.invoice.update({
            where: { id },
            data: {
              docType: 'invoice',
              number,
              status: 'sent',
              sentAt: q.sentAt ?? new Date(),
              publicToken: q.publicToken ?? nanoid(24),
            },
            include: { customer: true, items: true },
          });
          const hasReminders = await tx.reminder.count({ where: { invoiceId: id } });
          if (!hasReminders) {
            await this.scheduleReminders(tx, id, updated.dueDate);
          }
          return { updated, orgName: org.name };
        });

        if (result.updated.customer.email) {
          await this.sendInvoiceEmail(result.orgName, result.updated, true);
        }
        void this.push.sendToOrg(
          orgId,
          `Quotation ${result.updated.number} is now an invoice`,
          `Sent to ${result.updated.customer.name} (${formatMoney(result.updated.amountTotal, result.updated.currency)}).`,
        );
        return this.decorate(result.orgName, result.updated);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  async create(orgId: string, dto: CreateInvoiceDto) {
    const send = dto.send ?? false;

    // Retry on duplicate invoice-number collision. Earlier failed attempts can
    // leave the sequence out of sync; bumping the offset and retrying makes the
    // save reliable rather than erroring on a taken number.
    const MAX_TRIES = 5;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      try {
        const result = await this.prisma.withTenant(orgId, async (tx) => {
          // Read the org INSIDE the tenant context — RLS requires app.current_org
          // to be set, which withTenant does. Reading outside is blocked.
          const org = await tx.organisation.findUnique({ where: { id: orgId } });
          if (!org) throw new NotFoundException('Organisation not found');

          const isQuote = dto.docType === 'quotation';
          // Only real invoices consume the free allowance; quotations are free.
          if (!isQuote) await this.assertCanCreateInvoice(tx, orgId);

          const customer = await this.customers.findOrCreate(tx, orgId, dto.customer);
          const number = await this.numbers.next(
            tx, orgId, attempt, isQuote ? 'QUO' : 'INV',
          );

          // Compute totals server-side — never trust a client total.
          // subtotal -> minus flat discount -> plus tax on the discounted amount.
          const subtotal = dto.items.reduce(
            (sum, item) => sum + BigInt(item.unitAmount) * BigInt(item.quantity),
            0n,
          );
          const discount = BigInt(dto.discount ?? 0);
          const afterDiscount = subtotal > discount ? subtotal - discount : 0n;
          const taxBps = Math.round((dto.taxRate ?? 0) * 100); // percent -> basis points
          const taxAmount = (afterDiscount * BigInt(taxBps)) / 10000n;
          const amountTotal = afterDiscount + taxAmount;

          const invoice = await tx.invoice.create({
            data: {
              organisationId: orgId,
              customerId: customer.id,
              number,
              amountTotal,
              currency: (dto.currency ?? org.currency).toUpperCase(),
              dueDate: new Date(dto.dueDate),
              status: send ? 'sent' : 'draft',
              docType: isQuote ? 'quotation' : 'invoice',
              payMethods: dto.payMethods ?? 'both',
              taxRate: taxBps,
              discount,
              publicToken: send ? nanoid(24) : null,
              sentAt: send ? new Date() : null,
            },
          });

          // Write line items
          await tx.invoiceItem.createMany({
            data: dto.items.map((item) => ({
              invoiceId: invoice.id,
              description: item.description,
              quantity: item.quantity,
              unitAmount: BigInt(item.unitAmount),
            })),
          });

          // Quotations aren't payable, so no payment reminders.
          if (send && !isQuote) {
            await this.scheduleReminders(tx, invoice.id, new Date(dto.dueDate));
          }

          // Re-fetch with items and customer for the response
          const full = await tx.invoice.findUnique({
            where: { id: invoice.id },
            include: { customer: true, items: true },
          });

          return { invoice: full!, orgName: org.name };
        });

        // Email is sent outside the DB transaction so a slow provider never
        // holds a database lock. In production this becomes a queued job.
        if (result.invoice.status === 'sent' && result.invoice.customer.email) {
          await this.sendInvoiceEmail(result.orgName, result.invoice);
        }
        return this.decorate(result.orgName, result.invoice);
      } catch (e) {
        // P2002 = unique constraint violation (duplicate invoice number). Retry
        // with a higher offset. Any other error is real — rethrow immediately.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  async send(orgId: string, id: string) {
    const result = await this.prisma.withTenant(orgId, async (tx) => {
      // Read org inside withTenant — required by RLS
      const org = await tx.organisation.findUniqueOrThrow({ where: { id: orgId } });
      const existing = await tx.invoice.findFirst({
        where: { id, organisationId: orgId },
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
      return { updated, orgName: org.name };
    });

    if (result.updated.customer.email) {
      await this.sendInvoiceEmail(result.orgName, result.updated);
    }
    return this.decorate(result.orgName, result.updated);
  }

  async markPaid(orgId: string, id: string) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const invoice = await tx.invoice.findFirst({ where: { id, organisationId: orgId } });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status === 'paid') return invoice;

      await tx.payment.create({
        data: { invoiceId: id, amount: invoice.amountTotal, method: 'manual' },
      });
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

  async recordPayment(orgId: string, id: string, amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive whole number');
    }
    return this.prisma.withTenant(orgId, async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id, organisationId: orgId },
        include: { payments: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');

      const already = invoice.payments.reduce((s, p) => s + p.amount, 0n);
      const remaining = invoice.amountTotal - already;
      if (remaining <= 0n) return invoice;
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
      const updated = await tx.invoice.update({
        where: { id },
        data: fullyPaid ? { status: 'paid', paidAt: new Date() } : {},
        include: { payments: true, customer: true },
      });
      void this.push.sendToOrg(
        orgId,
        fullyPaid ? `Invoice ${invoice.number} fully paid` : `Payment recorded on ${invoice.number}`,
        `${formatMoney(BigInt(amount), invoice.currency)} received from ${updated.customer?.name ?? 'customer'}.`,
      );
      return updated;
    });
  }

  // Public invoice — no auth required. Uses a two-step approach:
  // 1. Raw SQL to get the org ID from the public token (bypasses tenant RLS)
  // 2. withTenant to fetch the full invoice safely inside the correct RLS context
  async getByPublicToken(token: string) {
    const rows = await this.prisma.$queryRaw<{ organisation_id: string }[]>`
      SELECT organisation_id FROM invoice WHERE public_token = ${token} LIMIT 1
    `;
    if (!rows.length) throw new NotFoundException('Invoice not found');
    const orgId = rows[0].organisation_id;

    return this.prisma.withTenant(orgId, async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { publicToken: token },
        include: { customer: true, items: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');
      const org = await tx.organisation.findUnique({ where: { id: orgId } });

      // Tell the business their customer opened the invoice (max 1/30min).
      const lastPush = this.lastViewPush.get(invoice.id) ?? 0;
      if (Date.now() - lastPush > 30 * 60 * 1000) {
        this.lastViewPush.set(invoice.id, Date.now());
        void this.push.sendToOrg(
          orgId,
          `${invoice.docType === 'quotation' ? 'Quotation' : 'Invoice'} ${invoice.number} was viewed`,
          `${invoice.customer.name} just opened it (${formatMoney(invoice.amountTotal, invoice.currency)}).`,
        );
      }

      return {
        ...invoice,
        amountTotal: invoice.amountTotal.toString(),
        items: (invoice.items || []).map((item: any) => ({
          ...item,
          unitAmount: item.unitAmount.toString(),
        })),
        orgName: org?.name ?? '',
        issuedBy: await this.ownerName(orgId),
        ...this.gatePay(org, invoice.payMethods),
        // Online checkout ("Pay Now") is live only once a payment provider is
        // configured; paying the business directly by MoMo/bank is always free.
        payOnline: this.payOnline(),
        payUrl: this.payOnline()
          ? `${this.config.get<string>('API_PUBLIC_URL', 'https://klipa-api-production.up.railway.app')}/v1/invoices/public/${token}/pay`
          : null,
      };
    });
  }

  private payOnline(): boolean {
    return Boolean(this.config.get<string>('FLW_SECRET_KEY'));
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
      // Serialize BigInt fields inside items so JSON.stringify doesn't throw
      items: (invoice.items || []).map((item: any) => ({
        ...item,
        unitAmount: item.unitAmount.toString(),
      })),
      public_link: link,
      whatsapp_share_text: link
        ? this.whatsappText(businessName, invoice, invoice.customer.name, link)
        : null,
    };
  }

  private async sendInvoiceEmail(businessName: string, invoice: any, converted = false) {
    const link = this.publicLink(invoice.publicToken);
    const amount = formatMoney(invoice.amountTotal, invoice.currency);
    // Best-effort: the invoice is already saved. A misconfigured or failing
    // email provider must never turn a successful invoice into a 500 — log it
    // and move on so the user keeps their record and can resend later.
    // How the customer pays this business, respecting the method chosen for
    // THIS invoice (momo | bank | both), plus branding for the PDF.
    const org = await this.prisma.organisation.findUnique({
      where: { id: invoice.organisationId },
      select: { momoCode: true, bankAccount: true, logoUrl: true, signatureUrl: true, stampUrl: true },
    });
    const pay = this.gatePay(org, invoice.payMethods);
    const issuedBy = await this.ownerName(invoice.organisationId);
    try {
      // Attach the PDF invoice. PDF failure must not block the email, so it's
      // generated defensively and simply omitted if it throws.
      let attachments;
      try {
        const pdf = await this.buildInvoicePdf(businessName, invoice, link, {
          ...pay,
          logoUrl: org?.logoUrl,
          signatureUrl: org?.signatureUrl,
          stampUrl: org?.stampUrl,
          issuedBy,
        });
        attachments = [{ filename: `invoice-${invoice.number}.pdf`, content: pdf }];
      } catch (pdfErr) {
        this.logger.warn(
          `PDF for invoice ${invoice.number} failed: ${
            pdfErr instanceof Error ? pdfErr.message : pdfErr
          }`,
        );
      }

      // Escape all user-entered values before HTML interpolation.
      const eBiz = escapeHtml(businessName);
      const eCust = escapeHtml(invoice.customer.name);
      const bankHtml = parseBankLine(pay?.bankAccount)
        .map((b) => `<p style="margin:2px 0">${escapeHtml(b.label)}: <strong>${escapeHtml(b.value)}</strong></p>`)
        .join('');
      const payHtml =
        pay?.momoCode || pay?.bankAccount
          ? `<div style="margin:16px 0;padding:14px 16px;background:#EEF3F9;border-radius:8px">
               <p style="margin:0 0 6px;font-weight:bold;color:#0F172A">How to pay ${eBiz}</p>
               ${pay.momoCode ? `<p style="margin:2px 0">Mobile Money: <strong>${escapeHtml(pay.momoCode)}</strong></p>` : ''}
               ${bankHtml}
             </div>`
          : '';

      const intro = converted
        ? `<p>Your quotation from ${eBiz} has been accepted and is now invoice
           <strong>${escapeHtml(invoice.number)}</strong> for <strong>${amount}</strong>,
           due ${invoice.dueDate.toISOString().slice(0, 10)}.</p>`
        : `<p>${eBiz} has sent you invoice <strong>${escapeHtml(invoice.number)}</strong>
           for <strong>${amount}</strong>, due ${invoice.dueDate.toISOString().slice(0, 10)}.</p>`;
      await this.email.send({
        to: invoice.customer.email,
        subject: converted
          ? `Invoice ${invoice.number} from ${businessName} (from your quotation)`
          : `Invoice ${invoice.number} from ${businessName}`,
        html: `
        <p>Hi ${eCust},</p>
        ${intro}
        ${payHtml}
        <p>Your invoice is attached as a PDF. You can also
        <a href="${link}">view it online</a>.</p>
        <p style="color:#64748B;font-size:12px;margin-top:18px;border-top:1px solid #E2E8F0;padding-top:10px">
          Run a business too? This invoice was made with
          <a href="https://klipwa.app/?ref=email" style="color:#1565E0">Klipwa</a> in 30 seconds.
          Your first 5 invoices are free.</p>
      `,
        attachments,
      });
    } catch (err) {
      this.logger.warn(
        `Invoice ${invoice.number} saved but email to ${invoice.customer.email} failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  // Builds the PDF for an invoice object that already has `customer`; line items
  // are loaded here if not already included (the send-path object omits them).
  // Which of the saved payout methods this invoice shows.
  private gatePay(
    org: { momoCode?: string | null; bankAccount?: string | null } | null,
    payMethods?: string | null,
  ) {
    const m = payMethods ?? 'both';
    return {
      momoCode: m !== 'bank' ? org?.momoCode ?? null : null,
      bankAccount: m !== 'momo' ? org?.bankAccount ?? null : null,
    };
  }

  // The business owner's name, shown as "Issued by" on the invoice.
  private async ownerName(orgId: string): Promise<string | null> {
    const owner = await this.prisma.membership.findFirst({
      where: { organisationId: orgId, role: 'owner' },
      include: { user: { select: { fullName: true } } },
    });
    return owner?.user.fullName ?? null;
  }

  private async buildInvoicePdf(
    businessName: string,
    invoice: any,
    link: string | null,
    pay: {
      momoCode?: string | null; bankAccount?: string | null;
      logoUrl?: string | null; signatureUrl?: string | null; stampUrl?: string | null;
      issuedBy?: string | null;
    } | null = null,
  ): Promise<Buffer> {
    const items =
      invoice.items ??
      (await this.prisma.invoiceItem.findMany({ where: { invoiceId: invoice.id } }));
    const discount = BigInt(invoice.discount ?? 0);
    const subtotal = items.reduce(
      (s: bigint, it: any) => s + BigInt(it.unitAmount) * BigInt(it.quantity),
      0n,
    );
    const taxAmount = BigInt(invoice.amountTotal) - (subtotal - discount);
    const isQuote = invoice.docType === 'quotation';
    return this.pdf.invoicePdf({
      number: invoice.number,
      issuedDate: invoice.sentAt ?? invoice.createdAt ?? new Date(),
      dueDate: new Date(invoice.dueDate),
      currency: invoice.currency,
      status: invoice.status,
      businessName,
      customerName: invoice.customer.name,
      customerEmail: invoice.customer.email,
      items: items.map((it: any) => ({
        description: it.description,
        quantity: it.quantity,
        unitAmount: BigInt(it.unitAmount),
      })),
      total: BigInt(invoice.amountTotal),
      publicLink: link,
      momoCode: pay?.momoCode ?? null,
      bankAccount: pay?.bankAccount ?? null,
      logoUrl: pay?.logoUrl ?? null,
      signatureUrl: pay?.signatureUrl ?? null,
      stampUrl: pay?.stampUrl ?? null,
      issuedBy: pay?.issuedBy ?? null,
      docLabel: isQuote ? 'QUOTATION' : 'INVOICE',
      discount: discount > 0n ? discount : undefined,
      taxAmount: taxAmount > 0n ? taxAmount : undefined,
      taxRatePercent: invoice.taxRate ? invoice.taxRate / 100 : undefined,
    });
  }

  // Renders the public PDF for a shared invoice link (no auth; token is the key).
  async getPublicPdf(token: string): Promise<{ buffer: Buffer; number: string }> {
    const rows = await this.prisma.$queryRaw<{ organisation_id: string }[]>`
      SELECT organisation_id FROM invoice WHERE public_token = ${token} LIMIT 1
    `;
    if (!rows.length) throw new NotFoundException('Invoice not found');
    const orgId = rows[0].organisation_id;

    return this.prisma.withTenant(orgId, async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { publicToken: token },
        include: { customer: true, items: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');
      const org = await tx.organisation.findUnique({ where: { id: orgId } });
      const buffer = await this.buildInvoicePdf(
        org?.name ?? '',
        invoice,
        this.publicLink(token),
        {
          ...this.gatePay(org, invoice.payMethods),
          logoUrl: org?.logoUrl,
          signatureUrl: org?.signatureUrl,
          stampUrl: org?.stampUrl,
          issuedBy: await this.ownerName(orgId),
        },
      );
      return { buffer, number: invoice.number };
    });
  }
}
