import {
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RemindersService } from './reminders.service';

// Manual trigger for the reminder dispatcher (the @Cron runs it hourly anyway).
// Guarded by the same ADMIN_TOKEN. Lets you flush reminders on demand / verify.
@Controller('v1/admin')
export class RemindersController {
  constructor(
    private readonly reminders: RemindersService,
    private readonly config: ConfigService,
  ) {}

  @Post('run-reminders')
  @HttpCode(200)
  async run(@Headers('x-admin-token') token: string) {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || token !== expected) {
      throw new UnauthorizedException('Invalid admin token');
    }
    const dispatched = await this.reminders.dispatchDue();
    return { dispatched };
  }
}
