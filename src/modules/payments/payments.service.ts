import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/database/prisma.service';

const ZERO_DECIMAL = ['RWF', 'UGX', 'XOF', 'XAF'];

/**
 * Flutterwave hosted-checkout payments. Flow:
 *  1. Customer opens the "Pay now" link  -> GET /v1/invoices/public/:token/pay
 *     which redirects to a Flutterwave hosted checkout (Mobile Money / card).
 *  2. Flutterwave calls our webhook on success; we re-verify the transaction
 *     server-side, then mark the invoice paid (idempotent on the gateway tx id).
 *
 * Inert until FLW_SECRET_KEY is set, so it is safe to deploy before keys exist.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  enabled(): boolean {
    return Boolean(this.config.get<string>('FLW_SECRET_KEY'));
  }

  private apiBase(): string {
    return this.config.get<string>(
      'API_PUBLIC_URL',
      'https://klipa-api-production.up.railway.app',
    );
  }

  private appInvoiceUrl(token: string, status?: string): string {
    const base = this.config.get<string>('PUBLIC_APP_URL', 'https://klipwa.netlify.app');
    return `${base}/i/${token}${status ? `?status=${status}` : ''}`;
  }

  /** "Pay now" link the email/PDF should use, or null when payments are off. */
  payLink(token: string): string | null {
    return this.enabled() ? `${this.apiBase()}/v1/invoices/public/${token}/pay` : null;
  }

  /** Resolve where a "Pay now" click should go (hosted checkout, or a status page). */
  async checkoutRedirect(token: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ organisation_id: string }[]>`
      SELECT organisation_id FROM invoice WHERE public_token = ${token} LIMIT 1`;
    if (!rows.length) throw new NotFoundException('Invoice not found');
    const orgId = rows[0].organisation_id;

    const { inv, orgName } = await this.prisma.withTenant(orgId, async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { publicToken: token },
        include: { customer: true, payments: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');
      const org = await tx.organisation.findUnique({ where: { id: orgId } });
      return { inv: invoice, orgName: org?.name ?? 'Invoice' };
    });

    if (inv.status === 'paid') return this.appInvoiceUrl(token, 'paid');
    if (!this.enabled()) return this.appInvoiceUrl(token, 'unavailable');

    const alreadyPaid = inv.payments.reduce((s, p) => s + p.amount, 0n);
    const outstanding = inv.amountTotal - alreadyPaid;
    if (outstanding <= 0n) return this.appInvoiceUrl(token, 'paid');

    const amount = this.toMajor(outstanding, inv.currency);
    const txRef = `klipa_${inv.id}_${Date.now()}`;

    try {
      const res = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.getOrThrow<string>('FLW_SECRET_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tx_ref: txRef,
          amount,
          currency: inv.currency,
          redirect_url: `${this.apiBase()}/v1/payments/return?token=${token}`,
          customer: {
            email: inv.customer.email ?? 'noemail@klipwa.app',
            name: inv.customer.name,
          },
          meta: { invoice_id: inv.id, token },
          customizations: {
            title: orgName,
            description: `Invoice ${inv.number}`,
          },
        }),
      });
      const body: any = await res.json();
      if (!res.ok || body?.status !== 'success' || !body?.data?.link) {
        this.logger.warn(`Flutterwave init failed (${res.status}): ${JSON.stringify(body)}`);
        return this.appInvoiceUrl(token, 'error');
      }
      return body.data.link as string;
    } catch (err) {
      this.logger.warn(`Flutterwave init error: ${err instanceof Error ? err.message : err}`);
      return this.appInvoiceUrl(token, 'error');
    }
  }

  /** Where Flutterwave sends the customer back after checkout. */
  returnRedirect(token: string, status?: string): string {
    return this.appInvoiceUrl(token, status === 'successful' ? 'paid' : status);
  }

  /** Process a Flutterwave webhook: verify, re-confirm, mark paid (idempotent). */
  async handleWebhook(signature: string | undefined, payload: any): Promise<void> {
    const expected = this.config.get<string>('FLW_WEBHOOK_HASH');
    if (!expected || signature !== expected) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    if (payload?.event !== 'charge.completed' || !payload?.data?.id) return;

    // Never trust the webhook body — re-verify the transaction with Flutterwave.
    const res = await fetch(
      `https://api.flutterwave.com/v3/transactions/${payload.data.id}/verify`,
      { headers: { Authorization: `Bearer ${this.config.getOrThrow<string>('FLW_SECRET_KEY')}` } },
    );
    const verify: any = await res.json();
    const tx = verify?.data;
    if (verify?.status !== 'success' || tx?.status !== 'successful') return;

    const invoiceId = String(tx.tx_ref ?? '').split('_')[1];
    if (!invoiceId) return;
    await this.markPaid(invoiceId, tx);
  }

  private async markPaid(invoiceId: string, tx: any): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      { organisation_id: string; currency: string; amount_total: bigint; status: string }[]
    >`SELECT organisation_id, currency, amount_total, status
        FROM invoice WHERE id = ${invoiceId}::uuid LIMIT 1`;
    if (!rows.length) return;
    const { organisation_id: orgId, currency, amount_total } = rows[0];
    const amountTotal = BigInt(amount_total);

    const expected = this.toMajor(amountTotal, currency);
    if (String(tx.currency) !== currency || Number(tx.amount) + 0.5 < expected) {
      this.logger.warn(
        `Payment mismatch for invoice ${invoiceId}: got ${tx.amount} ${tx.currency}, expected ${expected} ${currency}`,
      );
      return;
    }

    const providerRef = String(tx.id);
    const method = tx.payment_type === 'card' ? 'card' : 'mobile_money';

    await this.prisma.withTenant(orgId, async (t) => {
      const existing = await t.payment.findFirst({ where: { providerRef } });
      if (existing) return; // idempotent — webhook may fire more than once
      await t.payment.create({
        data: { invoiceId, amount: amountTotal, method, providerRef },
      });
      await t.reminder.updateMany({
        where: { invoiceId, status: 'scheduled' },
        data: { status: 'skipped' },
      });
      await t.invoice.update({
        where: { id: invoiceId },
        data: { status: 'paid', paidAt: new Date() },
      });
    });
    this.logger.log(`Invoice ${invoiceId} marked paid via Flutterwave tx ${providerRef}`);
  }

  // Gateways take the major unit (RWF 5,000 -> 5000; USD 5,000 cents -> 50.00).
  private toMajor(minor: bigint, currency: string): number {
    return ZERO_DECIMAL.includes(currency) ? Number(minor) : Number(minor) / 100;
  }
}
