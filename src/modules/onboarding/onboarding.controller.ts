import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/auth/supabase.guard';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthContext } from '../../common/auth/supabase.guard';
import { OnboardingService } from './onboarding.service';
import { CreateOnboardingDto } from './dto/create-onboarding.dto';
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
}
