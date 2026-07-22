import {
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RemindersService } from './reminders.service';
import { RenewalService } from '../billing/renewal.service';
import { safeEqual } from '../../common/security/security.util';

// Manual trigger for the reminder dispatcher (the @Cron runs it hourly anyway).
// Guarded by the same ADMIN_TOKEN. Lets you flush reminders on demand / verify.
@Controller('v1/admin')
export class RemindersController {
  constructor(
    private readonly reminders: RemindersService,
    private readonly renewals: RenewalService,
    private readonly config: ConfigService,
  ) {}

  @Post('run-reminders')
  @HttpCode(200)
  async run(@Headers('x-admin-token') token: string) {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!safeEqual(token, expected)) {
      throw new UnauthorizedException('Invalid admin token');
    }
    const dispatched = await this.reminders.dispatchDue();
    return { dispatched };
  }

  // One endpoint an external scheduler (e.g. cron-job.org) hits hourly to run
  // every background job. Needed on free hosting where the process sleeps and
  // in-process @Cron timers sleep with it. Safe to call as often as you like:
  // each job is idempotent.
  @Post('run-jobs')
  @HttpCode(200)
  async runJobs(@Headers('x-admin-token') token: string) {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!safeEqual(token, expected)) {
      throw new UnauthorizedException('Invalid admin token');
    }
    const dispatched = await this.reminders.dispatchDue();
    await this.renewals.run();
    return { ok: true, remindersDispatched: dispatched };
  }
}
