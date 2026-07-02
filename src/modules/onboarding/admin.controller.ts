import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnboardingService } from './onboarding.service';
import { jsonSafe } from '../../common/money/money';
import { safeEqual } from '../../common/security/security.util';

interface ActivateBody {
  organisationId?: string;
  businessName?: string;
  email?: string;
  months?: number;
}

// Platform-owner endpoint. Not behind Supabase auth — guarded by a shared
// ADMIN_TOKEN header so you can activate a subscription (after a manual bank
// transfer) with a simple curl. Inert until ADMIN_TOKEN is set.
@Controller('v1/admin')
export class AdminController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly config: ConfigService,
  ) {}

  @Post('subscription')
  async activate(
    @Headers('x-admin-token') token: string,
    @Body() body: ActivateBody,
  ) {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!safeEqual(token, expected)) {
      throw new UnauthorizedException('Invalid admin token');
    }
    // Resolve the business by id, exact name, or owner email.
    const org = await this.onboarding.resolveOrganisation({
      organisationId: body?.organisationId,
      businessName: body?.businessName,
      email: body?.email,
    });
    const months = body.months && body.months > 0 ? Math.floor(body.months) : 1;
    const result = await this.onboarding.activateSubscription(org.id, months);
    return jsonSafe({ business: org.name, ...result });
  }
}
