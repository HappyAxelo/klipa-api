import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

/**
 * Provider-agnostic email. In dev (EMAIL_PROVIDER=console) it logs the
 * message instead of sending, so the whole app runs with no credentials.
 * Set EMAIL_PROVIDER=resend + RESEND_API_KEY for real delivery.
 *
 * Set SPF, DKIM and DMARC on the sending domain before going live, or
 * invoices land in spam and the core promise quietly breaks.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly config: ConfigService) {}

  async send(msg: EmailMessage): Promise<void> {
    const provider = this.config.get<string>('EMAIL_PROVIDER', 'console');

    if (provider === 'console') {
      this.logger.log(`[email:console] to=${msg.to} subject="${msg.subject}"`);
      return;
    }

    if (provider === 'resend') {
      const apiKey = this.config.getOrThrow<string>('RESEND_API_KEY');
      const from = this.config.getOrThrow<string>('EMAIL_FROM');
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Resend failed (${res.status}): ${body}`);
      }
      return;
    }

    throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
  }
}
