import { HttpException } from '@nestjs/common';
import { Capability, planAllows, planForCapability } from '../../modules/billing/plans';

type OrgLike = { plan?: string | null; subscribedUntil?: Date | null } | null;

/**
 * Throws a 402 (with the plan the user needs) when the org's active plan does
 * not include a capability. This is the server-side gate: a feature listed as
 * "Business plan" can only be used with an active Business subscription, no
 * matter what the client sends.
 */
export function assertCapability(org: OrgLike, cap: Capability): void {
  if (planAllows(org?.plan, org?.subscribedUntil, cap)) return;
  const need = planForCapability(cap);
  throw new HttpException(
    {
      statusCode: 402,
      error: 'Payment Required',
      message: `This feature is on the ${need.name} plan. Upgrade to use it.`,
      capability: cap,
      requiredPlan: need.id,
      requiredPlanName: need.name,
    },
    402,
  );
}
