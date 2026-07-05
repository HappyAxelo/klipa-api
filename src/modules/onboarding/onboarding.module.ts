import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { AdminController } from './admin.controller';
import { OnboardingService } from './onboarding.service';
import { AssistantModule } from '../assistant/assistant.module';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [AssistantModule],
  controllers: [OnboardingController, AdminController],
  providers: [OnboardingService, AnalyticsService],
})
export class OnboardingModule {}
