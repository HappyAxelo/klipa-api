import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { DatabaseModule } from './common/database/database.module';
import { EmailModule } from './integrations/email/email.module';
import { PdfModule } from './integrations/pdf/pdf.module';
import { SupabaseAuthGuard } from './common/auth/supabase.guard';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { CustomersModule } from './modules/customers/customers.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { StaffModule } from './modules/staff/staff.module';
import { BillingModule } from './modules/billing/billing.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { EventsModule } from './modules/events/events.module';
import { AssistantModule } from './modules/assistant/assistant.module';
import { PublicInvoiceModule } from './modules/public-invoice/public-invoice.module';
import { RemindersModule } from './modules/reminders/reminders.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // Rate limit: 300 requests/min per IP — generous for real use, stops abuse.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    DatabaseModule,
    EmailModule,
    PdfModule,
    OnboardingModule,
    CustomersModule,
    InvoicesModule,
    ExpensesModule,
    StaffModule,
    BillingModule,
    PaymentsModule,
    EventsModule,
    AssistantModule,
    PublicInvoiceModule,
    RemindersModule,
    HealthModule,
  ],
  providers: [
    // SupabaseAuthGuard is applied per-controller with @UseGuards, not globally,
    // because the public invoice route must stay open. Provided here so Nest
    // can inject its dependencies (ConfigService, PrismaService).
    SupabaseAuthGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
