import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import {
  COUNTRY_COUNT_PRIVACY_FLOOR,
  FREE_TIER_FOLLOW_LIMIT,
  MAX_MERGE_INPUT,
} from "../constants";
import { _ISO2_REGISTRY_FOR_TESTS, isValidIso2 } from "../lib/iso2";
import { ISO2_TO_ISO3 } from "../../src/utils/country-codes";

const modules = import.meta.glob("../**/*.ts");

const USER_A = {
  subject: "user-tests-fc-A",
  tokenIdentifier: "clerk|user-tests-fc-A",
};
const USER_B = {
  subject: "user-tests-fc-B",
  tokenIdentifier: "clerk|user-tests-fc-B",
};

/**
 * Seed a PRO entitlement for the given test user. Without this, the user
 * is treated as free-tier (tier=0) by `readEntitlementTier` since the
 * `entitlements` table starts empty under convex-test.
 */
async function seedProEntitlement(
  t: ReturnType<typeof convexTest>,
  userId: string,
  validUntil = Date.now() + 30 * 24 * 60 * 60 * 1000,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId,
      planKey: "pro_monthly",
      features: {
        tier: 1,
        maxDashboards: 10,
        apiAccess: true,
        apiRateLimit: 1000,
        prioritySupport: true,
        exportFormats: ["json", "csv"],
      },
      validUntil,
      updatedAt: Date.now(),
    });
  });
}

/**
 * Read the aggregate counter row for a country. Returns 0 if no row.
 * Mirrors the read-shape of the future `countFollowers` query (U14)
 * so the counter-maintenance tests assert against the same row the
 * production read path will use.
 */
async function readCounter(
  t: ReturnType<typeof convexTest>,
  country: string,
): Promise<number> {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("followedCountriesCounts")
      .withIndex("by_country", (q) => q.eq("country", country))
      .first();
    return row?.count ?? 0;
  });
}

/**
 * Read a user's followed-country list as a sorted-by-addedAt array of
 * country codes. Used to assert post-mutation table state.
 */
async function readUserFollows(
  t: ReturnType<typeof convexTest>,
  userId: string,
): Promise<string[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("followedCountries")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((r) => r.country);
  });
}

// ---------------------------------------------------------------------------
// ISO-2 registry parity — the registry mirrored into convex/lib/iso2.ts
// MUST stay in lockstep with the keys of `ISO2_TO_ISO3` in
// `src/utils/country-codes.ts`. This test catches drift if either side is
// edited without the other.
// ---------------------------------------------------------------------------

describe("iso2 registry — sanity & boundary cases", () => {
  test("isValidIso2 accepts known ISO-2 codes", () => {
    for (const code of [
      "US",
      "GB",
      "FR",
      "DE",
      "JP",
      "CN",
      "BR",
      "AQ",
      "XK", // Kosovo (user-assigned but mirrored in client registry)
    ]) {
      expect(isValidIso2(code)).toBe(true);
    }
  });

  test("isValidIso2 rejects regex-passing-but-non-ISO-2 codes", () => {
    for (const code of ["XX", "ZZ", "EN", "UK"]) {
      expect(isValidIso2(code)).toBe(false);
    }
  });

  test("isValidIso2 rejects bad-shape input", () => {
    for (const code of [
      "us", // lowercase
      "USA", // alpha-3
      "U", // too short
      "USS", // too long
      "U1", // contains digit
      "", // empty
      " ", // whitespace
      " US",
      "US ",
    ]) {
      expect(isValidIso2(code)).toBe(false);
    }
  });

  test("registry has 239 canonical alpha-2 codes (matches client mirror)", () => {
    // If this number changes, update BOTH `convex/lib/iso2.ts` and
    // `src/utils/country-codes.ts::ISO2_TO_ISO3` together.
    expect(_ISO2_REGISTRY_FOR_TESTS.size).toBe(239);
  });

  test("registry === Object.keys(ISO2_TO_ISO3) (set equality, not size only)", () => {
    // P2 #13 — Catches drift where one registry has, e.g., 'XK' and the
    // other has 'EU' (same size, different content). Set-equality is the
    // only way to prove the two are in true lockstep.
    const serverSet = _ISO2_REGISTRY_FOR_TESTS;
    const clientSet = new Set(Object.keys(ISO2_TO_ISO3));
    const onlyInServer = [...serverSet].filter((c) => !clientSet.has(c));
    const onlyInClient = [...clientSet].filter((c) => !serverSet.has(c));
    expect(onlyInServer).toEqual([]);
    expect(onlyInClient).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// followCountry — happy path, idempotency, validation, free-tier cap
// ---------------------------------------------------------------------------

describe("followCountry — happy path & idempotency", () => {
  test("PRO user follows 'US' → row inserted, counter US=1, idempotent:false", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const result = await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(result).toEqual({ ok: true, idempotent: false });
    expect(await readUserFollows(t, USER_A.subject)).toEqual(["US"]);
    expect(await readCounter(t, "US")).toBe(1);
  });

  test("PRO user calls followCountry('US') twice → second is idempotent, one row, counter still 1", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    const second = await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(second).toEqual({ ok: true, idempotent: true });
    expect(await readUserFollows(t, USER_A.subject)).toEqual(["US"]);
    expect(await readCounter(t, "US")).toBe(1);
  });
});

describe("followCountry — free-tier cap", () => {
  test("free user with 2 rows → followCountry('US') succeeds; currentCount becomes 3", async () => {
    const t = convexTest(schema, modules);
    // No seedProEntitlement — user is free.
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "GB",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "JP",
    });
    const result = await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(result).toEqual({ ok: true, idempotent: false });
    expect(await readUserFollows(t, USER_A.subject)).toEqual(["GB", "JP", "US"]);
  });

  test("free user with 3 rows → followCountry('FR') throws FREE_CAP with currentCount=3, limit=3", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "GB",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "JP",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "DE",
    });

    await expect(
      asUser.mutation(api.followedCountries.followCountry, {
        country: "FR",
      }),
    ).rejects.toThrow(/FREE_CAP/);
    // Counter for FR must NOT have been incremented (atomicity).
    expect(await readCounter(t, "FR")).toBe(0);
    expect(await readUserFollows(t, USER_A.subject)).toEqual([
      "GB",
      "JP",
      "DE",
    ]);
  });

  test("expired entitlement is treated as free-tier", async () => {
    const t = convexTest(schema, modules);
    // Expired entitlement = free.
    await seedProEntitlement(t, USER_A.subject, Date.now() - 1000);
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "GB",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "JP",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "DE",
    });
    await expect(
      asUser.mutation(api.followedCountries.followCountry, {
        country: "FR",
      }),
    ).rejects.toThrow(/FREE_CAP/);
  });
});

describe("followCountry — tier-first skip-collect optimization (P3 #21)", () => {
  test("PRO user with many existing rows is never blocked by FREE_CAP — collect() not called for cap check", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    // Hand-seed 10 rows (> FREE_TIER_FOLLOW_LIMIT) to prove the PRO path
    // doesn't inspect the existing row count for cap enforcement.
    const seedCodes = ["GB", "JP", "DE", "FR", "IT", "ES", "PT", "NL", "BE", "CH"];
    await t.run(async (ctx) => {
      for (const country of seedCodes) {
        await ctx.db.insert("followedCountries", {
          userId: USER_A.subject,
          country,
          addedAt: Date.now(),
        });
      }
    });
    // 11th follow should still succeed: PRO has no cap.
    const result = await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(result).toEqual({ ok: true, idempotent: false });
  });
});

describe("followCountry — auth & input validation", () => {
  test("unauthenticated → UNAUTHENTICATED", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.followedCountries.followCountry, { country: "US" }),
    ).rejects.toThrow(/UNAUTHENTICATED/);
  });

  test("invalid ISO-2 inputs all throw INVALID_COUNTRY", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    for (const bad of ["us", "USA", "XX", "EN", "UK", "", " "]) {
      await expect(
        asUser.mutation(api.followedCountries.followCountry, {
          country: bad,
        }),
      ).rejects.toThrow(/INVALID_COUNTRY/);
    }
  });
});

// ---------------------------------------------------------------------------
// unfollowCountry — happy path, idempotency, counter decrement
// ---------------------------------------------------------------------------

describe("unfollowCountry — happy path & idempotency", () => {
  test("existing row → deleted, counter -1, idempotent:false", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(1);

    const result = await asUser.mutation(
      api.followedCountries.unfollowCountry,
      { country: "US" },
    );
    expect(result).toEqual({ ok: true, idempotent: false });
    expect(await readUserFollows(t, USER_A.subject)).toEqual([]);
    expect(await readCounter(t, "US")).toBe(0);
  });

  test("absent row → idempotent:true, counter NOT touched", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const result = await asUser.mutation(
      api.followedCountries.unfollowCountry,
      { country: "US" },
    );
    expect(result).toEqual({ ok: true, idempotent: true });
    // Counter row should not exist (read returns 0 because row absent).
    expect(await readCounter(t, "US")).toBe(0);
  });

  test("second unfollow on already-deleted row → idempotent:true", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    await asUser.mutation(api.followedCountries.unfollowCountry, {
      country: "US",
    });
    const second = await asUser.mutation(
      api.followedCountries.unfollowCountry,
      { country: "US" },
    );
    expect(second).toEqual({ ok: true, idempotent: true });
    expect(await readCounter(t, "US")).toBe(0);
  });

  test("unauthenticated → UNAUTHENTICATED", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.followedCountries.unfollowCountry, { country: "US" }),
    ).rejects.toThrow(/UNAUTHENTICATED/);
  });

  test("invalid ISO-2 → INVALID_COUNTRY", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    await expect(
      asUser.mutation(api.followedCountries.unfollowCountry, {
        country: "XX",
      }),
    ).rejects.toThrow(/INVALID_COUNTRY/);
  });
});

// ---------------------------------------------------------------------------
// Counter scenarios — multi-user / never-negative
// ---------------------------------------------------------------------------

describe("counter maintenance — multi-user", () => {
  test("two different users following 'US' → counter 0→1→2; unfollows → 2→1→0", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    await seedProEntitlement(t, USER_B.subject);
    const asA = t.withIdentity(USER_A);
    const asB = t.withIdentity(USER_B);

    expect(await readCounter(t, "US")).toBe(0);
    await asA.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(1);
    await asB.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(2);

    await asA.mutation(api.followedCountries.unfollowCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(1);
    await asB.mutation(api.followedCountries.unfollowCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(0);
  });

  test("counter never goes below 0 (defensive max-with-zero)", async () => {
    const t = convexTest(schema, modules);
    // Hand-seed a 0-count counter row to simulate drift.
    await t.run(async (ctx) => {
      await ctx.db.insert("followedCountriesCounts", {
        country: "US",
        count: 0,
        updatedAt: Date.now(),
      });
    });
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    // Hand-insert a row WITHOUT touching the counter, to simulate drift.
    await t.run(async (ctx) => {
      await ctx.db.insert("followedCountries", {
        userId: USER_A.subject,
        country: "US",
        addedAt: Date.now(),
      });
    });
    // Counter row exists at 0; unfollow decrements via Math.max(0, count-1).
    await asUser.mutation(api.followedCountries.unfollowCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(0);
  });
});

describe("counter maintenance — idempotency does NOT double-count", () => {
  test("follow same country twice → counter +1, not +2", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(1);
  });

  test("unfollow absent row → counter NOT decremented", async () => {
    const t = convexTest(schema, modules);
    // User-A follows US; user-B then unfollows US (which they never followed).
    // User-B's unfollow should be idempotent and NOT touch the counter.
    await seedProEntitlement(t, USER_A.subject);
    await seedProEntitlement(t, USER_B.subject);
    const asA = t.withIdentity(USER_A);
    const asB = t.withIdentity(USER_B);

    await asA.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(1);
    await asB.mutation(api.followedCountries.unfollowCountry, {
      country: "US",
    });
    expect(await readCounter(t, "US")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// mergeAnonymousLocal — happy paths, cap, validation, dedup
// ---------------------------------------------------------------------------

describe("mergeAnonymousLocal — PRO happy path", () => {
  test("PRO user has ['US'], input ['GB','JP'] → final ['US','GB','JP']", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["GB", "JP"] },
    );
    expect(result).toEqual({
      totalCount: 3,
      accepted: ["GB", "JP"],
      droppedInvalid: [],
      droppedDueToCap: [],
    });
    expect(await readUserFollows(t, USER_A.subject)).toEqual([
      "US",
      "GB",
      "JP",
    ]);
    expect(await readCounter(t, "GB")).toBe(1);
    expect(await readCounter(t, "JP")).toBe(1);
  });

  test("PRO user with no rows, input ['US','US','US'] → canonicalize to ['US']; one row; counter +1", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["US", "US", "US"] },
    );
    expect(result).toEqual({
      totalCount: 1,
      accepted: ["US"],
      droppedInvalid: [],
      droppedDueToCap: [],
    });
    expect(await readUserFollows(t, USER_A.subject)).toEqual(["US"]);
    expect(await readCounter(t, "US")).toBe(1);
  });
});

describe("mergeAnonymousLocal — free-tier cap", () => {
  test("free user with ['US'] (1), input ['GB','JP','CN'] → accept first 2; CN to droppedDueToCap", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["GB", "JP", "CN"] },
    );
    expect(result).toEqual({
      totalCount: 3,
      accepted: ["GB", "JP"],
      droppedInvalid: [],
      droppedDueToCap: ["CN"],
    });
    expect(await readUserFollows(t, USER_A.subject)).toEqual([
      "US",
      "GB",
      "JP",
    ]);
    // Counter for CN must NOT have been incremented.
    expect(await readCounter(t, "CN")).toBe(0);
  });

  test("free user already at cap → accepted=[], all to droppedDueToCap", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER_A);
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "US",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "GB",
    });
    await asUser.mutation(api.followedCountries.followCountry, {
      country: "JP",
    });

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["CN", "FR"] },
    );
    expect(result).toEqual({
      totalCount: 3,
      accepted: [],
      droppedInvalid: [],
      droppedDueToCap: ["CN", "FR"],
    });
    expect(await readUserFollows(t, USER_A.subject)).toEqual([
      "US",
      "GB",
      "JP",
    ]);
    expect(await readCounter(t, "CN")).toBe(0);
    expect(await readCounter(t, "FR")).toBe(0);
  });

  test("abuse — free user posts 50-element array → cap fits only (3 - existing); final NEVER exceeds 3", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER_A);
    // Existing = 0; cap = 3 should fit.
    const big = Array.from({ length: 50 }, (_, i) => {
      // generate 50 distinct valid ISO-2 codes from the registry
      const codes = [
        "US",
        "GB",
        "JP",
        "FR",
        "DE",
        "IT",
        "ES",
        "PT",
        "NL",
        "BE",
        "CH",
        "AT",
        "SE",
        "NO",
        "DK",
        "FI",
        "PL",
        "CZ",
        "HU",
        "GR",
        "RO",
        "BG",
        "IE",
        "LU",
        "MT",
        "CY",
        "SI",
        "SK",
        "EE",
        "LV",
        "LT",
        "HR",
        "BR",
        "AR",
        "MX",
        "CL",
        "PE",
        "CO",
        "VE",
        "UY",
        "PY",
        "BO",
        "EC",
        "ZA",
        "EG",
        "MA",
        "DZ",
        "TN",
        "KE",
        "NG",
      ];
      return codes[i];
    }) as string[];
    expect(big).toHaveLength(50);

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: big },
    );
    expect(result.accepted).toHaveLength(FREE_TIER_FOLLOW_LIMIT);
    expect(result.totalCount).toBe(FREE_TIER_FOLLOW_LIMIT);
    // 47 of the remaining 50 codes should have ended up in droppedDueToCap.
    expect(result.droppedDueToCap).toHaveLength(50 - FREE_TIER_FOLLOW_LIMIT);
    expect(result.droppedInvalid).toEqual([]);
    expect(await readUserFollows(t, USER_A.subject)).toHaveLength(
      FREE_TIER_FOLLOW_LIMIT,
    );
  });
});

describe("mergeAnonymousLocal — input validation", () => {
  test("oversized input (200 elements) → INPUT_TOO_LARGE", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const big = Array.from({ length: 200 }, () => "US");
    expect(big.length).toBeGreaterThan(MAX_MERGE_INPUT);
    await expect(
      asUser.mutation(api.followedCountries.mergeAnonymousLocal, {
        countries: big,
      }),
    ).rejects.toThrow(/INPUT_TOO_LARGE/);
    // No rows inserted.
    expect(await readUserFollows(t, USER_A.subject)).toEqual([]);
  });

  test("empty input → EMPTY_INPUT", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);
    await expect(
      asUser.mutation(api.followedCountries.mergeAnonymousLocal, {
        countries: [],
      }),
    ).rejects.toThrow(/EMPTY_INPUT/);
  });

  test("unauthenticated → UNAUTHENTICATED", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.followedCountries.mergeAnonymousLocal, {
        countries: ["US"],
      }),
    ).rejects.toThrow(/UNAUTHENTICATED/);
  });

  test("input ['US','xx','United States'] → accepted=['US'], droppedInvalid=['xx','United States']", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["US", "xx", "United States"] },
    );
    expect(result).toEqual({
      totalCount: 1,
      accepted: ["US"],
      droppedInvalid: ["xx", "United States"],
      droppedDueToCap: [],
    });
  });

  test("mixed valid/invalid + duplicates: ['US','us','US','XX','GB'] → drops 'us'+'XX'; canonicalizes valid to ['US','GB']", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t, USER_A.subject);
    const asUser = t.withIdentity(USER_A);

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["US", "us", "US", "XX", "GB"] },
    );
    expect(result.accepted).toEqual(["US", "GB"]);
    expect(result.droppedInvalid).toEqual(["us", "XX"]);
    expect(result.droppedDueToCap).toEqual([]);
    expect(result.totalCount).toBe(2);
  });
});

describe("mergeAnonymousLocal — duplicate inputs free-tier near-cap", () => {
  test("free user with no rows, input ['US','US','GB','GB','JP','CN'] → cap accepts first 3 unique; CN to droppedDueToCap", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER_A);

    const result = await asUser.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: ["US", "US", "GB", "GB", "JP", "CN"] },
    );
    expect(result).toEqual({
      totalCount: 3,
      accepted: ["US", "GB", "JP"],
      droppedInvalid: [],
      droppedDueToCap: ["CN"],
    });
    expect(await readUserFollows(t, USER_A.subject)).toEqual([
      "US",
      "GB",
      "JP",
    ]);
    expect(await readCounter(t, "US")).toBe(1);
    expect(await readCounter(t, "GB")).toBe(1);
    expect(await readCounter(t, "JP")).toBe(1);
    expect(await readCounter(t, "CN")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sanity: COUNTRY_COUNT_PRIVACY_FLOOR is imported from convex/constants
// (queries land in U14 — this constant is used there, not here, but the
// import path must be live so U14 doesn't break).
// ---------------------------------------------------------------------------
describe("constants — sanity", () => {
  test("COUNTRY_COUNT_PRIVACY_FLOOR is a positive integer", () => {
    expect(Number.isInteger(COUNTRY_COUNT_PRIVACY_FLOOR)).toBe(true);
    expect(COUNTRY_COUNT_PRIVACY_FLOOR).toBeGreaterThan(0);
  });
});
