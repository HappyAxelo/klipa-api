import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/auth/supabase.guard';
import { CurrentUser, CurrentOrg } from '../../common/auth/current-user.decorator';
import { AuthContext } from '../../common/auth/supabase.guard';
import { OnboardingService } from './onboarding.service';
import { CreateOnboardingDto } from './dto/create-onboarding.dto';
import { UpdatePaymentDetailsDto } from './dto/update-payment-details.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { jsonSafe } from '../../common/money/money';

@Controller('v1')
@UseGuards(SupabaseAuthGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post('onboarding')
  async create(
    @CurrentUser() auth: AuthContext,
    @Body() dto: CreateOnboardingDto,
  ) {
    return jsonSafe(await this.onboarding.complete(auth, dto));
  }

  @Get('me')
  async me(@CurrentUser() auth: AuthContext) {
    const base = {
      userId: auth.userId,
      email: auth.email,
      organisationId: auth.organisationId,
      role: auth.role,
      onboarded: Boolean(auth.organisationId),
    };

    if (!auth.organisationId) return base;

    const profile = await this.onboarding.getOrgProfile(
      auth.organisationId,
      auth.userId,
    );

    return { ...base, ...profile };
  }

  // Update business profile (name, category, currency, logo, owner name).
  @Patch('business')
  async updateBusiness(
    @CurrentUser() auth: AuthContext,
    @CurrentOrg() orgId: string,
    @Body() dto: UpdateBusinessDto,
  ) {
    return jsonSafe(await this.onboarding.updateBusiness(orgId, auth.userId, dto));
  }

  // Update the business's payment details shown on its invoices (MoMo / bank).
  @Patch('payment-details')
  async updatePaymentDetails(
    @CurrentOrg() orgId: string,
    @Body() dto: UpdatePaymentDetailsDto,
  ) {
    return jsonSafe(await this.onboarding.updatePaymentDetails(orgId, dto));
  }
}
