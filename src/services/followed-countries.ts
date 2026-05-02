/**
 * Followed-countries client service — single owner of watchlist semantics.
 *
 * Operating modes:
 *  1. Anonymous (no Clerk user) — localStorage at `wm-followed-countries-v1`,
 *     storing `JSON.stringify({ countries: string[] })`. Cap enforced
 *     client-side. **Implemented in U2.**
 *  2. handoffPending — transitional during the anon→signed-in merge.
 *     Mutations refused with `HANDOFF_PENDING`. **Wired in U3.**
 *  3. Signed-in (handoff complete) — Convex authoritative. **Wired in U3.**
 *
 * U2 leaves the service in a working state for ANONYMOUS users only. The
 * sign-in transition orchestration (auth-state listener, _handoffGeneration
 * counter, mergeAnonymousLocal call, user-scoped snapshot) is U3's job —
 * see TODO(U3) markers. Until U3, signed-in users transparently fall
 * through to anonymous-mode storage.
 *
 * Patterns mirrored from:
 *  - src/services/market-watchlist.ts (event dispatch, JSON.parse safety)
 *  - src/services/aviation/watchlist.ts (storage-key versioning)
 *  - src/services/entitlements.ts (hasTier / getEntitlementState)
 *
 * Memory: `discriminated-union-over-sentinel-boolean` —
 * `FollowMutationResult` is a discriminated union, never a `boolean | null`.
 *
 * Memory: `convex-error-string-data-strips-errordata-on-wire` — when U3
 * wires the Convex mutation path, kind extraction must read `err.data.kind`
 * (not substring-match the message).
 */

import { toIso2 } from '../utils/country-codes';
import {
  getEntitlementState as _getEntitlementState,
  hasTier as _hasTier,
} from './entitlements';
import { getCurrentClerkUser as _getCurrentClerkUser } from './clerk';

// ---------------------------------------------------------------------------
// Public constants & types
// ---------------------------------------------------------------------------

/** Mirror of the server-side `convex/constants.ts::FREE_TIER_FOLLOW_LIMIT`. */
export const FREE_TIER_FOLLOW_LIMIT = 3;

/** localStorage key for the anonymous-mode list. Versioned for safe migration. */
export const FOLLOWED_COUNTRIES_STORAGE_KEY = 'wm-followed-countries-v1';

/** Custom event name dispatched on every successful mutation. */
export const WM_FOLLOWED_COUNTRIES_CHANGED = 'wm-followed-countries-changed';

/**
 * Discriminated-union result. Service NEVER throws from
 * `addCountry` / `removeCountry`.
 */
export type FollowMutationResult =
  | { ok: true }
  | { ok: false; reason: 'DISABLED' }
  | { ok: false; reason: 'INVALID_INPUT' }
  | { ok: false; reason: 'FREE_CAP'; currentCount?: number; limit?: number }
  | { ok: false; reason: 'ENTITLEMENT_LOADING' }
  | { ok: false; reason: 'HANDOFF_PENDING' }
  | { ok: false; reason: 'STORAGE_FULL' };

export type ServiceEntitlementState = 'pro' | 'free' | 'loading';

// ---------------------------------------------------------------------------
// Test-injection seams
// ---------------------------------------------------------------------------
//
// Node's `node:test` runner has no first-class ESM module mocker; rather
// than reach for ts-jest / vitest just for U2, we expose narrow setter
// hooks. Production callers never touch these.

type ClerkUserGetter = () => { id: string } | null;
type EntitlementStateGetter = () => { features?: { tier?: number } } | null;
type HasTierFn = (minTier: number) => boolean;

let _clerkUserGetter: ClerkUserGetter = () =>
  _getCurrentClerkUser() as { id: string } | null;
let _entitlementStateGetter: EntitlementStateGetter = () =>
  _getEntitlementState();
let _hasTierFn: HasTierFn = (n) => _hasTier(n);
let _featureFlagOverride: boolean | null = null;

/** Test-only override hook. Pass `null` to restore the real implementations. */
export function _setDepsForTests(deps: {
  getCurrentClerkUser?: ClerkUserGetter | null;
  getEntitlementState?: EntitlementStateGetter | null;
  hasTier?: HasTierFn | null;
  featureFlagEnabled?: boolean | null;
}): void {
  if (deps.getCurrentClerkUser !== undefined) {
    _clerkUserGetter =
      deps.getCurrentClerkUser ??
      (() => _getCurrentClerkUser() as { id: string } | null);
  }
  if (deps.getEntitlementState !== undefined) {
    _entitlementStateGetter =
      deps.getEntitlementState ?? (() => _getEntitlementState());
  }
  if (deps.hasTier !== undefined) {
    _hasTierFn = deps.hasTier ?? ((n) => _hasTier(n));
  }
  if (deps.featureFlagEnabled !== undefined) {
    _featureFlagOverride = deps.featureFlagEnabled;
  }
}

/** Test-only — clears all module-level state so tests start from a clean slate. */
export function _resetStateForTests(): void {
  _handoffState = 'idle';
  _handoffGeneration = 0;
  _lastKnownSubscriptionSnapshot = null;
}

// ---------------------------------------------------------------------------
// Module-private state (U3 plumbing — declared now so U3 can plug in cleanly)
// ---------------------------------------------------------------------------

// TODO(U3): the auth-state listener (subscribeAuthState) flips
//   _handoffState pending → complete after `mergeAnonymousLocal` resolves.
let _handoffState: 'idle' | 'pending' | 'failed' | 'complete' = 'idle';

// TODO(U3): incremented on every auth-state change. Captured by handoff
//   callbacks before `await` and verified after, to drop stale results.
let _handoffGeneration = 0;

// TODO(U3): user-scoped cache of the most recent listFollowed snapshot.
//   `getFollowed()` only unions this with localStorage if
//   `userId === currentClerkUser.id` (memory:
//   `session-storage-cross-user-leak-on-auth-transition`).
let _lastKnownSubscriptionSnapshot:
  | { userId: string; countries: string[] }
  | null = null;

// Reads to silence "unused" TS in U2; U3 will exercise these for real.
void _handoffGeneration;
void _lastKnownSubscriptionSnapshot;

// ---------------------------------------------------------------------------
// Feature-flag gate
// ---------------------------------------------------------------------------

function isFeatureFlagEnabled(): boolean {
  if (_featureFlagOverride !== null) return _featureFlagOverride;
  // Default ON in dev/preview; OFF only when explicitly set to '0'.
  // Plan U2: use `!== '0'` (default-on).
  try {
    const flag = import.meta.env?.VITE_FOLLOW_COUNTRIES_ENABLED;
    return flag !== '0';
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Storage I/O — anonymous mode
// ---------------------------------------------------------------------------

interface StoredShape {
  countries: string[];
}

function readLocalStorageList(): string[] {
  try {
    const raw =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY)
        : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as Partial<StoredShape>).countries)
    ) {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const c of (parsed as StoredShape).countries) {
        if (typeof c !== 'string') continue;
        const norm = toIso2(c);
        if (!norm) continue;
        if (seen.has(norm)) continue;
        seen.add(norm);
        out.push(norm);
      }
      return out;
    }
  } catch {
    // corrupt JSON or non-object — fall through to []
  }
  return [];
}

/**
 * Returns `true` on success, `false` on storage quota / write failure.
 */
function writeLocalStorageList(list: string[]): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: list }),
    );
    return true;
  } catch {
    return false;
  }
}

function dispatchChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));
  } catch {
    // jsdom-less test envs may not have CustomEvent; swallow.
  }
}

// ---------------------------------------------------------------------------
// Entitlement + auth state resolution
// ---------------------------------------------------------------------------

/**
 * Returns the effective service-level entitlement state.
 *
 *  - Anonymous (no Clerk user) → `'free'` (NEVER `'loading'`; otherwise
 *    anon users would be permanently blocked because
 *    `getEntitlementState()` returns null without a Clerk session).
 *  - Signed-in, entitlement snapshot not yet arrived → `'loading'`.
 *  - Signed-in, snapshot arrived, tier ≥ 1 → `'pro'`.
 *  - Otherwise → `'free'`.
 *
 * Codex round-2 finding #1: anonymous users must never block on
 * entitlement loading.
 */
export function serviceEntitlementState(): ServiceEntitlementState {
  const user = _clerkUserGetter();
  if (!user) return 'free';
  const ent = _entitlementStateGetter();
  if (ent === null) return 'loading';
  return _hasTierFn(1) ? 'pro' : 'free';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current followed list as an ISO-2 array.
 *
 * Anonymous mode: localStorage. Signed-in mode (post-U3): user-scoped
 * Convex snapshot, optionally unioned with localStorage during
 * handoffPending.
 *
 * Sync, never throws. Empty/corrupt storage → [].
 */
export function getFollowed(): string[] {
  // TODO(U3): when signed-in & handoff complete, return the user-scoped
  // subscription snapshot. During handoffPending, return the
  // user-scoped union of localStorage + snapshot.
  return readLocalStorageList();
}

/** Sync `isFollowed` check; case-folds via `toIso2`. */
export function isFollowed(code: string): boolean {
  const norm = toIso2(code);
  if (!norm) return false;
  return getFollowed().includes(norm);
}

/**
 * Add a country to the followed list. Idempotent. Never throws —
 * returns a `FollowMutationResult` discriminated union.
 */
export async function addCountry(input: string): Promise<FollowMutationResult> {
  if (!isFeatureFlagEnabled()) return { ok: false, reason: 'DISABLED' };

  const code = toIso2(input);
  if (!code) return { ok: false, reason: 'INVALID_INPUT' };

  // TODO(U3): when in handoffPending, return HANDOFF_PENDING here.
  // For U2, _handoffState is always 'idle' so this branch is unreachable.
  if (_handoffState === 'pending' || _handoffState === 'failed') {
    return { ok: false, reason: 'HANDOFF_PENDING' };
  }

  const ent = serviceEntitlementState();
  if (ent === 'loading') {
    return { ok: false, reason: 'ENTITLEMENT_LOADING' };
  }

  const existing = getFollowed();

  // Idempotent: already followed → success no-op.
  if (existing.includes(code)) {
    return { ok: true };
  }

  if (ent === 'free' && existing.length >= FREE_TIER_FOLLOW_LIMIT) {
    return {
      ok: false,
      reason: 'FREE_CAP',
      currentCount: existing.length,
      limit: FREE_TIER_FOLLOW_LIMIT,
    };
  }

  // TODO(U3): when signed-in & handoff complete, call
  //   client.mutation(api.followedCountries.followCountry, { country: code })
  //   inside a try/catch; on ConvexError, extract `err.data.kind` and
  //   map FREE_CAP/INVALID_COUNTRY/UNAUTHENTICATED to the matching
  //   client `reason`.

  const next = [...existing, code];
  const wrote = writeLocalStorageList(next);
  if (!wrote) return { ok: false, reason: 'STORAGE_FULL' };

  dispatchChanged();
  return { ok: true };
}

/**
 * Remove a country from the followed list. Idempotent — removing a
 * country that isn't in the list returns `{ok:true}`.
 */
export async function removeCountry(
  input: string,
): Promise<FollowMutationResult> {
  if (!isFeatureFlagEnabled()) return { ok: false, reason: 'DISABLED' };

  const code = toIso2(input);
  if (!code) return { ok: false, reason: 'INVALID_INPUT' };

  if (_handoffState === 'pending' || _handoffState === 'failed') {
    return { ok: false, reason: 'HANDOFF_PENDING' };
  }

  const existing = getFollowed();
  if (!existing.includes(code)) {
    // Idempotent — not present is success.
    return { ok: true };
  }

  // TODO(U3): when signed-in & handoff complete, call
  //   client.mutation(api.followedCountries.unfollowCountry, { country: code })
  //   and map ConvexError kinds to client reasons.

  const next = existing.filter((c) => c !== code);
  const wrote = writeLocalStorageList(next);
  if (!wrote) return { ok: false, reason: 'STORAGE_FULL' };

  dispatchChanged();
  return { ok: true };
}

/**
 * Subscribe to followed-list changes. Fires after every successful
 * `addCountry` / `removeCountry` (anon mode); U3 will also fire on
 * Convex reactive query updates.
 *
 * Returns an unsubscribe function.
 */
export function subscribe(handler: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {
      /* no-op in non-browser env */
    };
  }
  window.addEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
  return () => {
    window.removeEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
  };
}
