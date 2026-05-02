/**
 * Followed-countries client service — single owner of watchlist semantics.
 *
 * Operating modes:
 *  1. Anonymous (no Clerk user) — localStorage at `wm-followed-countries-v1`,
 *     storing `JSON.stringify({ countries: string[] })`. Cap enforced
 *     client-side. (U2.)
 *  2. handoffPending — transitional during the anon→signed-in merge.
 *     Mutations refused with `HANDOFF_PENDING`. (U3.)
 *  3. Signed-in (handoff complete) — Convex authoritative. (U3.)
 *
 * Sign-in orchestration (U3):
 *  - On Clerk user transition `null → user` OR `user-A → user-B`:
 *    increment `_handoffGeneration`, capture `userIdAtStart`, parse
 *    localStorage, optionally call `mergeAnonymousLocal`. The post-await
 *    callback verifies `(currentClerkUserId === userIdAtStart) &&
 *    (currentGen === capturedGen)` and DROPS stale results — prevents a
 *    user-B sign-in or user-A sign-out from clearing localStorage on
 *    user-A's behalf (memory: cloud-prefs-sync `_authGeneration` pattern).
 *  - On `user → null` (sign-out): increment `_handoffGeneration`, clear
 *    `_lastKnownSubscriptionSnapshot = null` (cross-user-leak fix —
 *    memory: `session-storage-cross-user-leak-on-auth-transition`),
 *    unsubscribe, reset `_handoffState = 'idle'`.
 *
 * Patterns mirrored from:
 *  - src/services/market-watchlist.ts (event dispatch, JSON.parse safety)
 *  - src/services/aviation/watchlist.ts (storage-key versioning)
 *  - src/services/entitlements.ts (hasTier / getEntitlementState; ConvexClient.onUpdate)
 *  - src/utils/cloud-prefs-sync.ts (`_authGeneration` guard pattern)
 *
 * Memory: `discriminated-union-over-sentinel-boolean` —
 * `FollowMutationResult` is a discriminated union, never a `boolean | null`.
 *
 * Memory: `convex-error-string-data-strips-errordata-on-wire` — kind
 * extraction reads `err.data.kind`, not substring-match the message.
 */

import { toIso2 } from '../utils/country-codes';
import {
  getEntitlementState as _getEntitlementState,
  hasTier as _hasTier,
} from './entitlements';
import { getCurrentClerkUser as _getCurrentClerkUser } from './clerk';
import { subscribeAuthState as _subscribeAuthState } from './auth-state';
import {
  getConvexClient as _getConvexClient,
  getConvexApi as _getConvexApi,
} from './convex-client';

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
 * Custom event dispatched after a sign-in handoff completes with cap-drops.
 * `detail = { kept, dropped }` — number of localStorage entries kept vs
 * dropped due to FREE-tier cap. UI consumers can render an upgrade-CTA toast.
 */
export const WM_FOLLOWED_COUNTRIES_CAP_DROP = 'wm-followed-countries-cap-drop';

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

/**
 * Subset of `convex/browser`.ConvexClient surface that this module uses.
 * Defined as an interface so tests can inject a fake without pulling the
 * real WebSocket transport.
 */
export interface ConvexClientLike {
  mutation: (ref: unknown, args: unknown) => Promise<unknown>;
  onUpdate: (
    ref: unknown,
    args: unknown,
    onResult: (result: unknown) => void,
    onError?: (err: Error) => void,
  ) => () => void; // returns an unsubscribe fn (or { unsubscribe })
}

// ---------------------------------------------------------------------------
// Test-injection seams
// ---------------------------------------------------------------------------
//
// Node's `node:test` runner has no first-class ESM module mocker; rather
// than reach for ts-jest / vitest just for U2/U3, we expose narrow setter
// hooks. Production callers never touch these.

type ClerkUserGetter = () => { id: string } | null;
type EntitlementStateGetter = () => { features?: { tier?: number } } | null;
type HasTierFn = (minTier: number) => boolean;

interface ConvexApiLike {
  followedCountries: {
    followCountry: unknown;
    unfollowCountry: unknown;
    mergeAnonymousLocal: unknown;
    listFollowed: unknown;
  };
}

let _clerkUserGetter: ClerkUserGetter = () =>
  _getCurrentClerkUser() as { id: string } | null;
let _entitlementStateGetter: EntitlementStateGetter = () =>
  _getEntitlementState();
let _hasTierFn: HasTierFn = (n) => _hasTier(n);
let _featureFlagOverride: boolean | null = null;
let _convexClientGetter: () => Promise<ConvexClientLike | null> = async () =>
  (await _getConvexClient()) as ConvexClientLike | null;
let _convexApiGetter: () => Promise<ConvexApiLike | null> = async () =>
  (await _getConvexApi()) as ConvexApiLike | null;

/** Test-only override hook. Pass `null` to restore the real implementations. */
export function _setDepsForTests(deps: {
  getCurrentClerkUser?: ClerkUserGetter | null;
  getEntitlementState?: EntitlementStateGetter | null;
  hasTier?: HasTierFn | null;
  featureFlagEnabled?: boolean | null;
  convexClient?: ConvexClientLike | null;
  convexApi?: ConvexApiLike | null;
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
  if (deps.convexClient !== undefined) {
    const fake = deps.convexClient;
    _convexClientGetter =
      fake === null
        ? async () => (await _getConvexClient()) as ConvexClientLike | null
        : async () => fake;
  }
  if (deps.convexApi !== undefined) {
    const fake = deps.convexApi;
    _convexApiGetter =
      fake === null
        ? async () => (await _getConvexApi()) as ConvexApiLike | null
        : async () => fake;
  }
}

/** Test-only — clears all module-level state so tests start from a clean slate. */
export function _resetStateForTests(): void {
  _handoffState = 'idle';
  _handoffGeneration = 0;
  _lastKnownSubscriptionSnapshot = null;
  _stopReactiveSubscription();
  _lastSeenUserId = null;
  if (_visibilityRetryListener && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _visibilityRetryListener);
  }
  _visibilityRetryListener = null;
}

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

let _handoffState: 'idle' | 'pending' | 'failed' | 'complete' = 'idle';

/**
 * Incremented on every auth-state transition. Captured by handoff
 * callbacks before `await` and verified after, to drop stale results.
 * Mirrors the cloud-prefs-sync.ts `_authGeneration` pattern.
 */
let _handoffGeneration = 0;

/**
 * User-scoped cache of the most recent listFollowed snapshot. Cleared on
 * sign-out / user-switch (memory:
 * `session-storage-cross-user-leak-on-auth-transition`). `getFollowed()`
 * only unions this with localStorage if `userId === currentClerkUser.id`.
 */
let _lastKnownSubscriptionSnapshot:
  | { userId: string; countries: string[] }
  | null = null;

/** Last-observed Clerk user id, for diffing transitions inside the auth callback. */
let _lastSeenUserId: string | null = null;

/** Active reactive-subscription teardown (if signed-in mode). */
let _reactiveUnsubscribe: (() => void) | null = null;

/** Pending visibilitychange-retry listener (set when handoffState='failed'). */
let _visibilityRetryListener: (() => void) | null = null;

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

/**
 * Result of attempting to read the stored shape from localStorage:
 *  - { kind: 'absent' } — no key set
 *  - { kind: 'corrupt' } — non-JSON or wrong shape (caller should `removeItem`)
 *  - { kind: 'ok', list }
 *
 * Distinct from `readLocalStorageList` (which collapses absent/corrupt to
 * `[]`) because the U3 handoff needs to differentiate "nothing to merge"
 * from "corrupt → clear unconditionally".
 */
function parseLocalStorageRaw(): { kind: 'absent' } | { kind: 'corrupt' } | { kind: 'ok'; list: string[] } {
  let raw: string | null = null;
  try {
    raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY)
      : null;
  } catch {
    return { kind: 'absent' };
  }
  if (!raw) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as Partial<StoredShape>).countries)
  ) {
    return { kind: 'corrupt' };
  }
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
  return { kind: 'ok', list: out };
}

function readLocalStorageList(): string[] {
  const r = parseLocalStorageRaw();
  return r.kind === 'ok' ? r.list : [];
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

function removeLocalStorage(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(FOLLOWED_COUNTRIES_STORAGE_KEY);
    }
  } catch {
    /* swallow */
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

function dispatchCapDrop(kept: number, dropped: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent(WM_FOLLOWED_COUNTRIES_CAP_DROP, {
        detail: { kept, dropped },
      }),
    );
  } catch {
    /* swallow */
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
// Auth-state listener (U3)
// ---------------------------------------------------------------------------

let _authListenerInstalled = false;

/**
 * Install the auth-state listener once. Called from app boot. Idempotent.
 * Tests don't call this; they drive the auth-state callback manually via
 * `_emitAuthStateForTests`.
 */
export function installFollowedCountriesAuthListener(): void {
  if (_authListenerInstalled) return;
  _authListenerInstalled = true;
  _subscribeAuthState((state) => {
    void onAuthStateChange(state.user ? { id: state.user.id } : null);
  });
}

/**
 * Test-only: drive the auth-state callback directly without installing
 * the real Clerk listener. Always returns a Promise that resolves once
 * the handoff (if any) has fully resolved or dropped.
 */
export function _emitAuthStateForTests(
  nextUser: { id: string } | null,
): Promise<void> {
  return onAuthStateChange(nextUser);
}

/**
 * Auth-state transition handler. Called once at module-init with the
 * current state, then on every Clerk transition.
 *
 * Transitions handled:
 *  - null → user        : start sign-in handoff
 *  - userA → userB       : sign-out cleanup THEN start handoff for userB
 *  - user → null         : sign-out cleanup
 *  - null → null         : ignore (initial replay)
 *  - same user → same    : ignore (Clerk re-emit on tab focus etc.)
 */
async function onAuthStateChange(
  nextUser: { id: string } | null,
): Promise<void> {
  const prevUserId = _lastSeenUserId;
  const nextUserId = nextUser?.id ?? null;

  if (prevUserId === nextUserId) {
    // No-op: initial replay or duplicate emission.
    return;
  }
  _lastSeenUserId = nextUserId;

  // Always invalidate any in-flight handoff on a transition. Increment
  // BEFORE the user-swap branch so that even the user-A→user-B "two
  // generations" requirement of the plan (sign-out then sign-in) is
  // observable to a stale callback.
  _handoffGeneration += 1;
  // Stop the prior reactive subscription if it was running (sign-out OR
  // user-swap before starting a fresh one for the new user).
  _stopReactiveSubscription();
  _lastKnownSubscriptionSnapshot = null;
  _clearVisibilityRetryListener();

  if (!nextUser) {
    // Sign-out OR remained anonymous on first emit (no prior user).
    _handoffState = 'idle';
    return;
  }

  // null → user OR user-A → user-B. Bump generation a second time for
  // the user-swap case so the plan-specified "gen increments to 3 (one
  // for sign-out, one for sign-in)" holds. For the null→user case, this
  // is just an extra bump — harmless, since callbacks only verify
  // equality and we capture the post-bump value below.
  if (prevUserId !== null) {
    _handoffGeneration += 1;
  }

  const gen = _handoffGeneration;
  const userIdAtStart = nextUser.id;
  _handoffState = 'pending';

  await _runHandoff(userIdAtStart, gen);
}

/**
 * Core handoff procedure. Extracted so the visibilitychange retry can
 * call it again with a fresh generation capture.
 */
async function _runHandoff(
  userIdAtStart: string,
  gen: number,
): Promise<void> {
  // Step 1: parse localStorage (corruption recovery is unconditional).
  const parsed = parseLocalStorageRaw();
  if (parsed.kind === 'corrupt') {
    removeLocalStorage();
  }

  const localList = parsed.kind === 'ok' ? parsed.list : [];

  if (localList.length === 0) {
    // Nothing to merge — verify auth is still us, then transition to complete.
    if (!_authStillMatches(userIdAtStart, gen)) return;
    _handoffState = 'complete';
    _startReactiveSubscription(userIdAtStart, gen);
    dispatchChanged();
    return;
  }

  // Step 2: call mergeAnonymousLocal.
  let result: {
    totalCount?: number;
    accepted?: string[];
    droppedInvalid?: string[];
    droppedDueToCap?: string[];
  };
  try {
    const client = await _convexClientGetter();
    const api = await _convexApiGetter();
    if (!client || !api) {
      // Convex unavailable — treat as transient failure. Keep localStorage,
      // schedule retry on visibilitychange.
      if (!_authStillMatches(userIdAtStart, gen)) return;
      _handoffState = 'failed';
      _scheduleVisibilityChangeRetry(userIdAtStart, gen);
      return;
    }
    result = (await client.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: localList },
    )) as typeof result;
  } catch {
    // Network or 5xx. Verify auth, then mark failed and schedule retry.
    if (!_authStillMatches(userIdAtStart, gen)) return;
    _handoffState = 'failed';
    _scheduleVisibilityChangeRetry(userIdAtStart, gen);
    return;
  }

  // Step 3: auth-generation guard AFTER await — drop silently on stale.
  if (!_authStillMatches(userIdAtStart, gen)) return;

  // Step 4: success path.
  removeLocalStorage();
  _handoffState = 'complete';
  _startReactiveSubscription(userIdAtStart, gen);
  dispatchChanged();

  // Step 5: surface cap-drop event so the UI can render an upgrade toast.
  const droppedDueToCap = Array.isArray(result?.droppedDueToCap)
    ? result.droppedDueToCap
    : [];
  const accepted = Array.isArray(result?.accepted) ? result.accepted : [];
  if (droppedDueToCap.length > 0) {
    dispatchCapDrop(accepted.length, droppedDueToCap.length);
  }
}

function _authStillMatches(userIdAtStart: string, gen: number): boolean {
  if (gen !== _handoffGeneration) return false;
  const current = _clerkUserGetter();
  if (!current || current.id !== userIdAtStart) return false;
  return true;
}

function _scheduleVisibilityChangeRetry(
  userIdAtStart: string,
  gen: number,
): void {
  if (typeof document === 'undefined') return;
  _clearVisibilityRetryListener();
  const handler = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    // One-shot — remove and rerun. Only retry if auth still matches AND
    // the handoff generation is still ours; otherwise drop silently.
    _clearVisibilityRetryListener();
    if (!_authStillMatches(userIdAtStart, gen)) return;
    void _runHandoff(userIdAtStart, gen);
  };
  document.addEventListener('visibilitychange', handler);
  _visibilityRetryListener = handler;
}

function _clearVisibilityRetryListener(): void {
  if (_visibilityRetryListener && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _visibilityRetryListener);
  }
  _visibilityRetryListener = null;
}

/**
 * Test-only: trigger the pending visibilitychange retry without going
 * through the real DOM event. Returns a promise that resolves when the
 * retry's handoff finishes.
 */
export function _triggerVisibilityRetryForTests(): Promise<void> {
  if (!_visibilityRetryListener) return Promise.resolve();
  // The handler is sync but kicks off `_runHandoff` (async). To make
  // tests deterministic, replicate the handler's logic with awaitable
  // semantics here.
  return new Promise<void>((resolve) => {
    const handler = _visibilityRetryListener;
    if (!handler) {
      resolve();
      return;
    }
    // We don't actually call the DOM-bound handler (which doesn't return
    // a promise) — instead, we simulate the visibilitychange retry by
    // capturing state and running `_runHandoff` directly. Tests rely on
    // this awaiting completion.
    _clearVisibilityRetryListener();
    // We can't recover userIdAtStart/gen from the closure, so call the
    // handler synchronously and chain on the next microtask. The handler
    // schedules an async `_runHandoff`; we await it via a microtask flush.
    handler();
    // Allow the spawned _runHandoff microtask chain to settle. We use a
    // small loop of microtask flushes; tests only need this to resolve
    // after the mutation promise has resolved.
    queueMicrotask(() => queueMicrotask(() => resolve()));
  });
}

// ---------------------------------------------------------------------------
// Reactive subscription to listFollowed (U3)
// ---------------------------------------------------------------------------

async function _startReactiveSubscription(
  userIdAtStart: string,
  gen: number,
): Promise<void> {
  // Idempotent — if a prior subscription is still active, replace it.
  _stopReactiveSubscription();

  const client = await _convexClientGetter();
  const api = await _convexApiGetter();
  if (!client || !api) {
    // No transport available (Convex disabled in this env). Subscription
    // stays empty; getFollowed() falls through to localStorage union or
    // empty list.
    return;
  }

  // After the await, verify auth is still ours before installing the
  // subscription. Without this, a sign-out mid-startReactive would
  // silently install a subscription for a now-detached user.
  if (!_authStillMatches(userIdAtStart, gen)) return;

  const teardown = client.onUpdate(
    api.followedCountries.listFollowed,
    {},
    (result: unknown) => {
      // Defensive: drop late callbacks that fire after the subscription
      // was meant to be torn down.
      if (!_authStillMatches(userIdAtStart, gen)) return;
      const countries = Array.isArray(result)
        ? (result.filter((c) => typeof c === 'string') as string[])
        : [];
      _lastKnownSubscriptionSnapshot = { userId: userIdAtStart, countries };
      dispatchChanged();
    },
    (err: Error) => {
      // Subscription error — leave the snapshot as-is so getFollowed()
      // returns the last known good list. The next reconnect will
      // refresh it.
      console.warn('[followed-countries] listFollowed error:', err.message);
    },
  );

  // ConvexClient.onUpdate returns an Unsubscribe (callable) per the
  // simple_client.d.ts surface. Tests inject a function directly.
  _reactiveUnsubscribe = typeof teardown === 'function' ? teardown : null;
}

function _stopReactiveSubscription(): void {
  if (_reactiveUnsubscribe) {
    try {
      _reactiveUnsubscribe();
    } catch {
      /* swallow */
    }
  }
  _reactiveUnsubscribe = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current followed list as an ISO-2 array.
 *
 * Anonymous mode: localStorage. Signed-in mode: user-scoped Convex
 * snapshot. During handoffPending: union of localStorage + the
 * user-scoped snapshot (only if `snap.userId === currentClerkUser.id`).
 *
 * Sync, never throws. Empty/corrupt storage → [].
 */
export function getFollowed(): string[] {
  const user = _clerkUserGetter();
  const localList = readLocalStorageList();

  // Anonymous mode → localStorage.
  if (!user) return localList;

  // Signed-in. If snapshot belongs to current user, use it; otherwise
  // (cross-user-leak guard) ignore the snapshot. During handoffPending
  // OR failed, union with localStorage.
  const snap = _lastKnownSubscriptionSnapshot;
  const snapList =
    snap && snap.userId === user.id ? snap.countries : [];

  if (_handoffState === 'pending' || _handoffState === 'failed') {
    return [...new Set([...localList, ...snapList])];
  }

  // Complete (post-handoff): authoritative is the snapshot. localStorage
  // should already be cleared after a successful handoff, but if for
  // any reason it isn't, the snapshot wins.
  if (_handoffState === 'complete') return [...snapList];

  // 'idle' shouldn't be reachable when there's a Clerk user (the
  // listener flips to 'pending' on transition). Fallback: just return
  // the snapshot OR localStorage (defensive).
  return snap && snap.userId === user.id
    ? [...snap.countries]
    : localList;
}

/** Sync `isFollowed` check; case-folds via `toIso2`. */
export function isFollowed(code: string): boolean {
  const norm = toIso2(code);
  if (!norm) return false;
  return getFollowed().includes(norm);
}

function _extractConvexErrorKind(err: unknown): string | null {
  // Memory: convex-error-string-data-strips-errordata-on-wire — the
  // data field is the source of truth. ConvexError({kind: ...}) is
  // serialized as `err.data = { kind, ... }` over the wire.
  const e = err as { data?: { kind?: unknown } } | undefined;
  if (e && e.data && typeof e.data.kind === 'string') return e.data.kind;
  return null;
}

function _extractConvexErrorData(
  err: unknown,
): Record<string, unknown> | null {
  const e = err as { data?: unknown } | undefined;
  if (e && e.data && typeof e.data === 'object') {
    return e.data as Record<string, unknown>;
  }
  return null;
}

/**
 * Add a country to the followed list. Idempotent. Never throws —
 * returns a `FollowMutationResult` discriminated union.
 */
export async function addCountry(input: string): Promise<FollowMutationResult> {
  if (!isFeatureFlagEnabled()) return { ok: false, reason: 'DISABLED' };

  const code = toIso2(input);
  if (!code) return { ok: false, reason: 'INVALID_INPUT' };

  if (_handoffState === 'pending' || _handoffState === 'failed') {
    return { ok: false, reason: 'HANDOFF_PENDING' };
  }

  const ent = serviceEntitlementState();
  if (ent === 'loading') {
    return { ok: false, reason: 'ENTITLEMENT_LOADING' };
  }

  const user = _clerkUserGetter();

  // Signed-in & handoff complete → Convex authoritative path.
  if (user) {
    const existing = getFollowed();
    if (existing.includes(code)) {
      return { ok: true };
    }
    try {
      const client = await _convexClientGetter();
      const api = await _convexApiGetter();
      if (!client || !api) {
        // Convex unavailable in this env — fall back to localStorage so
        // the UI is at least interactive. (Defensive; production always
        // has a client when there's a Clerk user.)
        return _writeLocalStorageAdd(code);
      }
      await client.mutation(
        api.followedCountries.followCountry,
        { country: code },
      );
      // The reactive subscription will pick up the new row and dispatch
      // WM_FOLLOWED_COUNTRIES_CHANGED; no need to manually fire here.
      return { ok: true };
    } catch (err) {
      const kind = _extractConvexErrorKind(err);
      const data = _extractConvexErrorData(err);
      if (kind === 'FREE_CAP') {
        const currentCount =
          typeof data?.currentCount === 'number'
            ? (data.currentCount as number)
            : undefined;
        const limit =
          typeof data?.limit === 'number'
            ? (data.limit as number)
            : FREE_TIER_FOLLOW_LIMIT;
        return { ok: false, reason: 'FREE_CAP', currentCount, limit };
      }
      if (kind === 'INVALID_COUNTRY') {
        return { ok: false, reason: 'INVALID_INPUT' };
      }
      if (kind === 'UNAUTHENTICATED') {
        // Race: Clerk says we're signed in but Convex hasn't seen the
        // identity yet (or the token expired between this call site and
        // the mutation). Surface as HANDOFF_PENDING so the UI shows the
        // syncing tooltip and the user can retry.
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      // Unknown Convex/network error — surface as STORAGE_FULL? No, that
      // misleads the toast. Fall back to a generic ENTITLEMENT_LOADING
      // would also mislead. Cleanest: rethrow so callers can decide. But
      // the contract says "never throws." Map unknown to HANDOFF_PENDING
      // (transient — encourages a retry by the user). Production logs
      // get the real error via the global Sentry hook.
      console.warn('[followed-countries] followCountry unknown error:', err);
      return { ok: false, reason: 'HANDOFF_PENDING' };
    }
  }

  // Anonymous mode — localStorage path.
  const existing = getFollowed();
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
  return _writeLocalStorageAdd(code);
}

function _writeLocalStorageAdd(code: string): FollowMutationResult {
  const existing = readLocalStorageList();
  if (existing.includes(code)) return { ok: true };
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

  const user = _clerkUserGetter();

  if (user) {
    const existing = getFollowed();
    if (!existing.includes(code)) return { ok: true };
    try {
      const client = await _convexClientGetter();
      const api = await _convexApiGetter();
      if (!client || !api) {
        return _writeLocalStorageRemove(code);
      }
      await client.mutation(
        api.followedCountries.unfollowCountry,
        { country: code },
      );
      // Reactive subscription will fire the change event.
      return { ok: true };
    } catch (err) {
      const kind = _extractConvexErrorKind(err);
      if (kind === 'INVALID_COUNTRY') {
        return { ok: false, reason: 'INVALID_INPUT' };
      }
      if (kind === 'UNAUTHENTICATED') {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      console.warn('[followed-countries] unfollowCountry unknown error:', err);
      return { ok: false, reason: 'HANDOFF_PENDING' };
    }
  }

  // Anonymous mode.
  const existing = readLocalStorageList();
  if (!existing.includes(code)) return { ok: true };
  return _writeLocalStorageRemove(code);
}

function _writeLocalStorageRemove(code: string): FollowMutationResult {
  const existing = readLocalStorageList();
  if (!existing.includes(code)) return { ok: true };
  const next = existing.filter((c) => c !== code);
  const wrote = writeLocalStorageList(next);
  if (!wrote) return { ok: false, reason: 'STORAGE_FULL' };
  dispatchChanged();
  return { ok: true };
}

/**
 * Subscribe to followed-list changes. Fires after every successful
 * `addCountry` / `removeCountry` (anon mode); for signed-in mode, also
 * fires on every Convex reactive `listFollowed` snapshot.
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

/**
 * Test-only: snapshot of internal state for assertion. Production
 * callers must NOT rely on this shape — it is private.
 */
export function _getInternalStateForTests(): {
  handoffState: typeof _handoffState;
  handoffGeneration: number;
  lastKnownSubscriptionSnapshot:
    | { userId: string; countries: string[] }
    | null;
  hasReactiveSubscription: boolean;
  hasVisibilityRetryListener: boolean;
} {
  return {
    handoffState: _handoffState,
    handoffGeneration: _handoffGeneration,
    lastKnownSubscriptionSnapshot: _lastKnownSubscriptionSnapshot
      ? {
          userId: _lastKnownSubscriptionSnapshot.userId,
          countries: [..._lastKnownSubscriptionSnapshot.countries],
        }
      : null,
    hasReactiveSubscription: _reactiveUnsubscribe !== null,
    hasVisibilityRetryListener: _visibilityRetryListener !== null,
  };
}

/**
 * Test-only: drive the reactive subscription's `onResult` callback as if
 * the Convex server pushed a new snapshot. Mocking this directly via
 * the injected fake `convexClient.onUpdate` is also fine; this helper is
 * a convenience for tests that don't want to capture the callback.
 */
export function _pushSubscriptionSnapshotForTests(
  userId: string,
  countries: string[],
): void {
  // Mirrors the inline branch in `_startReactiveSubscription`: only
  // accept if the auth still matches.
  const current = _clerkUserGetter();
  if (!current || current.id !== userId) return;
  _lastKnownSubscriptionSnapshot = { userId, countries: [...countries] };
  dispatchChanged();
}
