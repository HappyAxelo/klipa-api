import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { SupabaseAuthGuard } from '../../common/auth/supabase.guard';
import { CurrentOrg } from '../../common/auth/current-user.decorator';
import { BillingService } from './billing.service';

class RequestUpgradeDto {
  @IsIn(['starter', 'business', 'enterprise'])
  plan: string;
}

@Controller('v1/billing')
@UseGuards(SupabaseAuthGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  overview(@CurrentOrg() orgId: string) {
    return this.billing.overview(orgId);
  }

  // "I want to upgrade" — queues it for the owner to activate after payment.
  @Post('request-upgrade')
  requestUpgrade(@CurrentOrg() orgId: string, @Body() dto: RequestUpgradeDto) {
    return this.billing.requestUpgrade(orgId, dto.plan);
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
