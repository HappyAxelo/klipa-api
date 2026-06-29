import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
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
      const att = msg.attachments?.length ? ` attachments=${msg.attachments.length}` : '';
      this.logger.log(`[email:console] to=${msg.to} subject="${msg.subject}"${att}`);
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
          attachments: msg.attachments?.map((a) => ({
            filename: a.filename,
            content: a.content.toString('base64'),
          })),
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
