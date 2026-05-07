import { ConvexError, v } from "convex/values";
import {
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import {
  COUNTRY_COUNT_PRIVACY_FLOOR,
  FREE_TIER_FOLLOW_LIMIT,
  MAX_MERGE_INPUT,
} from "./constants";
import { isValidIso2 } from "./lib/iso2";

/**
 * Layer-2 entitlement gate for the followed-countries watchlist primitive
 * (plan U13). Returns the user's effective tier (0 = free, ≥1 = PRO).
 *
 * Mirrors `convex/alertRules.ts::assertProEntitlement` — kept inline (not
 * imported from a shared helper) for security-review readability.
 *
 *   - no entitlement row → tier 0 (free)
 *   - validUntil < Date.now() → expired, treat as tier 0
 *   - tier ≥ 1 → PRO
 *
 * Unlike alertRules (which throws PRO_REQUIRED), the watchlist gate is
 * NOT all-or-nothing: free users may follow up to FREE_TIER_FOLLOW_LIMIT
 * countries; only over-cap inserts throw FREE_CAP. So we return the tier
 * for the caller to decide.
 */
async function readEntitlementTier(
  ctx: MutationCtx,
  userId: string,
): Promise<number> {
  const entitlement = await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  if (!entitlement) return 0;
  if (entitlement.validUntil < Date.now()) return 0;
  return entitlement.features.tier ?? 0;
}

/**
 * Atomic +1 on the `followedCountriesCounts` aggregate row for `country`.
 * Patch if the row exists, insert otherwise. Runs inside the parent
 * mutation transaction so the counter never drifts from the row table
 * (memory: `convex-mutation-from-mutation-not-one-transaction` —
 * intentionally a helper, NOT a child mutation).
 */
async function incrementCountryCounter(
  ctx: MutationCtx,
  country: string,
): Promise<void> {
  const existing = await ctx.db
    .query("followedCountriesCounts")
    .withIndex("by_country", (q) => q.eq("country", country))
    .first();
  const now = Date.now();
  if (existing) {
    await ctx.db.patch(existing._id, {
      count: existing.count + 1,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("followedCountriesCounts", {
      country,
      count: 1,
      updatedAt: now,
    });
  }
}

/**
 * Atomic -1 on the `followedCountriesCounts` aggregate row for `country`,
 * defensively clamped at zero. No-op if the counter row doesn't exist
 * (the row delete that triggered this decrement was somehow ahead of an
 * insert — should never happen, but max-with-zero ensures we never write
 * a negative count).
 */
async function decrementCountryCounter(
  ctx: MutationCtx,
  country: string,
): Promise<void> {
  const existing = await ctx.db
    .query("followedCountriesCounts")
    .withIndex("by_country", (q) => q.eq("country", country))
    .first();
  if (!existing) return;
  await ctx.db.patch(existing._id, {
    count: Math.max(0, existing.count - 1),
    updatedAt: Date.now(),
  });
}

/**
 * Discriminated return shape for `followCountry` and `unfollowCountry`.
 * `idempotent: true` means the mutation observed the desired end state
 * already and made no changes (counter NOT touched).
 */
export type FollowMutationResult =
  | { ok: true; idempotent: false }
  | { ok: true; idempotent: true };

/**
 * Return shape for `mergeAnonymousLocal`. `accepted` is the list of
 * NEWLY-inserted countries (in canonicalized first-seen order); existing
 * rows are silently deduped against table state. `droppedInvalid` is
 * inputs that failed `isValidIso2`; `droppedDueToCap` is valid-but-
 * over-cap inputs for free users that the client should surface in an
 * upgrade modal. PRO users receive `droppedDueToCap: []`.
 */
export type MergeAnonymousLocalResult = {
  totalCount: number;
  accepted: string[];
  droppedInvalid: string[];
  droppedDueToCap: string[];
};

/**
 * `followCountry({ country })` — authoritative single-country follow.
 *
 * 1. Auth gate: throws ConvexError({kind:'UNAUTHENTICATED'}) if absent.
 * 2. Validates `country` against the canonical ISO-2 registry; throws
 *    ConvexError({kind:'INVALID_COUNTRY', country}) on miss.
 * 3. Idempotent on (userId, country) — second call returns
 *    {idempotent:true} and does NOT touch the counter.
 * 4. Free-tier cap: tier=0 callers with currentCount >= FREE_TIER_FOLLOW_LIMIT
 *    throw ConvexError({kind:'FREE_CAP', currentCount, limit}). PRO callers
 *    are unlimited.
 * 5. Atomic counter +1 in the same transaction as the row insert.
 *
 * Errors are typed `ConvexError({kind, ...})` with object data so callers
 * can branch on `err.data.kind` (memory:
 * `convex-error-string-data-strips-errordata-on-wire`).
 */
export const followCountry = mutation({
  args: { country: v.string() },
  handler: async (ctx, args): Promise<FollowMutationResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ kind: "UNAUTHENTICATED" });
    const userId = identity.subject;

    if (!isValidIso2(args.country)) {
      throw new ConvexError({
        kind: "INVALID_COUNTRY",
        country: args.country,
      });
    }

    const existingRow = await ctx.db
      .query("followedCountries")
      .withIndex("by_user_country", (q) =>
        q.eq("userId", userId).eq("country", args.country),
      )
      .first();
    if (existingRow) {
      return { ok: true, idempotent: true };
    }

    // P3 #21 — Tier-first skip-collect optimization.
    // PRO users have no cap, so we can skip the O(N) `.collect()` of all
    // user rows entirely (the count is only used for the FREE_CAP check).
    // For free users the count is required to enforce the cap.
    const tier = await readEntitlementTier(ctx, userId);
    if (tier < 1) {
      const userRows = await ctx.db
        .query("followedCountries")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      const currentCount = userRows.length;
      if (currentCount >= FREE_TIER_FOLLOW_LIMIT) {
        throw new ConvexError({
          kind: "FREE_CAP",
          currentCount,
          limit: FREE_TIER_FOLLOW_LIMIT,
        });
      }
    }

    await ctx.db.insert("followedCountries", {
      userId,
      country: args.country,
      addedAt: Date.now(),
    });
    await incrementCountryCounter(ctx, args.country);

    return { ok: true, idempotent: false };
  },
});

/**
 * `unfollowCountry({ country })` — authoritative single-country unfollow.
 *
 * 1. Auth gate.
 * 2. Validates ISO-2.
 * 3. Idempotent on absent: missing row returns {idempotent:true} and does
 *    NOT decrement the counter.
 * 4. Atomic counter -1 (clamped at 0) in the same transaction as the row
 *    delete.
 */
export const unfollowCountry = mutation({
  args: { country: v.string() },
  handler: async (ctx, args): Promise<FollowMutationResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ kind: "UNAUTHENTICATED" });
    const userId = identity.subject;

    if (!isValidIso2(args.country)) {
      throw new ConvexError({
        kind: "INVALID_COUNTRY",
        country: args.country,
      });
    }

    const existingRow = await ctx.db
      .query("followedCountries")
      .withIndex("by_user_country", (q) =>
        q.eq("userId", userId).eq("country", args.country),
      )
      .first();
    if (!existingRow) {
      return { ok: true, idempotent: true };
    }

    await ctx.db.delete(existingRow._id);
    await decrementCountryCounter(ctx, args.country);

    return { ok: true, idempotent: false };
  },
});

/**
 * `mergeAnonymousLocal({ countries })` — sign-in merge of an anonymous
 * localStorage list into the authoritative table.
 *
 * Algorithm (verbatim, plan U13 step list):
 *   1. Auth gate.
 *   2. Reject empty input with ConvexError({kind:'EMPTY_INPUT'}).
 *   3. Reject inputs > MAX_MERGE_INPUT with INPUT_TOO_LARGE.
 *   4. Filter through isValidIso2; collect droppedInvalid.
 *   5. Canonicalize: dedupe in first-seen order.
 *   6. Read existing rows; build existingSet.
 *   7. newCandidates = canonicalized.filter(c => !existingSet.has(c)).
 *   8. tier=0 free user: accept up to (LIMIT - existingCount); rest →
 *      droppedDueToCap.
 *   9. tier>=1 PRO: accept all newCandidates.
 *  10. Insert accepted rows; +1 counter for each (atomic).
 *  11. Return {totalCount, accepted, droppedInvalid, droppedDueToCap}.
 *  12. If droppedDueToCap.length > 0, log structured warning.
 *
 * Resolves Codex-deepening round-1 P0 (server-side cap on merge) and
 * round-2 P1 (canonicalize duplicates before counting). Free users with
 * existingCount >= LIMIT accept zero new rows — never silently grow above
 * the cap during merge. (Grandfathering above-cap rows on PRO→free
 * downgrade is a separate concern handled by NOT auto-deleting on
 * downgrade; merge is the FIRST sign-in and has no PRO history to
 * grandfather.)
 */
export const mergeAnonymousLocal = mutation({
  args: { countries: v.array(v.string()) },
  handler: async (ctx, args): Promise<MergeAnonymousLocalResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ kind: "UNAUTHENTICATED" });
    const userId = identity.subject;

    // Step 2: empty-input guard.
    if (args.countries.length === 0) {
      throw new ConvexError({ kind: "EMPTY_INPUT" });
    }

    // Step 3: defensive upper-bound on input length.
    if (args.countries.length > MAX_MERGE_INPUT) {
      throw new ConvexError({
        kind: "INPUT_TOO_LARGE",
        max: MAX_MERGE_INPUT,
        received: args.countries.length,
      });
    }

    // Step 4: ISO-2 registry filter; collect droppedInvalid in input order.
    const droppedInvalid: string[] = [];
    const validInputs: string[] = [];
    for (const code of args.countries) {
      if (isValidIso2(code)) {
        validInputs.push(code);
      } else {
        droppedInvalid.push(code);
      }
    }

    // Step 5: canonicalize — dedupe in first-seen order. Without this, a
    // PRO merge of ['US','US','US'] would attempt 3 inserts and 3 counter
    // increments for one logical follow.
    const seen = new Set<string>();
    const canonicalized: string[] = [];
    for (const code of validInputs) {
      if (!seen.has(code)) {
        seen.add(code);
        canonicalized.push(code);
      }
    }

    // Step 6: read existing rows; build existingSet.
    const existingRows = await ctx.db
      .query("followedCountries")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const existingSet = new Set<string>(existingRows.map((r) => r.country));
    const existingCount = existingRows.length;

    // Step 7: filter against existing.
    const newCandidates = canonicalized.filter((c) => !existingSet.has(c));

    // Step 8/9: cap-bounded accept based on entitlement tier.
    const tier = await readEntitlementTier(ctx, userId);
    let accepted: string[];
    let droppedDueToCap: string[];
    if (tier < 1) {
      const remaining = Math.max(0, FREE_TIER_FOLLOW_LIMIT - existingCount);
      accepted = newCandidates.slice(0, remaining);
      droppedDueToCap = newCandidates.slice(remaining);
    } else {
      accepted = newCandidates;
      droppedDueToCap = [];
    }

    // Step 10: insert accepted rows + atomic counter +1 each.
    const now = Date.now();
    for (const country of accepted) {
      await ctx.db.insert("followedCountries", {
        userId,
        country,
        addedAt: now,
      });
      await incrementCountryCounter(ctx, country);
    }

    // Step 12: structured warning when free users overflow cap. No
    // server-side Sentry SDK in convex/ today; emit a structured
    // console.warn that the platform log aggregator can pick up.
    if (droppedDueToCap.length > 0) {
      const userIdHashed = hashUserIdForLog(userId);
      console.warn(
        JSON.stringify({
          breadcrumb: "followed_countries_merge_cap_drop",
          userIdHashed,
          existingCount,
          droppedCount: droppedDueToCap.length,
        }),
      );
    }

    // Step 11: return shape.
    return {
      totalCount: existingCount + accepted.length,
      accepted,
      droppedInvalid,
      droppedDueToCap,
    };
  },
});

/**
 * Stable, non-cryptographic hash of a userId for log breadcrumbs. We do
 * NOT want raw Clerk subjects in our log aggregator. djb2 is fine — this
 * is for grouping/correlation, not security.
 */
function hashUserIdForLog(userId: string): string {
  let h = 5381;
  for (let i = 0; i < userId.length; i++) {
    h = ((h << 5) + h + userId.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit hex for compact log readability.
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Queries (plan U14)
// ---------------------------------------------------------------------------

/**
 * `listFollowed()` — auth'd reactive read of the current user's watchlist.
 *
 * Returns ONLY the country codes (string[]); `addedAt` and `userId` are
 * not exposed to clients. Sorted by `addedAt` ascending (earliest-added
 * first) so the client gets a stable, intuitive order — the country a
 * user followed first appears first.
 *
 * If no auth identity is present, returns `[]` (consistent with
 * `convex/alertRules.ts::getAlertRules`). Reactive: Convex will
 * auto-resubscribe whenever the underlying `followedCountries` rows for
 * this user change.
 */
export const listFollowed = query({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows = await ctx.db
      .query("followedCountries")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
    // Sort by addedAt ascending — earliest-added first. Documented choice
    // (plan U14 test scenario: PRO user with `['US','GB']` added in that
    // order returns `['US','GB']`).
    return rows
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((r) => r.country);
  },
});

/**
 * `countFollowers({ country })` — public, no auth.
 *
 * O(1) read of the aggregate `followedCountriesCounts` row. Validates
 * the input as canonical ISO-2 (rejects `INVALID`, `us`, `XX`, etc.)
 * and returns the count.
 *
 * Privacy floor (P2 #12 — doc/code alignment):
 *   `raw < COUNTRY_COUNT_PRIVACY_FLOOR` returns 0. With
 *   COUNTRY_COUNT_PRIVACY_FLOOR=5, counts of 1-4 followers return 0; a
 *   count of 5 or more is returned exactly. The unbucketed count is
 *   internally accessible to ops via direct DB reads on the
 *   `followedCountriesCounts` table — this floor only applies at the
 *   public-query layer.
 */
export const countFollowers = query({
  args: { country: v.string() },
  handler: async (ctx, args): Promise<number> => {
    if (!isValidIso2(args.country)) {
      throw new ConvexError({
        kind: "INVALID_COUNTRY",
        country: args.country,
      });
    }
    const row = await ctx.db
      .query("followedCountriesCounts")
      .withIndex("by_country", (q) => q.eq("country", args.country))
      .first();
    const raw = row?.count ?? 0;
    // `<` is the canonical comparator: returns 0 when count is below
    // COUNTRY_COUNT_PRIVACY_FLOOR (1-4 followers); count of 5 or more
    // is returned exactly.
    if (raw < COUNTRY_COUNT_PRIVACY_FLOOR) return 0;
    return raw;
  },
});

/**
 * `listFollowersPage({ country, cursor, limit })` — INTERNAL-ONLY
 * paginated cursor over the followers of a country.
 *
 * Declared via `internalQuery` (NOT `query`) so it never appears in
 * `api.followedCountries` — only in `internal.followedCountries`. This
 * is the privacy boundary: follower lists are never publicly readable.
 *
 * `limit` is clamped to `[1, 500]` defensively so a buggy/abusive
 * caller can't request a 10k-element response.
 *
 * Returns `{ userIds, nextCursor }` where `nextCursor` is `null` when
 * Convex's paginator reports `isDone`.
 */
export const listFollowersPage = internalQuery({
  args: {
    country: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ userIds: string[]; nextCursor: string | null }> => {
    if (!isValidIso2(args.country)) {
      throw new ConvexError({
        kind: "INVALID_COUNTRY",
        country: args.country,
      });
    }
    const clampedLimit = Math.max(1, Math.min(500, args.limit));
    const result = await ctx.db
      .query("followedCountries")
      .withIndex("by_country", (q) => q.eq("country", args.country))
      .paginate({ cursor: args.cursor ?? null, numItems: clampedLimit });
    return {
      userIds: result.page.map((r) => r.userId),
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

/**
 * `internalListFollowedForUser({ userId })` — INTERNAL-ONLY helper
 * used by the `/relay/followed-countries` HTTP action.
 *
 * The relay has no Clerk identity (it authenticates via the shared
 * secret in the Authorization header), so it can't call the public
 * `listFollowed`. This helper takes an explicit `userId` and returns
 * the same `string[]` shape. Sorting matches `listFollowed`: by
 * `addedAt` ascending.
 */
export const internalListFollowedForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const rows = await ctx.db
      .query("followedCountries")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    return rows
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((r) => r.country);
  },
});
