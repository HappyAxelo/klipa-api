import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/database/prisma.service';
import { AuthContext } from '../../common/auth/supabase.guard';
import { CreateOnboardingDto } from './dto/create-onboarding.dto';
import { UpdatePaymentDetailsDto } from './dto/update-payment-details.dto';

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private freeLimit(): number {
    return Number(this.config.get<string>('FREE_INVOICE_LIMIT', '5'));
  }

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

      // Handle email conflict: if a stale profile exists under a different
      // auth ID but same email (from a previous failed attempt), remove it first.
      const staleProfile = await tx.userProfile.findUnique({
        where: { email: auth.email },
      });

      if (staleProfile && staleProfile.id !== auth.userId) {
        await tx.userProfile.delete({
          where: { id: staleProfile.id },
        });
      }

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
          momoCode: dto.momoCode ?? null,
          bankAccount: dto.bankAccount ?? null,
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
      const org = await tx.organisation.findUnique({ where: { id: orgId } });
      const profile = await tx.userProfile.findUnique({ where: { id: userId } });
      const invoicesUsed = await tx.invoice.count({
        where: { organisationId: orgId },
      });

      const freeLimit = this.freeLimit();
      const subscribed =
        org?.subscribedUntil != null && org.subscribedUntil > new Date();

      return {
        name: org?.name ?? '',
        category: org?.category ?? '',
        currency: org?.currency ?? 'RWF',
        owner: profile?.fullName ?? '',
        momoCode: org?.momoCode ?? null,
        bankAccount: org?.bankAccount ?? null,
        // Subscription / usage so the app can show "x of 5 free used" + paywall.
        subscribed,
        subscribedUntil: org?.subscribedUntil ?? null,
        invoicesUsed,
        freeLimit,
        invoicesRemaining: subscribed ? null : Math.max(0, freeLimit - invoicesUsed),
      };
    });
  }

  async updatePaymentDetails(orgId: string, dto: UpdatePaymentDetailsDto) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const org = await tx.organisation.update({
        where: { id: orgId },
        data: {
          ...(dto.momoCode !== undefined ? { momoCode: dto.momoCode } : {}),
          ...(dto.bankAccount !== undefined ? { bankAccount: dto.bankAccount } : {}),
        },
      });
      return { momoCode: org.momoCode, bankAccount: org.bankAccount };
    });
  }

  // Admin: grant/extend a subscription after a manual bank-transfer payment.
  async activateSubscription(orgId: string, months: number) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const current = await tx.organisation.findUnique({ where: { id: orgId } });
      if (!current) return null;
      const base =
        current.subscribedUntil && current.subscribedUntil > new Date()
          ? new Date(current.subscribedUntil)
          : new Date();
      base.setMonth(base.getMonth() + months);
      const org = await tx.organisation.update({
        where: { id: orgId },
        data: { subscribedUntil: base, plan: 'growth' },
      });
      return { organisationId: orgId, subscribedUntil: org.subscribedUntil };
    });
  }
}
