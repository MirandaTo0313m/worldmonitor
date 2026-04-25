/**
 * Pure resolver: maps gateway-internal auth state to a UsageIdentity event field set.
 *
 * MUST NOT re-verify JWTs, re-hash keys, or re-validate API keys. The gateway has
 * already done that work — this function consumes the resolved values.
 *
 * Tier is the user's current entitlement tier (0 = free / unknown). For non-tier-gated
 * endpoints the gateway never resolves it, so we accept null/undefined and report 0.
 */

export type AuthKind =
  | 'clerk_jwt'
  | 'user_api_key'
  | 'enterprise_api_key'
  | 'widget_key'
  | 'anon';

export interface UsageIdentity {
  auth_kind: AuthKind;
  principal_id: string | null;
  customer_id: string | null;
  tier: number;
}

export interface UsageIdentityInput {
  sessionUserId: string | null;
  isUserApiKey: boolean;
  enterpriseApiKey: string | null;
  widgetKey: string | null;
  clerkOrgId: string | null;
  userApiKeyCustomerRef: string | null;
  tier: number | null;
}

// Static enterprise-key → customer map. Explicit so attribution is reviewable in code,
// not floating in env vars. Add entries here as enterprise customers are onboarded.
// The hash (not the raw key) is used as principal_id so logs never leak the secret.
const ENTERPRISE_KEY_TO_CUSTOMER: Record<string, string> = {
  // 'wm_ent_xxxx': 'acme-corp',
};

export function buildUsageIdentity(input: UsageIdentityInput): UsageIdentity {
  const tier = input.tier ?? 0;

  if (input.isUserApiKey) {
    return {
      auth_kind: 'user_api_key',
      principal_id: input.sessionUserId,
      customer_id: input.userApiKeyCustomerRef ?? input.sessionUserId,
      tier,
    };
  }

  if (input.sessionUserId) {
    return {
      auth_kind: 'clerk_jwt',
      principal_id: input.sessionUserId,
      customer_id: input.clerkOrgId ?? input.sessionUserId,
      tier,
    };
  }

  if (input.enterpriseApiKey) {
    const customer = ENTERPRISE_KEY_TO_CUSTOMER[input.enterpriseApiKey] ?? 'enterprise-unmapped';
    return {
      auth_kind: 'enterprise_api_key',
      principal_id: hashKeySync(input.enterpriseApiKey),
      customer_id: customer,
      tier,
    };
  }

  if (input.widgetKey) {
    return {
      auth_kind: 'widget_key',
      principal_id: hashKeySync(input.widgetKey),
      customer_id: input.widgetKey,
      tier,
    };
  }

  return {
    auth_kind: 'anon',
    principal_id: null,
    customer_id: null,
    tier: 0,
  };
}

// 32-bit FNV-1a — non-cryptographic, only used to avoid logging raw key material.
// Edge crypto.subtle.digest is async; we want a sync helper for the hot path.
function hashKeySync(key: string): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
