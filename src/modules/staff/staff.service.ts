import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service';
import { EmailService } from '../../integrations/email/email.service';
import { ConfigService } from '@nestjs/config';
import { AuthContext } from '../../common/auth/supabase.guard';
import { escapeHtml } from '../../common/security/security.util';
import { InviteDto } from './dto/invite.dto';

@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  private assertManager(role: string | null) {
    if (role !== 'owner' && role !== 'admin') {
      throw new ForbiddenException('Only an owner or admin can manage staff.');
    }
  }

  /** Members + pending invites for the current org. */
  async list(orgId: string) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const memberships = await tx.membership.findMany({
        where: { organisationId: orgId },
        include: { user: { select: { fullName: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      });
      const invitations = await tx.invitation.findMany({
        where: { organisationId: orgId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      return {
        members: memberships.map((m) => ({
          id: m.id,
          userId: m.userId,
          name: m.user.fullName,
          email: m.user.email,
          role: m.role,
          joinedAt: m.createdAt,
        })),
        invitations: invitations.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          status: i.status,
          invitedAt: i.createdAt,
        })),
      };
    });
  }

  /** Owner/admin invites an email into the org. */
  async invite(orgId: string, actorRole: string | null, dto: InviteDto) {
    this.assertManager(actorRole);
    const email = dto.email.trim().toLowerCase();
    const role = dto.role ?? 'member';

    return this.prisma.withTenant(orgId, async (tx) => {
      const org = await tx.organisation.findUnique({ where: { id: orgId } });
      if (!org) throw new NotFoundException('Organisation not found');

      // Already a member?
      const existingMember = await tx.membership.findFirst({
        where: { organisationId: orgId, user: { email } },
      });
      if (existingMember) {
        throw new BadRequestException('That person is already a member.');
      }

      // Re-open or reuse an existing invitation for this email.
      const existing = await tx.invitation.findFirst({
        where: { organisationId: orgId, email },
      });
      const invitation = existing
        ? await tx.invitation.update({
            where: { id: existing.id },
            data: { role, status: 'pending' },
          })
        : await tx.invitation.create({
            data: { organisationId: orgId, email, role, status: 'pending' },
          });

      // Best-effort email — never fail the invite if delivery hiccups.
      try {
        const appUrl = this.config.get<string>(
          'PUBLIC_APP_URL',
          'https://klipwa.netlify.app',
        );
        await this.email.send({
          to: email,
          subject: `You've been invited to join ${org.name} on Klipwa`,
          html: `
            <p>Hi,</p>
            <p><strong>${escapeHtml(org.name)}</strong> has invited you to join their
            team on Klipwa as a <strong>${escapeHtml(role)}</strong>.</p>
            <p>Sign in (or create an account) with <strong>${escapeHtml(email)}</strong>
            at <a href="${appUrl}">${appUrl}</a>, then open Settings &rarr; Team to
            accept the invitation.</p>
            <p>— The Klipwa team</p>
          `,
        });
      } catch (err) {
        this.logger.warn(
          `Invitation saved but email to ${email} failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }

      return {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        invitedAt: invitation.createdAt,
      };
    });
  }

  /** Owner/admin revokes a pending invitation. */
  async revoke(orgId: string, actorRole: string | null, invitationId: string) {
    this.assertManager(actorRole);
    return this.prisma.withTenant(orgId, async (tx) => {
      const res = await tx.invitation.deleteMany({
        where: { id: invitationId, organisationId: orgId },
      });
      if (res.count === 0) throw new NotFoundException('Invitation not found');
      return { revoked: true };
    });
  }

  /** Owner/admin removes a member (cannot remove an owner or themselves). */
  async removeMember(
    orgId: string,
    actor: AuthContext,
    membershipId: string,
  ) {
    this.assertManager(actor.role);
    return this.prisma.withTenant(orgId, async (tx) => {
      const m = await tx.membership.findFirst({
        where: { id: membershipId, organisationId: orgId },
      });
      if (!m) throw new NotFoundException('Member not found');
      if (m.role === 'owner') {
        throw new BadRequestException('The owner cannot be removed.');
      }
      if (m.userId === actor.userId) {
        throw new BadRequestException('You cannot remove yourself.');
      }
      await tx.membership.delete({ where: { id: m.id } });
      return { removed: true };
    });
  }

  /** Invitations addressed to the signed-in user's email, across orgs. */
  async myInvitations(email: string) {
    const rows = await this.prisma.invitation.findMany({
      where: { email: email.trim().toLowerCase(), status: 'pending' },
      include: { organisation: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((i) => ({
      id: i.id,
      organisationId: i.organisationId,
      organisationName: i.organisation.name,
      role: i.role,
      invitedAt: i.createdAt,
    }));
  }

  /** The signed-in user accepts an invitation and joins that organisation. */
  async accept(auth: AuthContext, invitationId: string) {
    const email = auth.email.trim().toLowerCase();
    const invitation = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
    });
    if (
      !invitation ||
      invitation.status !== 'pending' ||
      invitation.email.trim().toLowerCase() !== email
    ) {
      throw new NotFoundException('Invitation not found');
    }

    return this.prisma.withTenant(invitation.organisationId, async (tx) => {
      // Ensure a user profile exists (they may never have onboarded their own org).
      await tx.userProfile.upsert({
        where: { id: auth.userId },
        update: { email: auth.email },
        create: {
          id: auth.userId,
          fullName: auth.email.split('@')[0],
          email: auth.email,
        },
      });

      // Idempotent: don't duplicate the membership if they already joined.
      const existing = await tx.membership.findFirst({
        where: { organisationId: invitation.organisationId, userId: auth.userId },
      });
      if (!existing) {
        await tx.membership.create({
          data: {
            organisationId: invitation.organisationId,
            userId: auth.userId,
            role: invitation.role,
          },
        });
      }

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: 'accepted' },
      });

      return { accepted: true, organisationId: invitation.organisationId };
    });
  }
}
