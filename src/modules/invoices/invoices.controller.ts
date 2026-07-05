import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/auth/supabase.guard';
import { CurrentOrg } from '../../common/auth/current-user.decorator';
import { InvoicesService } from './invoices.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { jsonSafe } from '../../common/money/money';

// Public routes — no auth guard
@Controller('v1/invoices')
export class InvoicesPublicController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get('public/:token')
  async getPublicInvoice(@Param('token') token: string) {
    return jsonSafe(await this.invoices.getByPublicToken(token));
  }

  // Downloadable / inline PDF for the shared link.
  @Get('public/:token/pdf')
  async getPublicInvoicePdf(@Param('token') token: string) {
    const { buffer, number } = await this.invoices.getPublicPdf(token);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `inline; filename="invoice-${number}.pdf"`,
    });
  }
}

@Controller('v1/invoices')
@UseGuards(SupabaseAuthGuard)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  async list(@CurrentOrg() orgId: string, @Query('status') status?: string) {
    return jsonSafe(await this.invoices.list(orgId, status));
  }

  @Post()
  async create(@CurrentOrg() orgId: string, @Body() dto: CreateInvoiceDto) {
    return jsonSafe(await this.invoices.create(orgId, dto));
  }

  @Get(':id')
  async get(@CurrentOrg() orgId: string, @Param('id') id: string) {
    return jsonSafe(await this.invoices.get(orgId, id));
  }

  @Post(':id/send')
  async send(@CurrentOrg() orgId: string, @Param('id') id: string) {
    return jsonSafe(await this.invoices.send(orgId, id));
  }

  // Drafts and quotations only; sent invoices are permanent.
  @Delete(':id')
  async remove(@CurrentOrg() orgId: string, @Param('id') id: string) {
    return jsonSafe(await this.invoices.remove(orgId, id));
  }

  @Post(':id/convert')
  async convert(@CurrentOrg() orgId: string, @Param('id') id: string) {
    return jsonSafe(await this.invoices.convertToInvoice(orgId, id));
  }

  @Post(':id/mark-paid')
  async markPaid(@CurrentOrg() orgId: string, @Param('id') id: string) {
    return jsonSafe(await this.invoices.markPaid(orgId, id));
  }

  @Post(':id/payments')
  async recordPayment(
    @CurrentOrg() orgId: string,
    @Param('id') id: string,
    @Body() dto: RecordPaymentDto,
  ) {
    return jsonSafe(await this.invoices.recordPayment(orgId, id, dto.amount));
  }
}
