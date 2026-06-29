import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './common/database/database.module';
import { EmailModule } from './integrations/email/email.module';
import { PdfModule } from './integrations/pdf/pdf.module';
import { SupabaseAuthGuard } from './common/auth/supabase.guard';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { CustomersModule } from './modules/customers/customers.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { PublicInvoiceModule } from './modules/public-invoice/public-invoice.module';
import { RemindersModule } from './modules/reminders/reminders.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    EmailModule,
    PdfModule,
    OnboardingModule,
    CustomersModule,
    InvoicesModule,
    PublicInvoiceModule,
    RemindersModule,
    HealthModule,
  ],
  providers: [
    // SupabaseAuthGuard is applied per-controller with @UseGuards, not globally,
    // because the public invoice route must stay open. Provided here so Nest
    // can inject its dependencies (ConfigService, PrismaService).
    SupabaseAuthGuard,
  ],
})
export class AppModule {}
