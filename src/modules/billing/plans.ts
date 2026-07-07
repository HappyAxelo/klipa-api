// The subscription catalog. Kept in code, not the DB: prices change by
// deploying, plan ids are stable strings stored on organisation.plan.
// Prices are whole RWF per month. Subscription money is paid directly to the
// founder's business account (MoMo/bank, see SUBSCRIPTION_INSTRUCTIONS), then
// activated via the admin endpoint. No card processor sits in the middle.

export type PlanId = 'free' | 'starter' | 'business' | 'enterprise';

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  priceMonthly: number; // RWF; 0 = free, -1 = custom/contact sales
  // Invoice allowance. `lifetime` for the free tier, `month` resets monthly.
  invoiceLimit: number | null; // null = unlimited
  limitPeriod: 'lifetime' | 'month' | null;
  highlighted: boolean; // "MOST POPULAR" in the UI
  features: string[];
  // Gated capabilities this plan unlocks. Enforced server-side so a paid-only
  // feature cannot be used without an active subscription that includes it.
  capabilities: Capability[];
}

export type Capability =
  | 'expenses' // bookkeeping / expense tracking
  | 'ai' // Klipwa AI insights + assistant
  | 'staff' // team accounts / invites
  | 'receipts' // attach receipt photos to expenses
  | 'multibranch';

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    tagline: 'Try Klipwa',
    priceMonthly: 0,
    invoiceLimit: 5,
    limitPeriod: 'lifetime',
    highlighted: false,
    capabilities: [],
    features: [
      '5 free invoices',
      'Branded PDF invoices',
      'Share by link or email',
      'Basic dashboard',
    ],
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    tagline: 'Solo Business',
    priceMonthly: 10000,
    invoiceLimit: 50,
    limitPeriod: 'month',
    highlighted: false,
    capabilities: ['expenses', 'ai'],
    features: [
      'Up to 50 invoices per month',
      'Quotations',
      'Payment links',
      'Automatic reminders',
      'Basic bookkeeping and expenses',
      'Klipwa AI insights',
      'Email support',
    ],
  },
  business: {
    id: 'business',
    name: 'Business',
    tagline: 'SME Growth',
    priceMonthly: 25000,
    invoiceLimit: null,
    limitPeriod: null,
    highlighted: true,
    capabilities: ['expenses', 'ai', 'staff', 'receipts'],
    features: [
      'Unlimited invoices and quotations',
      'Advanced bookkeeping with receipts',
      'Profit and loss reports',
      'Automatic reminders',
      'Team accounts (staff invites)',
      'Klipwa AI assistant',
      'Priority support',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Large organisations',
    priceMonthly: 30000,
    invoiceLimit: null,
    limitPeriod: null,
    highlighted: false,
    capabilities: ['expenses', 'ai', 'staff', 'receipts', 'multibranch'],
    features: [
      'Everything in Business',
      'Multi-branch management',
      'Bulk invoicing',
      'Dedicated support and onboarding',
      'Custom integrations',
      'Custom pricing available',
    ],
  },
};

/** Which paid plan the org is on while subscribed; 'free' otherwise. */
export function effectivePlan(
  orgPlan: string | null | undefined,
  subscribedUntil: Date | null | undefined,
): Plan {
  const subscribed = subscribedUntil != null && subscribedUntil > new Date();
  if (!subscribed) return PLANS.free;
  const id = (orgPlan ?? 'starter') as PlanId;
  return PLANS[id] ?? PLANS.starter;
}

/** Does the org's active plan include a given capability? */
export function planAllows(
  orgPlan: string | null | undefined,
  subscribedUntil: Date | null | undefined,
  cap: Capability,
): boolean {
  return effectivePlan(orgPlan, subscribedUntil).capabilities.includes(cap);
}

/** The cheapest plan that unlocks a capability (for upgrade prompts). */
export function planForCapability(cap: Capability): Plan {
  return (
    Object.values(PLANS).find((p) => p.capabilities.includes(cap)) ?? PLANS.business
  );
}
