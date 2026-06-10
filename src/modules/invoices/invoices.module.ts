import { Module } from '@nestjs/common';
import { InvoicesController, InvoicesPublicController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoiceNumberService } from './invoice-number.service';
import { CustomersModule } from '../customers/customers.module';
@Module({
  imports: [CustomersModule],
  controllers: [InvoicesController, InvoicesPublicController],
  providers: [InvoicesService, InvoiceNumberService],
})
export class InvoicesModule {}
