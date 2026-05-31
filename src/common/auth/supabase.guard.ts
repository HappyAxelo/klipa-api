import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../database/prisma.service';

export interface AuthContext {
  userId: string; // Supabase auth.users.id
  email: string;
  organisationId: string | null; // null until onboarding creates one
  role: string | null;
}

declare module 'express' {
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * Verifies the Supabase access token (HS256, signed with the project JWT
 * secret), then looks up which organisation the user belongs to and attaches
 * it to the request. Controllers read it via @CurrentOrg() / @CurrentUser().
 *
 * Onboarding runs before an org exists, so organisationId may be null there.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length);
    const secret = this.config.getOrThrow<string>('SUPABASE_JWT_SECRET');

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, secret, {
        algorithms: ['HS256'],
      }) as jwt.JwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const userId = payload.sub;
    const email = (payload.email as string) ?? '';
    if (!userId) throw new UnauthorizedException('Token has no subject');

    // Resolve membership with the base client (RLS not yet scoped — we are
    // deciding which org to scope to). One user, one org in the MVP.
    const membership = await this.prisma.membership.findFirst({
      where: { userId },
    });

    req.auth = {
      userId,
      email,
      organisationId: membership?.organisationId ?? null,
      role: membership?.role ?? null,
    };
    return true;
  }
}
