import { describe, it, expect } from "vitest";
import { describePolicy, parseDisplay, renderAmount, type Display } from "../src/display.js";
import { evaluate } from "../src/policy/engine.js";
import { A, key, NOW, policy, caps, freshState, ev } from "./helpers.js";
import type { AssetKey } from "../src/types.js";

describe("policy echo — the fat-finger control (ONBOARD-03)", () => {
  // The whole point: render a base-unit cap back in human units so an off-by-a-zero is VISIBLE.
  it("echo-renders-caps-in-human-units", () => {
    const display: Display = { [key]: { decimals: 6, symbol: "USDC" } };

    // Intended $50 cap.
    const intended = describePolicy(policy({ caps: caps({ perRequest: A(50_000_000n) }) }), display);
    expect(intended.denominations[0].perRequest.human).toBe("50.000000 USDC");

    // The fat-finger: one extra zero. It renders VISIBLY different — the human catches it.
    const typo = describePolicy(policy({ caps: caps({ perRequest: A(500_000_000n) }) }), display);
    expect(typo.denominations[0].perRequest.human).toBe("500.000000 USDC");
    expect(typo.denominations[0].perRequest.human).not.toBe(intended.denominations[0].perRequest.human);

    // Exactness (integer-string math, no float): sub-unit and zero render precisely.
    expect(renderAmount(1_234n, 6)).toBe("0.001234");
    expect(renderAmount(0n, 6)).toBe("0.000000");
    expect(renderAmount(50_000_000n, 0)).toBe("50000000"); // decimals 0 ⇒ base units as-is
  });

  // DEGRADE TO TRUTH, NEVER A LIE: no declared decimals ⇒ withhold the rendering, show grouped base
  // units and say so (human === null). Never guess a decimal placement.
  it("echo-without-decimals-shows-base-units-not-a-guess", () => {
    const d = describePolicy(policy({ caps: caps({ perRequest: A(50_000_000n) }) })); // no display
    const pr = d.denominations[0].perRequest;
    expect(pr.human).toBeNull();
    expect(pr.base).toBe("50000000");
    expect(pr.baseGrouped).toBe("50,000,000");
    expect(d.denominations[0].decimals).toBeNull();
  });

  // DISP-01: display is display-only, structurally non-enforcing. `evaluate` never takes display, and
  // the symbol only ever changes a LABEL — never the money, never a decision.
  it("display-never-affects-a-decision", () => {
    const p = policy({ caps: caps({ perRequest: A(50_000_000n) }) });
    const honest: Display = { [key]: { decimals: 6, symbol: "USDC" } };
    const lying: Display = { [key]: { decimals: 6, symbol: "TOTALLY-DIFFERENT" } };

    // A misleading symbol changes the label but not the exact base amount (the money is untouched).
    const a = describePolicy(p, honest).denominations[0].perRequest;
    const b = describePolicy(p, lying).denominations[0].perRequest;
    expect(a.base).toBe(b.base);
    expect(a.human).not.toBe(b.human); // only the label differs

    // The decision is a pure function of (ev, policy, state, now) — display is not even an input.
    const d1 = evaluate(ev(), p, freshState(), NOW);
    const d2 = evaluate(ev(), p, freshState(), NOW);
    expect(d1).toEqual(d2);
  });
});

describe("parseDisplay — optional, fail-closed, never touches the policy parse", () => {
  it("absent display yields an empty map; valid display parses", () => {
    const none = parseDisplay({ halt: false });
    expect(none.ok && Object.keys(none.value).length).toBe(0);

    const good = parseDisplay({ display: { [key]: { decimals: 6, symbol: "USDC" } } });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value[key as AssetKey]).toEqual({ decimals: 6, symbol: "USDC" });
  });

  it("malformed display fields fail closed with a specific reason", () => {
    const badDecimals = parseDisplay({ display: { [key]: { decimals: 6.5 } } });
    expect(badDecimals.ok === false && badDecimals.reason).toBe("config.decimals_invalid");

    const negDecimals = parseDisplay({ display: { [key]: { decimals: -1 } } });
    expect(negDecimals.ok === false && negDecimals.reason).toBe("config.decimals_invalid");

    const badSymbol = parseDisplay({ display: { [key]: { decimals: 6, symbol: 42 } } });
    expect(badSymbol.ok === false && badSymbol.reason).toBe("config.symbol_invalid");

    const badKey = parseDisplay({ display: { "not-a-coordinate": { decimals: 6 } } });
    expect(badKey.ok === false && badKey.reason).toBe("config.display_invalid");

    const badSection = parseDisplay({ display: [] });
    expect(badSection.ok === false && badSection.reason).toBe("config.display_invalid");
  });
});
