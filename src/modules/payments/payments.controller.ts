import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { PaymentsService } from './payments.service';

// All public/unauthenticated: the customer paying is not logged in.
@Controller('v1')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // "Pay now" link from the invoice email/PDF -> redirect to hosted checkout.
  @Get('invoices/public/:token/pay')
  async pay(@Param('token') token: string, @Res() res: Response) {
    const url = await this.payments.checkoutRedirect(token);
    res.redirect(302, url);
  }

  // Flutterwave returns the customer here after checkout -> back to the invoice.
  @Get('payments/return')
  async ret(
    @Query('token') token: string,
    @Query('status') status: string,
    @Res() res: Response,
  ) {
    res.redirect(302, this.payments.returnRedirect(token, status));
  }

  // Server-to-server webhook from Flutterwave (verified by the verif-hash header).
  @Post('payments/webhook')
  @HttpCode(200)
  async webhook(@Headers('verif-hash') signature: string, @Body() body: any) {
    await this.payments.handleWebhook(signature, body);
    return { received: true };
  }
}
