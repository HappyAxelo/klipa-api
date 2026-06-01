import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service';
import { AuthContext } from '../../common/auth/supabase.guard';
import { CreateOnboardingDto } from './dto/create-onboarding.dto';

@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async complete(auth: AuthContext, dto: CreateOnboardingDto) {
    // Idempotent: if the user already belongs to an org, just return it.
    // This means onboarding can be called any number of times without error —
    // the app never gets stuck on a 409.
    if (auth.organisationId) {
      const existing = await this.prisma.organisation.findUnique({
        where: { id: auth.organisationId },
      });
      if (existing) return existing;
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
}
