import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { AdminController } from './admin.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  controllers: [OnboardingController, AdminController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
