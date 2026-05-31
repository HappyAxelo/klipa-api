import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service';
import { AuthContext } from '../../common/auth/supabase.guard';
import { CreateOnboardingDto } from './dto/create-onboarding.dto';

@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async complete(auth: AuthContext, dto: CreateOnboardingDto) {
    if (auth.organisationId) {
      throw new ConflictException('Already onboarded');
    }

    // Runs before any org exists, so this uses the base client (not withTenant).
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

      // Store the consent the user gave on the Terms screen.
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
