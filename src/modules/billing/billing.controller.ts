import { Controller, Get, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/auth/supabase.guard';
import { CurrentOrg } from '../../common/auth/current-user.decorator';
import { BillingService } from './billing.service';

@Controller('v1/billing')
@UseGuards(SupabaseAuthGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  overview(@CurrentOrg() orgId: string) {
    return this.billing.overview(orgId);
  }
}
