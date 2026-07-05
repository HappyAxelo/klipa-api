import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PrismaService } from '../../common/database/prisma.service';

/**
 * Web push to the business's phones: invoice viewed, payment recorded,
 * invoice gone overdue. Inert until VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are
 * set on Railway. Sending is always best-effort: a push must never break the
 * action that triggered it, and dead subscriptions prune themselves.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private configured = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const pub = this.publicKey();
    const priv = (this.config.get<string>('VAPID_PRIVATE_KEY') ?? '').trim();
    if (pub && priv) {
      try {
        webpush.setVapidDetails(
          this.config.get<string>('VAPID_SUBJECT', 'mailto:muyombanohappy@gmail.com'),
          pub,
          priv,
        );
        this.configured = true;
      } catch (e) {
        this.logger.warn(`VAPID keys invalid, push disabled: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  publicKey(): string | null {
    const k = (this.config.get<string>('VAPID_PUBLIC_KEY') ?? '').trim();
    return k || null;
  }

  enabled(): boolean {
    return this.configured;
  }

  async subscribe(orgId: string, userId: string, sub: { endpoint: string; p256dh: string; auth: string }) {
    // One row per endpoint; a re-subscribe from the same browser just updates it.
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      update: { organisationId: orgId, userId, p256dh: sub.p256dh, auth: sub.auth },
      create: { organisationId: orgId, userId, ...sub },
    });
    return { subscribed: true };
  }

  async unsubscribe(endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint } });
    return { unsubscribed: true };
  }

  /** Notify every subscribed device of a business. Never throws. */
  async sendToOrg(orgId: string, title: string, body: string, url = '/'): Promise<void> {
    if (!this.configured) return;
    try {
      const subs = await this.prisma.pushSubscription.findMany({
        where: { organisationId: orgId },
      });
      const payload = JSON.stringify({ title, body, url });
      await Promise.all(subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          );
        } catch (err: any) {
          // 404/410 = the browser dropped the subscription; forget it.
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await this.prisma.pushSubscription.deleteMany({ where: { endpoint: s.endpoint } }).catch(() => {});
          }
        }
      }));
    } catch (e) {
      this.logger.warn(`Push to org ${orgId} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
