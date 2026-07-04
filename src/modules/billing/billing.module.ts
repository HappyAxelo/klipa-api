import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { RenewalService } from './renewal.service';

@Module({
  controllers: [BillingController],
  providers: [BillingService, RenewalService],
})
export class BillingModule {}
