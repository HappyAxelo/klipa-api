import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/database/prisma.service';
import { AuthContext } from '../../common/auth/supabase.guard';
import { CreateOnboardingDto } from './dto/create-onboarding.dto';

@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async complete(auth: AuthContext, dto: CreateOnboardingDto) {
    if (auth.organisationId) {
      return { id: auth.organisationId, alreadyOnboarded: true };
    }

    return this.prisma.$transaction(async (tx) => {
      // The organisation table now has RLS requiring id = app_current_org()
      // on every row, including inserts (a bare `using` clause doubles as
      // the `with check`). We're creating the org itself here, so no tenant
      // context exists yet — pre-generate the id and set it as the tenant
      // context FIRST, so the insert satisfies its own policy.
      const orgId = randomUUID();
      await tx.$executeRaw`select set_config('app.current_org', ${orgId}, true)`;

      await tx.userProfile.upsert({
        where: { id: auth.userId },
        update: { fullName: dto.fullName, email: auth.email },
        create: { id: auth.userId, fullName: dto.fullName, email: auth.email },
      });

      const org = await tx.organisation.create({
        data: {
          id: orgId,
          name: dto.businessName,
          category: dto.category,
          currency: dto.currency.toUpperCase(),
          logoUrl: dto.logoUrl ?? null,
        },
      });

      await tx.membership.create({
        data: { organisationId: org.id, userId: auth.userId, role: 'owner' },
      });

      await tx.consentRecord.create({
        data: {
          userId: auth.userId,
          termsVersion: dto.termsVersion,
          language: dto.consentLanguage,
        },
      });

      return org;
    });
  }
}
