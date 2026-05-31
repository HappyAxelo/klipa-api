import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
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
 * Verifies the Supabase access token, then looks up which organisation the
 * user belongs to and attaches it to the request.
 *
 * Supabase migrated projects to asymmetric "JWT Signing Keys" (ECC/RSA).
 * Tokens are now verified against the project's public JWKS endpoint, which
 * `jose` fetches and caches automatically. No shared secret needed, and it
 * keeps working when Supabase rotates keys.
 *
 * Set SUPABASE_PROJECT_URL (e.g. https://<ref>.supabase.co). The guard reads
 * the public keys from <url>/auth/v1/.well-known/jwks.json.
 *
 * Onboarding runs before an org exists, so organisationId may be null there.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private getJwks() {
    if (!this.jwks) {
      const url = this.config.getOrThrow<string>('SUPABASE_PROJECT_URL');
      const jwksUrl = new URL(`${url}/auth/v1/.well-known/jwks.json`);
      this.jwks = createRemoteJWKSet(jwksUrl);
    }
    return this.jwks;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length);

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.getJwks());
      payload = result.payload;
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
