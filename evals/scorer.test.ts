// @vitest-environment node
import { describe, expect, it } from "vitest";
import { aggregate, isGrounded, normalize, scoreCase, scoreScalar, scoreSet } from "./scorer";
import { loadFixtures } from "./fixtures";
import type { Eligibility } from "../lib/eligibility-schema";

const base: Eligibility = {
  programName: null,
  rawEligibilityText: "x",
  population: [],
  genderRestriction: "any",
  requirements: [],
  locationConstraints: [],
  maxStayDays: null,
  ageRange: { min: null, max: null },
  notes: "",
};

describe("normalize", () => {
  it("collapses whitespace and case", () => {
    expect(normalize("  Collin   COUNTY \n")).toBe("collin county");
  });
});

describe("scoreSet", () => {
  it("scores a perfect match as 1", () => {
    expect(scoreSet(["a", "b"], ["b", "a"]).f1).toBe(1);
  });

  it("treats two empty sets as perfect — most documents state no requirements", () => {
    expect(scoreSet([], []).f1).toBe(1);
  });

  it("drives precision to 0 when the model invents entries", () => {
    const s = scoreSet([], ["sober", "id_required"]);
    expect(s.precision).toBe(0);
    expect(s.f1).toBe(0);
    expect(s.falsePositives).toBe(2);
  });

  it("drives recall to 0 when the model misses everything", () => {
    const s = scoreSet(["sober"], []);
    expect(s.recall).toBe(0);
    expect(s.falseNegatives).toBe(1);
  });

  it("scores partial overlap between 0 and 1", () => {
    const s = scoreSet(["a", "b"], ["a", "c"]);
    expect(s.precision).toBe(0.5);
    expect(s.recall).toBe(0.5);
    expect(s.f1).toBe(0.5);
  });

  it("is insensitive to case and spacing", () => {
    expect(scoreSet(["Collin County"], ["collin  county"]).f1).toBe(1);
  });
});

describe("scoreScalar", () => {
  it("matches null to null", () => {
    expect(scoreScalar(null, null)).toBe(1);
  });

  it("penalizes a value where null was expected", () => {
    expect(scoreScalar(null, 90)).toBe(0);
  });

  it("penalizes null where a value was expected", () => {
    expect(scoreScalar(90, null)).toBe(0);
  });

  it("compares numbers strictly", () => {
    expect(scoreScalar(90, 90)).toBe(1);
    expect(scoreScalar(90, 91)).toBe(0);
  });

  it("compares strings normalized", () => {
    expect(scoreScalar("Hope House", "  hope   house ")).toBe(1);
  });
});

describe("isGrounded", () => {
  const source = "Guests must present a valid photo ID at intake.\nStays are capped at 90 days.";

  it("accepts a verbatim span", () => {
    expect(isGrounded("Guests must present a valid photo ID at intake.", source)).toBe(true);
  });

  it("accepts a span whose line breaks were reflowed", () => {
    expect(isGrounded("at intake. Stays are capped at 90 days.", source)).toBe(true);
  });

  it("rejects a fabricated span", () => {
    expect(isGrounded("Applicants must be veterans.", source)).toBe(false);
  });

  it("rejects an empty span", () => {
    expect(isGrounded("", source)).toBe(false);
  });
});

describe("scoreCase", () => {
  const source = "Serves women only. Maximum stay 90 days.";

  it("gives a perfect extraction a score of 1", () => {
    const expected: Eligibility = { ...base, genderRestriction: "women_only", maxStayDays: 90 };
    const actual: Eligibility = { ...expected, rawEligibilityText: "Serves women only." };
    const result = scoreCase("t", "d", expected, actual, source);
    expect(result.score).toBe(1);
    expect(result.grounded).toBe(true);
  });

  it("flags an ungrounded quote even when every field is right", () => {
    const expected: Eligibility = { ...base, genderRestriction: "women_only", maxStayDays: 90 };
    const actual: Eligibility = { ...expected, rawEligibilityText: "Serves veterans only." };
    const result = scoreCase("t", "d", expected, actual, source);
    expect(result.grounded).toBe(false);
    expect(result.score).toBeLessThan(1);
  });
});

describe("aggregate", () => {
  it("reports 0 for an empty run rather than dividing by zero", () => {
    const report = aggregate([], "test", 0);
    expect(report.overall).toBe(0);
    expect(report.groundingRate).toBe(0);
  });
});

describe("fixtures", () => {
  const fixtures = loadFixtures();

  it("loads every labeled case", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  it("every label parses against the live eligibilitySchema", () => {
    for (const f of fixtures) expect(f.expected).toBeDefined();
  });

  it("every labeled quote actually appears in its source", () => {
    for (const f of fixtures) {
      if (!f.expected.rawEligibilityText) continue;
      expect(isGrounded(f.expected.rawEligibilityText, f.source), `${f.slug} label is ungrounded`).toBe(true);
    }
  });

  it("includes a control case with no eligibility rules", () => {
    const control = fixtures.find((f) => f.slug === "no-eligibility-stated");
    expect(control).toBeDefined();
    expect(control!.expected.requirements).toEqual([]);
    expect(control!.expected.population).toEqual([]);
  });
});
