import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { AdminController } from './admin.controller';
import { OnboardingService } from './onboarding.service';
import { AssistantModule } from '../assistant/assistant.module';

@Module({
  imports: [AssistantModule],
  controllers: [OnboardingController, AdminController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
