/**
 * Tests for src/services/followed-countries.ts U3 — sign-in handoff,
 * auth-generation guard, reactive subscription, sign-out cleanup,
 * handoffPending UX, visibilitychange retry.
 *
 * Test runner: node:test via `tsx --test tests/*.test.mjs`.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Browser-global stubs
// ---------------------------------------------------------------------------

class MemoryStorage {
  constructor() {
    this.store = new Map();
    this.throwOnSet = false;
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    if (this.throwOnSet) {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

class FakeWindow extends EventTarget {}
class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.hidden = false;
  }
}

let _localStorage;
let _window;
let _document;

before(() => {
  _localStorage = new MemoryStorage();
  _window = new FakeWindow();
  _document = new FakeDocument();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: _localStorage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: _window,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: _document,
  });
  if (typeof globalThis.CustomEvent === 'undefined') {
    globalThis.CustomEvent = class extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.detail = init.detail;
      }
    };
  }
});

after(() => {
  delete globalThis.localStorage;
  delete globalThis.window;
  delete globalThis.document;
});

beforeEach(() => {
  _localStorage.clear();
  _localStorage.throwOnSet = false;
});

// ---------------------------------------------------------------------------
// Import service
// ---------------------------------------------------------------------------

const svc = await import('../src/services/followed-countries.ts');
const {
  addCountry,
  removeCountry,
  getFollowed,
  subscribe,
  FOLLOWED_COUNTRIES_STORAGE_KEY,
  WM_FOLLOWED_COUNTRIES_CHANGED,
  WM_FOLLOWED_COUNTRIES_CAP_DROP,
  _setDepsForTests,
  _resetStateForTests,
  _emitAuthStateForTests,
  _getInternalStateForTests,
  _pushSubscriptionSnapshotForTests,
} = svc;

// ---------------------------------------------------------------------------
// Fake Convex client
// ---------------------------------------------------------------------------

const FAKE_API = {
  followedCountries: {
    followCountry: 'fake:followCountry',
    unfollowCountry: 'fake:unfollowCountry',
    mergeAnonymousLocal: 'fake:mergeAnonymousLocal',
    listFollowed: 'fake:listFollowed',
  },
};

const ISO_RE = /^[A-Z]{2}$/;

function makeFakeConvex({
  tier = 1,
  capLimit = 3,
  initialRows = [],
  mergeRejection = null, // optional Error to throw from mergeAnonymousLocal
  mergeDelayMs = 0,
} = {}) {
  let rows = initialRows.map((c, i) => ({ country: c, addedAt: 1000 + i }));
  let listFollowedCb = null;
  const calls = { follow: [], unfollow: [], merge: [] };

  const ConvexErrorCtor = class extends Error {
    constructor(data) {
      super(`ConvexError: ${data.kind}`);
      this.data = data;
    }
  };

  const fireSnapshot = () => {
    if (!listFollowedCb) return;
    const sorted = [...rows]
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((r) => r.country);
    listFollowedCb(sorted);
  };

  const client = {
    async mutation(ref, args) {
      if (ref === FAKE_API.followedCountries.followCountry) {
        calls.follow.push(args);
        const { country } = args;
        if (rows.find((r) => r.country === country)) return { ok: true, idempotent: true };
        if (tier < 1 && rows.length >= capLimit) {
          throw new ConvexErrorCtor({ kind: 'FREE_CAP', currentCount: rows.length, limit: capLimit });
        }
        rows.push({ country, addedAt: Date.now() + rows.length });
        fireSnapshot();
        return { ok: true, idempotent: false };
      }
      if (ref === FAKE_API.followedCountries.unfollowCountry) {
        calls.unfollow.push(args);
        const { country } = args;
        const idx = rows.findIndex((r) => r.country === country);
        if (idx === -1) return { ok: true, idempotent: true };
        rows.splice(idx, 1);
        fireSnapshot();
        return { ok: true, idempotent: false };
      }
      if (ref === FAKE_API.followedCountries.mergeAnonymousLocal) {
        calls.merge.push(args);
        if (mergeDelayMs > 0) await new Promise((r) => setTimeout(r, mergeDelayMs));
        if (mergeRejection) throw mergeRejection;
        const { countries } = args;
        if (countries.length === 0) throw new ConvexErrorCtor({ kind: 'EMPTY_INPUT' });
        const droppedInvalid = [];
        const validInputs = [];
        for (const c of countries) {
          if (typeof c === 'string' && ISO_RE.test(c)) validInputs.push(c);
          else droppedInvalid.push(c);
        }
        const seen = new Set();
        const canonical = [];
        for (const c of validInputs) if (!seen.has(c)) { seen.add(c); canonical.push(c); }
        const existingSet = new Set(rows.map((r) => r.country));
        const newCandidates = canonical.filter((c) => !existingSet.has(c));
        let accepted, droppedDueToCap;
        if (tier < 1) {
          const remaining = Math.max(0, capLimit - rows.length);
          accepted = newCandidates.slice(0, remaining);
          droppedDueToCap = newCandidates.slice(remaining);
        } else {
          accepted = newCandidates;
          droppedDueToCap = [];
        }
        for (const country of accepted) {
          rows.push({ country, addedAt: Date.now() + rows.length });
        }
        if (accepted.length > 0) fireSnapshot();
        return {
          totalCount: rows.length,
          accepted,
          droppedInvalid,
          droppedDueToCap,
        };
      }
      throw new Error(`unmocked mutation ref: ${ref}`);
    },
    onUpdate(ref, _args, onResult /* , onError */) {
      if (ref === FAKE_API.followedCountries.listFollowed) {
        listFollowedCb = onResult;
        Promise.resolve().then(() => {
          const sorted = [...rows].sort((a, b) => a.addedAt - b.addedAt).map((r) => r.country);
          if (listFollowedCb === onResult) onResult(sorted);
        });
        return () => { if (listFollowedCb === onResult) listFollowedCb = null; };
      }
      throw new Error(`unmocked subscription ref: ${ref}`);
    },
    _calls: calls,
    _getRows: () => rows.map((r) => r.country),
    _push: fireSnapshot,
  };
  return client;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setLocalStorageList(list) {
  _localStorage.setItem(FOLLOWED_COUNTRIES_STORAGE_KEY, JSON.stringify({ countries: list }));
}

function getLocalStorageRaw() {
  return _localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY);
}

async function flushMicrotasks() {
  // Flush a few rounds — fake onUpdate fires its initial snapshot via
  // queueMicrotask, and getFollowed() relies on the subscription state.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function setupAnonymous() {
  _setDepsForTests({
    getCurrentClerkUser: () => null,
    getEntitlementState: () => null,
    hasTier: () => false,
    featureFlagEnabled: true,
    convexClient: null,
    convexApi: null,
  });
}

function setupSignedIn(userId, { tier = 1, fakeClient }) {
  _setDepsForTests({
    getCurrentClerkUser: () => ({ id: userId }),
    getEntitlementState: () => ({ features: { tier } }),
    hasTier: (n) => n <= tier,
    featureFlagEnabled: true,
    convexClient: fakeClient,
    convexApi: FAKE_API,
  });
}

beforeEach(() => {
  _resetStateForTests();
  setupAnonymous();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('U3 — happy: anon localStorage merged, table union, event fires', () => {
  it("anon ['US','GB'] + table ['US','JP'] → final ['US','JP','GB']; localStorage cleared; event fires", async () => {
    setLocalStorageList(['US', 'GB']);
    const fake = makeFakeConvex({ tier: 1, initialRows: ['US', 'JP'] });
    setupSignedIn('user_1', { tier: 1, fakeClient: fake });

    let events = 0;
    const unsub = subscribe(() => events++);

    await _emitAuthStateForTests({ id: 'user_1' });
    await flushMicrotasks();

    assert.deepEqual(fake._getRows(), ['US', 'JP', 'GB']);
    assert.equal(getLocalStorageRaw(), null, 'localStorage cleared');
    assert.equal(_getInternalStateForTests().handoffState, 'complete');
    assert.deepEqual(getFollowed().sort(), ['GB', 'JP', 'US']);
    assert.ok(events >= 1, 'change event fires');

    unsub();
  });
});

describe('U3 — happy: empty localStorage skips merge', () => {
  it('anon empty localStorage; signs in; mergeAnonymousLocal NOT called', async () => {
    // Empty array stored:
    setLocalStorageList([]);
    const fake = makeFakeConvex({ tier: 1, initialRows: [] });
    setupSignedIn('user_e', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_e' });
    await flushMicrotasks();

    assert.equal(fake._calls.merge.length, 0, 'merge NOT called');
    assert.equal(_getInternalStateForTests().handoffState, 'complete');
  });

  it('no localStorage entry at all → mergeAnonymousLocal NOT called', async () => {
    const fake = makeFakeConvex({ tier: 1 });
    setupSignedIn('user_z', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_z' });
    await flushMicrotasks();

    assert.equal(fake._calls.merge.length, 0);
    assert.equal(_getInternalStateForTests().handoffState, 'complete');
  });
});

describe('U3 — edge: corrupt localStorage cleared unconditionally', () => {
  it("'not-valid-json' → mergeAnonymousLocal NOT called; localStorage cleared", async () => {
    _localStorage.setItem(FOLLOWED_COUNTRIES_STORAGE_KEY, 'not-valid-json');
    const fake = makeFakeConvex({ tier: 1 });
    setupSignedIn('user_c', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_c' });
    await flushMicrotasks();

    assert.equal(fake._calls.merge.length, 0);
    assert.equal(getLocalStorageRaw(), null, 'corrupt localStorage cleared');
    assert.equal(_getInternalStateForTests().handoffState, 'complete');
  });

  it("wrong shape '[{symbol:AAPL}]' → mergeAnonymousLocal NOT called; localStorage cleared", async () => {
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify([{ symbol: 'AAPL' }]),
    );
    const fake = makeFakeConvex({ tier: 1 });
    setupSignedIn('user_w', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_w' });
    await flushMicrotasks();

    assert.equal(fake._calls.merge.length, 0);
    assert.equal(getLocalStorageRaw(), null);
  });
});

describe('U3 — edge: free user cap-bounded merge', () => {
  it("anon ['US','GB'], table ['JP','CN'] → accepts 'US' only, drops 'GB'; cap-drop event fires", async () => {
    setLocalStorageList(['US', 'GB']);
    const fake = makeFakeConvex({ tier: 0, capLimit: 3, initialRows: ['JP', 'CN'] });
    setupSignedIn('user_f', { tier: 0, fakeClient: fake });

    let capDropDetail = null;
    const handler = (ev) => { capDropDetail = ev.detail; };
    _window.addEventListener(WM_FOLLOWED_COUNTRIES_CAP_DROP, handler);

    await _emitAuthStateForTests({ id: 'user_f' });
    await flushMicrotasks();

    assert.deepEqual(fake._getRows().sort(), ['CN', 'JP', 'US']);
    assert.deepEqual(capDropDetail, { kept: 1, dropped: 1 });

    _window.removeEventListener(WM_FOLLOWED_COUNTRIES_CAP_DROP, handler);
  });
});

describe('U3 — edge: mutation returns multi-cap drops', () => {
  it("anon ['US','GB','JP','CN'], no rows → kept 3, dropped 1; toast detail kept=3 dropped=1", async () => {
    setLocalStorageList(['US', 'GB', 'JP', 'CN']);
    const fake = makeFakeConvex({ tier: 0, capLimit: 3, initialRows: [] });
    setupSignedIn('user_m', { tier: 0, fakeClient: fake });

    let detail = null;
    const handler = (ev) => { detail = ev.detail; };
    _window.addEventListener(WM_FOLLOWED_COUNTRIES_CAP_DROP, handler);

    await _emitAuthStateForTests({ id: 'user_m' });
    await flushMicrotasks();

    assert.deepEqual(detail, { kept: 3, dropped: 1 });

    _window.removeEventListener(WM_FOLLOWED_COUNTRIES_CAP_DROP, handler);
  });
});

describe('U3 — edge: network failure → handoffState=failed, localStorage retained', () => {
  it('mergeAnonymousLocal rejects → state=failed, localStorage intact, visibility retry scheduled', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({
      tier: 1,
      mergeRejection: new Error('NetworkError'),
    });
    setupSignedIn('user_n', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_n' });
    await flushMicrotasks();

    assert.equal(_getInternalStateForTests().handoffState, 'failed');
    assert.notEqual(getLocalStorageRaw(), null, 'localStorage retained');
    assert.equal(_getInternalStateForTests().hasVisibilityRetryListener, true);
  });

  it('visibilitychange retry succeeds after fix', async () => {
    setLocalStorageList(['US']);
    let shouldFail = true;
    const ConvexErrorCtor = class extends Error {
      constructor(data) {
        super(`ConvexError: ${data.kind}`);
        this.data = data;
      }
    };
    void ConvexErrorCtor;
    const rows = [];
    let listCb = null;
    const fake = {
      async mutation(ref, args) {
        if (ref === FAKE_API.followedCountries.mergeAnonymousLocal) {
          if (shouldFail) throw new Error('NetworkError');
          for (const c of args.countries) rows.push(c);
          if (listCb) listCb(rows.slice());
          return { totalCount: rows.length, accepted: args.countries, droppedInvalid: [], droppedDueToCap: [] };
        }
        throw new Error(`unmocked: ${ref}`);
      },
      onUpdate(ref, _a, onResult) {
        if (ref === FAKE_API.followedCountries.listFollowed) {
          listCb = onResult;
          Promise.resolve().then(() => onResult(rows.slice()));
          return () => { if (listCb === onResult) listCb = null; };
        }
        throw new Error(`unmocked: ${ref}`);
      },
    };
    setupSignedIn('user_r', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_r' });
    await flushMicrotasks();
    assert.equal(_getInternalStateForTests().handoffState, 'failed');

    // Now flip the failure switch and trigger visibilitychange.
    shouldFail = false;
    _document.dispatchEvent(new Event('visibilitychange'));
    // The handler kicks off async _runHandoff. Wait for it.
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(_getInternalStateForTests().handoffState, 'complete');
    assert.equal(getLocalStorageRaw(), null);
  });
});

describe('U3 — critical: in-flight auth race, sign-out', () => {
  it('user-1 signs in → handoff in-flight → user-1 signs out → result dropped, localStorage NOT cleared', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({ tier: 1, mergeDelayMs: 20 });

    setupSignedIn('user_1', { tier: 1, fakeClient: fake });

    // Kick off handoff but don't await it.
    const handoffPromise = _emitAuthStateForTests({ id: 'user_1' });

    // Mid-await, sign out.
    setupAnonymous();
    await _emitAuthStateForTests(null);

    // Now let the merge resolve.
    await handoffPromise;
    await flushMicrotasks();

    // localStorage should be intact (handoff dropped its result).
    const raw = getLocalStorageRaw();
    assert.notEqual(raw, null);
    assert.deepEqual(JSON.parse(raw).countries, ['US']);
    // No subscription should be active.
    assert.equal(_getInternalStateForTests().hasReactiveSubscription, false);
    // State back to idle (sign-out resets it).
    assert.equal(_getInternalStateForTests().handoffState, 'idle');
  });
});

describe('U3 — critical: in-flight auth race, user swap', () => {
  it("user-1's handoff → user-1 out, user-2 in → user-1's result dropped via userIdAtStart guard", async () => {
    setLocalStorageList(['US']);
    const fake1 = makeFakeConvex({ tier: 1, mergeDelayMs: 30 });
    setupSignedIn('user_1', { tier: 1, fakeClient: fake1 });

    const handoffPromise = _emitAuthStateForTests({ id: 'user_1' });

    // Sign out user-1 then sign in user-2.
    setupAnonymous();
    await _emitAuthStateForTests(null);

    const fake2 = makeFakeConvex({ tier: 1, initialRows: [] });
    setupSignedIn('user_2', { tier: 1, fakeClient: fake2 });
    const handoff2 = _emitAuthStateForTests({ id: 'user_2' });

    await handoffPromise;
    await handoff2;
    await flushMicrotasks();

    // user-1's merge happened on their fake, but the result was DROPPED.
    // What matters is that we are now in user-2's complete state with
    // user-2's snapshot, NOT user-1's.
    const internal = _getInternalStateForTests();
    assert.equal(internal.handoffState, 'complete');
    if (internal.lastKnownSubscriptionSnapshot) {
      assert.equal(internal.lastKnownSubscriptionSnapshot.userId, 'user_2');
    }
    // _handoffGeneration should have advanced multiple steps. Each
    // listener-emit increments by 1; user-swap branch adds a 2nd bump.
    // Initial setup + sign-in (1) → sign-out (1, no second since prev=null after reset) →
    // sign-in user_2 (1+1 user-swap branch). At least 3 increments observed.
    assert.ok(internal.handoffGeneration >= 3, `gen advanced (>=3): got ${internal.handoffGeneration}`);
  });
});

describe('U3 — handoffPending blocks writes', () => {
  it('addCountry during handoff returns HANDOFF_PENDING', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({ tier: 1, mergeDelayMs: 30 });
    setupSignedIn('user_p', { tier: 1, fakeClient: fake });

    const handoffPromise = _emitAuthStateForTests({ id: 'user_p' });

    // Mid-handoff, attempt addCountry.
    const result = await addCountry('FR');
    assert.deepEqual(result, { ok: false, reason: 'HANDOFF_PENDING' });

    // Let handoff complete.
    await handoffPromise;
    await flushMicrotasks();

    // Now addCountry should succeed.
    const r2 = await addCountry('FR');
    assert.deepEqual(r2, { ok: true });
  });

  it('removeCountry during handoff returns HANDOFF_PENDING', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({ tier: 1, mergeDelayMs: 30 });
    setupSignedIn('user_r2', { tier: 1, fakeClient: fake });

    const handoffPromise = _emitAuthStateForTests({ id: 'user_r2' });
    const result = await removeCountry('US');
    assert.deepEqual(result, { ok: false, reason: 'HANDOFF_PENDING' });

    await handoffPromise;
    await flushMicrotasks();
  });
});

describe('U3 — handoffPending getFollowed', () => {
  it('returns union of localStorage + user-scoped snapshot during handoff', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({ tier: 1, initialRows: ['JP'], mergeDelayMs: 30 });
    setupSignedIn('user_g', { tier: 1, fakeClient: fake });

    // Kick off handoff first; auth-state emit clears any prior snapshot.
    const handoffPromise = _emitAuthStateForTests({ id: 'user_g' });

    // Now push a user-scoped snapshot DURING pending — represents a
    // cross-tab subscription update arriving before this tab's merge
    // completes.
    _pushSubscriptionSnapshotForTests('user_g', ['JP']);

    const mid = getFollowed();
    // Pending phase — union of localStorage ['US'] and snapshot ['JP'].
    assert.deepEqual(mid.sort(), ['JP', 'US']);

    await handoffPromise;
    await flushMicrotasks();

    // Post-complete: snapshot from server wins.
    const after = getFollowed();
    assert.ok(after.includes('US') && after.includes('JP'));
  });

  it('snapshot from a DIFFERENT user is ignored (cross-user-leak guard)', async () => {
    // Sign in as user_curr, push their snapshot.
    const fake = makeFakeConvex({ tier: 1, initialRows: ['JP'] });
    setupSignedIn('user_curr', { tier: 1, fakeClient: fake });
    await _emitAuthStateForTests({ id: 'user_curr' });
    await flushMicrotasks();

    // Snapshot is now { userId: 'user_curr', countries: ['JP'] }.
    const before = _getInternalStateForTests().lastKnownSubscriptionSnapshot;
    assert.equal(before?.userId, 'user_curr');

    // Now switch to anonymous WITHOUT clearing the snapshot first
    // (tests the cross-user-leak guard in `getFollowed`).
    // The way to do this: keep the deps as user_curr but pretend
    // getCurrentClerkUser flipped to a different user_other identity
    // (simulates a Clerk-listener-vs-getCurrentClerkUser race window).
    _setDepsForTests({
      getCurrentClerkUser: () => ({ id: 'user_other' }),
    });
    // Now getFollowed should NOT include 'JP' (snapshot belongs to
    // user_curr, not user_other).
    const list = getFollowed();
    assert.equal(list.includes('JP'), false, 'cross-user snapshot ignored');
  });
});

describe('U3 — sign-out clears subscription snapshot (cross-user-leak fix)', () => {
  it('user-1 signs in, gets snapshot, signs out → snapshot cleared, getFollowed returns []', async () => {
    setLocalStorageList([]);
    const fake = makeFakeConvex({ tier: 1, initialRows: ['US', 'JP'] });
    setupSignedIn('user_clean', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_clean' });
    await flushMicrotasks();

    // Snapshot present.
    const snap = _getInternalStateForTests().lastKnownSubscriptionSnapshot;
    assert.equal(snap?.userId, 'user_clean');
    assert.deepEqual(snap.countries.sort(), ['JP', 'US']);

    // Now sign out.
    setupAnonymous();
    await _emitAuthStateForTests(null);

    assert.equal(_getInternalStateForTests().lastKnownSubscriptionSnapshot, null);
    assert.deepEqual(getFollowed(), [], 'anonymous follow list reset');
  });
});

describe('U3 — sign-in → sign-out → different user merges anew', () => {
  it("user-1 signs in (no localStorage), signs out, user-2 signs in with their own anon localStorage", async () => {
    // user-1 path
    setLocalStorageList([]);
    const fake1 = makeFakeConvex({ tier: 1, initialRows: ['DE'] });
    setupSignedIn('user_a', { tier: 1, fakeClient: fake1 });
    await _emitAuthStateForTests({ id: 'user_a' });
    await flushMicrotasks();

    // sign out (preserves localStorage per design)
    setupAnonymous();
    await _emitAuthStateForTests(null);

    // user-2 — anon list ['FR'] left on device; user-2 signs in
    setLocalStorageList(['FR']);
    const fake2 = makeFakeConvex({ tier: 1, initialRows: [] });
    setupSignedIn('user_b', { tier: 1, fakeClient: fake2 });
    await _emitAuthStateForTests({ id: 'user_b' });
    await flushMicrotasks();

    // user-2's table should have FR (merged from anon).
    assert.deepEqual(fake2._getRows(), ['FR']);
    // user-1's fake was untouched after sign-out.
    assert.deepEqual(fake1._getRows(), ['DE']);
  });
});

describe('U3 — reactive query updates dispatch change events', () => {
  it('cross-tab follow → snapshot pushed → WM_FOLLOWED_COUNTRIES_CHANGED fires', async () => {
    const fake = makeFakeConvex({ tier: 1, initialRows: ['US'] });
    setupSignedIn('user_react', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_react' });
    await flushMicrotasks();

    let events = 0;
    const unsub = subscribe(() => events++);

    // Simulate another tab adding 'FR' — push a fresh snapshot.
    _pushSubscriptionSnapshotForTests('user_react', ['US', 'FR']);

    assert.ok(events >= 1, 'change event fires on snapshot update');
    assert.deepEqual(getFollowed().sort(), ['FR', 'US']);

    unsub();
  });
});

describe('U3 — concurrent two-tab sign-in merge dedupes via OCC', () => {
  it('two emitters with overlapping lists end with deduped union', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({ tier: 1 });
    setupSignedIn('user_2t', { tier: 1, fakeClient: fake });

    // Simulate two sign-ins back-to-back (the second auth-state emit is a
    // duplicate event for the same user — should NOT re-run the handoff,
    // since prevUserId === nextUserId).
    await _emitAuthStateForTests({ id: 'user_2t' });
    await _emitAuthStateForTests({ id: 'user_2t' });
    await flushMicrotasks();

    // One merge call for the device (the second emit is deduped).
    assert.equal(fake._calls.merge.length, 1);
    assert.deepEqual(fake._getRows(), ['US']);
  });
});

describe('U3 — followCountry post-handoff: wire-level Convex error mapping', () => {
  it("followCountry returns FREE_CAP with currentCount/limit when Convex throws ConvexError({kind:'FREE_CAP'})", async () => {
    setLocalStorageList([]);
    const fake = makeFakeConvex({ tier: 0, capLimit: 3, initialRows: ['JP', 'CN', 'DE'] });
    setupSignedIn('user_cap', { tier: 0, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_cap' });
    await flushMicrotasks();

    const res = await addCountry('FR');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'FREE_CAP');
    assert.equal(res.currentCount, 3);
    assert.equal(res.limit, 3);
  });

  it("followCountry returns INVALID_INPUT for ConvexError({kind:'INVALID_COUNTRY'})", async () => {
    // Build a fake that throws INVALID_COUNTRY for any add.
    const fake = {
      async mutation(ref) {
        if (ref === FAKE_API.followedCountries.followCountry) {
          const e = new Error('ConvexError: INVALID_COUNTRY');
          e.data = { kind: 'INVALID_COUNTRY', country: 'XX' };
          throw e;
        }
        throw new Error('unmocked');
      },
      onUpdate(ref, _a, cb) {
        if (ref === FAKE_API.followedCountries.listFollowed) {
          Promise.resolve().then(() => cb([]));
          return () => {};
        }
        throw new Error('unmocked');
      },
    };
    setupSignedIn('user_iv', { tier: 1, fakeClient: fake });
    await _emitAuthStateForTests({ id: 'user_iv' });
    await flushMicrotasks();

    const res = await addCountry('US');
    assert.deepEqual(res, { ok: false, reason: 'INVALID_INPUT' });
  });

  it("followCountry returns HANDOFF_PENDING for ConvexError({kind:'UNAUTHENTICATED'})", async () => {
    const fake = {
      async mutation(ref) {
        if (ref === FAKE_API.followedCountries.followCountry) {
          const e = new Error('ConvexError: UNAUTHENTICATED');
          e.data = { kind: 'UNAUTHENTICATED' };
          throw e;
        }
        throw new Error('unmocked');
      },
      onUpdate(ref, _a, cb) {
        if (ref === FAKE_API.followedCountries.listFollowed) {
          Promise.resolve().then(() => cb([]));
          return () => {};
        }
        throw new Error('unmocked');
      },
    };
    setupSignedIn('user_un', { tier: 1, fakeClient: fake });
    await _emitAuthStateForTests({ id: 'user_un' });
    await flushMicrotasks();

    const res = await addCountry('US');
    assert.deepEqual(res, { ok: false, reason: 'HANDOFF_PENDING' });
  });
});

describe('U3 — unfollowCountry post-handoff', () => {
  it('removes existing country via Convex', async () => {
    const fake = makeFakeConvex({ tier: 1, initialRows: ['US', 'FR'] });
    setupSignedIn('user_unf', { tier: 1, fakeClient: fake });
    await _emitAuthStateForTests({ id: 'user_unf' });
    await flushMicrotasks();

    const r = await removeCountry('US');
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(fake._getRows(), ['FR']);
  });

  it('removing a not-followed country is idempotent', async () => {
    const fake = makeFakeConvex({ tier: 1, initialRows: ['US'] });
    setupSignedIn('user_idem', { tier: 1, fakeClient: fake });
    await _emitAuthStateForTests({ id: 'user_idem' });
    await flushMicrotasks();

    const r = await removeCountry('FR');
    assert.deepEqual(r, { ok: true });
  });
});
