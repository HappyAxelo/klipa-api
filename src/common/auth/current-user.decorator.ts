import {
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthContext } from './supabase.guard';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return req.auth as AuthContext;
  },
);

/**
 * Returns the org id, throwing if the user has not onboarded yet.
 * Use on every endpoint that touches tenant data.
 */
export const CurrentOrg = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request>();
    const orgId = req.auth?.organisationId;
    if (!orgId) {
      throw new ForbiddenException('No organisation. Complete onboarding first.');
    }
    return orgId;
  },
);
