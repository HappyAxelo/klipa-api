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
      // Pre-generate org UUID so it matches app.current_org
      // required by the RLS policy during insert.
      const orgId = randomUUID();

      // Set tenant context inside the transaction
      await tx.$executeRaw`
        select set_config('app.current_org', ${orgId}, true)
      `;

      await tx.userProfile.upsert({
        where: { id: auth.userId },
        update: {
          fullName: dto.fullName,
          email: auth.email,
        },
        create: {
          id: auth.userId,
          fullName: dto.fullName,
          email: auth.email,
        },
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
        data: {
          organisationId: org.id,
          userId: auth.userId,
          role: 'owner',
        },
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
      const org = await tx.organisation.findUnique({
        where: { id: orgId },
      });

      const profile = await tx.userProfile.findUnique({
        where: { id: userId },
      });

      return {
        name: org?.name ?? '',
        category: org?.category ?? '',
        currency: org?.currency ?? 'RWF',
        owner: profile?.fullName ?? '',
      };
    });
  }
}
