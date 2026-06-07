import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service';
import { AuthContext } from '../../common/auth/supabase.guard';
import { CreateOnboardingDto } from './dto/create-onboarding.dto';

@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async complete(auth: AuthContext, dto: CreateOnboardingDto) {
    // Idempotent: if the user already belongs to an org, they're done.
    // Return straight from the auth context — no DB read here, because the
    // organisation table is protected by row-level security that needs a
    // tenant context this call doesn't have. Querying it would throw (500).
    // The app only needs to know onboarding is complete, which this confirms.
    if (auth.organisationId) {
      return { id: auth.organisationId, alreadyOnboarded: true };
    }

    // First-time onboarding. Runs before any org exists, so it uses the base client.
    return this.prisma.$transaction(async (tx) => {
      await tx.userProfile.upsert({
        where: { id: auth.userId },
        update: { fullName: dto.fullName, email: auth.email },
        create: { id: auth.userId, fullName: dto.fullName, email: auth.email },
      });

      const org = await tx.organisation.create({
        data: {
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

  async getOrgProfile(orgId: string, userId: string) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const org = await tx.organisation.findUnique({ where: { id: orgId } });
      const profile = await tx.userProfile.findUnique({ where: { id: userId } });

      return {
        name: org?.name ?? '',
        category: org?.category ?? '',
        currency: org?.currency ?? 'RWF',
        owner: profile?.fullName ?? '',
      };
    });
  }
}
