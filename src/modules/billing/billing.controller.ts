import { Controller, Get, Post, UseGuards } from '@nestjs/common';
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

  // Stop the plan from renewing; it runs to the end of the paid period.
  @Post('cancel-renewal')
  cancel(@CurrentOrg() orgId: string) {
    return this.billing.setAutoRenew(orgId, false);
  }

  @Post('resume-renewal')
  resume(@CurrentOrg() orgId: string) {
    return this.billing.setAutoRenew(orgId, true);
  }
}
