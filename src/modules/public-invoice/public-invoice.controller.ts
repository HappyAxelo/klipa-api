import { Controller, Get, Injectable, NotFoundException, Param } from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service';
import { formatMoney } from '../../common/money/money';

@Injectable()
export class PublicInvoiceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Looked up by random token, not by id, and not behind auth. Returns only
   * what the customer needs to see — never the business's other data.
   * Uses the base client because there is no logged-in org context here;
   * the unguessable 24-char token is the access control.
   */
  async byToken(token: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { publicToken: token },
      include: {
        customer: { select: { name: true } },
        organisation: {
          select: {
            name: true,
            logoUrl: true,
            currency: true,
            momoCode: true,
            bankAccount: true,
          },
        },
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    return {
      number: invoice.number,
      status: invoice.status,
      amount: formatMoney(invoice.amountTotal, invoice.currency),
      amount_raw: invoice.amountTotal.toString(),
      currency: invoice.currency,
      due_date: invoice.dueDate.toISOString().slice(0, 10),
      description: invoice.description,
      business: {
        name: invoice.organisation.name,
        logo_url: invoice.organisation.logoUrl,
        momo_code: invoice.organisation.momoCode,
        bank_account: invoice.organisation.bankAccount,
      },
      billed_to: invoice.customer.name,
    };
  }
}

@Controller('v1/public/invoice')
export class PublicInvoiceController {
  constructor(private readonly service: PublicInvoiceService) {}

  @Get(':token')
  byToken(@Param('token') token: string) {
    return this.service.byToken(token);
  }
}
