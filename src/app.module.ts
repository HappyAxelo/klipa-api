import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './common/database/database.module';
import { EmailModule } from './integrations/email/email.module';
import { SupabaseAuthGuard } from './common/auth/supabase.guard';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { CustomersModule } from './modules/customers/customers.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { PublicInvoiceModule } from './modules/public-invoice/public-invoice.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    EmailModule,
    OnboardingModule,
    CustomersModule,
    InvoicesModule,
    PublicInvoiceModule,
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
