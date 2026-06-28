import { Controller, Get, NotFoundException, Query } from '@nestjs/common';
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

  // TEMPORARY diagnostic — remove after debugging email. Secret-guarded.
  // Attempts a real Resend send and returns Resend's raw response so we can see
  // the exact failure reason (the normal flow swallows it). Does not leak the key.
  @Get('email-debug')
  async emailDebug(@Query('k') k: string, @Query('to') to?: string) {
    if (k !== 'klipa-diag-9217') throw new NotFoundException();
    const provider = process.env.EMAIL_PROVIDER ?? '(unset)';
    const from = process.env.EMAIL_FROM ?? '(unset)';
    const key = process.env.RESEND_API_KEY ?? '';
    let status = 0;
    let body = '';
    if (key) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: to ?? 'muyombanohappy@gmail.com',
          subject: 'K-Lipwa email diagnostic',
          html: '<p>K-Lipwa email diagnostic — if you got this, Resend works.</p>',
        }),
      });
      status = res.status;
      body = (await res.text()).slice(0, 700);
    }
    return {
      EMAIL_PROVIDER: provider,
      EMAIL_FROM: from,
      key_present: Boolean(key),
      key_len: key.length,
      resend_http_status: status,
      resend_response: body,
    };
  }
}
