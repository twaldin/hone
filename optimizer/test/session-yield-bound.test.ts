import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_NO_YIELD_MAX_TOKENS,
  SessionNoYieldCounter,
  parseSessionNoYieldMaxTokens,
} from "../src/session-yield-bound.js";

describe("SessionNoYieldCounter", () => {
  it("bounds the recorded successful-call/no-candidate shape before the run budget", () => {
    const counter = new SessionNoYieldCounter(DEFAULT_SESSION_NO_YIELD_MAX_TOKENS);
    let bounded = null;

    // The preserved incident made 488 successful calls while its prompt grew
    // from 6,080 to 30,098 tokens. A smooth interpolation preserves that
    // resend-heavy shape without depending on a provider or the archived log.
    for (let call = 0; call < 488 && bounded === null; call += 1) {
      const promptTokens = Math.round(6_080 + ((30_098 - 6_080) * call) / 487);
      bounded = counter.observe(
        { promptTokens, completionTokens: 30, totalTokens: promptTokens + 30 },
        false,
      );
    }

    expect(bounded).not.toBeNull();
    expect(bounded).toMatchObject({
      type: "hone.mutation.no-yield-bound.v1",
      limitTokens: DEFAULT_SESSION_NO_YIELD_MAX_TOKENS,
    });
    expect(bounded?.modelCalls).toBeLessThan(488);
    expect(bounded?.consumedTokens).toBeGreaterThanOrEqual(DEFAULT_SESSION_NO_YIELD_MAX_TOKENS);
    expect(bounded?.consumedTokens).toBeLessThan(12_000_000);
  });

  it("does not bound a healthy session whose yield arrives after many calls", () => {
    const counter = new SessionNoYieldCounter(DEFAULT_SESSION_NO_YIELD_MAX_TOKENS);
    const observations = [];

    // 1,000 legitimate calls reach 1.5M tokens only on the final, yielding
    // turn. The successful yield wins over the bound at that same boundary.
    for (let call = 1; call <= 1_000; call += 1) {
      observations.push(counter.observe(
        { promptTokens: 1_400, completionTokens: 100, totalTokens: 1_500 },
        call === 1_000,
      ));
    }

    expect(observations.every((observation) => observation === null)).toBe(true);
    expect(counter.snapshot()).toEqual({
      modelCalls: 1_000,
      promptTokens: 1_400_000,
      completionTokens: 100_000,
      consumedTokens: 1_500_000,
    });
  });

  it("normalizes invalid provider usage instead of failing open inside a swallowed listener", () => {
    const anomalies: string[] = [];
    const counter = new SessionNoYieldCounter(100, (kind) => anomalies.push(kind));

    expect(counter.observe(
      { promptTokens: -1, completionTokens: 60, totalTokens: 20 },
      false,
    )).toBeNull();
    expect(counter.observe(
      { promptTokens: Number.NaN, completionTokens: 60, totalTokens: Number.POSITIVE_INFINITY },
      false,
    )).toMatchObject({ consumedTokens: 120, completionTokens: 120, modelCalls: 2 });
    expect(counter.snapshot()).toEqual({
      modelCalls: 2,
      promptTokens: 0,
      completionTokens: 120,
      consumedTokens: 120,
    });
    expect(anomalies).toEqual(["normalized", "normalized"]);
  });

  it("surfaces zeroed SDK usage as indistinguishable zero-or-unreported telemetry", () => {
    const anomalies: string[] = [];
    const counter = new SessionNoYieldCounter(100, (kind) => anomalies.push(kind));

    expect(counter.observe(
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      false,
    )).toBeNull();
    expect(counter.snapshot()).toEqual({
      modelCalls: 1,
      promptTokens: 0,
      completionTokens: 0,
      consumedTokens: 0,
    });
    expect(anomalies).toEqual(["zero-usage"]);
  });
});

describe("parseSessionNoYieldMaxTokens", () => {
  it("uses a safe default and accepts a positive-integer override", () => {
    expect(parseSessionNoYieldMaxTokens(undefined)).toBe(DEFAULT_SESSION_NO_YIELD_MAX_TOKENS);
    expect(parseSessionNoYieldMaxTokens("2500000")).toBe(2_500_000);
  });

  it.each(["", "0", "-1", "1.5", "abc", "Infinity"])("rejects invalid override %j", (raw) => {
    expect(() => parseSessionNoYieldMaxTokens(raw)).toThrow(/HONE_SESSION_NO_YIELD_MAX_TOKENS/);
  });
});
