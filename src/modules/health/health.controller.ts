import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service';

// Public, unauthenticated. Railway and uptime monitors hit /health.
// Returns 200 only if the database actually answers.
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    let db = 'down';
    try {
      await this.prisma.$queryRaw`select 1`;
      db = 'up';
    } catch {
      db = 'down';
    }
    return {
      status: db === 'up' ? 'ok' : 'degraded',
      db,
      time: new Date().toISOString(),
    };
  }
}
