import { Module } from '@nestjs/common';
import {
  PublicInvoiceController,
  PublicInvoiceService,
} from './public-invoice.controller';

@Module({
  controllers: [PublicInvoiceController],
  providers: [PublicInvoiceService],
})
export class PublicInvoiceModule {}
