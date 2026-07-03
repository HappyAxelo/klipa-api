import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnboardingService } from './onboarding.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AssistantService } from '../assistant/assistant.service';
import { jsonSafe } from '../../common/money/money';
import { safeEqual } from '../../common/security/security.util';

interface ActivateBody {
  organisationId?: string;
  businessName?: string;
  email?: string;
  months?: number;
  plan?: string; // starter | business | enterprise (default starter)
}

// Platform-owner endpoint. Not behind Supabase auth — guarded by a shared
// ADMIN_TOKEN header so you can activate a subscription (after a manual bank
// transfer) with a simple curl. Inert until ADMIN_TOKEN is set.
@Controller('v1/admin')
export class AdminController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly assistant: AssistantService,
  ) {}

  // Owner diagnostic: is the Klipwa AI key working? Never returns the key.
  @Get('ai-check')
  async aiCheck(@Headers('x-admin-token') token: string) {
    this.assertAdmin(token);
    return this.assistant.aiCheck();
  }

  private assertAdmin(token: string) {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!safeEqual(token, expected)) {
      throw new UnauthorizedException('Invalid admin token');
    }
  }

  // Platform-wide dashboard numbers for the owner's admin panel.
  @Get('stats')
  async stats(@Headers('x-admin-token') token: string) {
    this.assertAdmin(token);
    const now = new Date();

    const [
      totalUsers,
      totalOrgs,
      totalInvoices,
      totalQuotations,
      activeSubscriptions,
      paidAgg,
      invoicedAgg,
      recentOrgs,
    ] = await Promise.all([
      this.prisma.userProfile.count(),
      this.prisma.organisation.count(),
      this.prisma.invoice.count({ where: { docType: 'invoice' } }),
      this.prisma.invoice.count({ where: { docType: 'quotation' } }),
      this.prisma.organisation.count({ where: { subscribedUntil: { gt: now } } }),
      this.prisma.payment.aggregate({ _sum: { amount: true } }),
      this.prisma.invoice.aggregate({
        where: { docType: 'invoice' },
        _sum: { amountTotal: true },
      }),
      this.prisma.organisation.findMany({
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: {
          id: true,
          name: true,
          currency: true,
          plan: true,
          subscribedUntil: true,
          createdAt: true,
          _count: { select: { invoices: true, memberships: true } },
        },
      }),
    ]);

    return jsonSafe({
      generatedAt: now,
      totals: {
        users: totalUsers,
        organisations: totalOrgs,
        invoices: totalInvoices,
        quotations: totalQuotations,
        activeSubscriptions,
        collected: paidAgg._sum.amount ?? 0n,
        invoiced: invoicedAgg._sum.amountTotal ?? 0n,
      },
      recentOrganisations: recentOrgs.map((o) => ({
        id: o.id,
        name: o.name,
        currency: o.currency,
        plan: o.plan,
        subscribed: o.subscribedUntil != null && o.subscribedUntil > now,
        subscribedUntil: o.subscribedUntil,
        invoices: o._count.invoices,
        members: o._count.memberships,
        createdAt: o.createdAt,
      })),
    });
  }

  @Post('subscription')
  async activate(
    @Headers('x-admin-token') token: string,
    @Body() body: ActivateBody,
  ) {
    this.assertAdmin(token);
    // Resolve the business by id, exact name, or owner email.
    const org = await this.onboarding.resolveOrganisation({
      organisationId: body?.organisationId,
      businessName: body?.businessName,
      email: body?.email,
    });
    const months = body.months && body.months > 0 ? Math.floor(body.months) : 1;
    const plan = ['starter', 'business', 'enterprise'].includes(body.plan ?? '')
      ? body.plan!
      : 'starter';
    const result = await this.onboarding.activateSubscription(org.id, months, plan);
    return jsonSafe({ business: org.name, ...result });
  }
}
