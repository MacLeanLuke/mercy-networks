import type { Eligibility } from "@/lib/eligibility-schema";

const STATE_NAMES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

const KNOWN_CITIES = [
  "atlanta",
  "austin",
  "baltimore",
  "boston",
  "charlotte",
  "chicago",
  "cleveland",
  "columbus",
  "dallas",
  "denver",
  "detroit",
  "fort worth",
  "houston",
  "indianapolis",
  "jacksonville",
  "kansas city",
  "las vegas",
  "los angeles",
  "miami",
  "milwaukee",
  "minneapolis",
  "nashville",
  "new orleans",
  "new york",
  "oakland",
  "oklahoma city",
  "orlando",
  "philadelphia",
  "phoenix",
  "pittsburgh",
  "plano",
  "portland",
  "sacramento",
  "san antonio",
  "san diego",
  "san francisco",
  "san jose",
  "seattle",
  "st louis",
  "tampa",
  "tucson",
  "washington",
];

const KNOWN_COUNTY_SUFFIXES = ["county", "parish", "borough"];

export type DerivedLocation = {
  city: string | null;
  county: string | null;
  state: string | null;
};

export function buildSearchText(options: {
  programName: string | null;
  pageTitle: string | null;
  eligibility: Eligibility;
  rawEligibilityText: string;
  location: DerivedLocation;
}): string {
  const pieces = [
    options.programName,
    options.eligibility.programName,
    options.pageTitle,
    normalizeValue(options.location.city),
    normalizeValue(options.location.county),
    normalizeValue(options.location.state),
    options.eligibility.population.join(" "),
    options.eligibility.requirements.join(" "),
    options.eligibility.locationConstraints.join(" "),
    options.eligibility.notes,
    options.rawEligibilityText,
  ];

  return pieces
    .flatMap((value) => (value ? [value] : []))
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0)
    .join(" ");
}

export function deriveLocationFromEligibility(
  eligibility: Eligibility,
): DerivedLocation {
  for (const hint of eligibility.locationConstraints) {
    const parsed = parseLocationHint(hint);
    if (parsed.city || parsed.county || parsed.state) {
      return parsed;
    }
  }

  return { city: null, county: null, state: null };
}

export function parseLocationHint(raw: string): DerivedLocation {
  const cleaned = raw.trim();
  if (!cleaned) {
    return { city: null, county: null, state: null };
  }

  const lower = cleaned.toLowerCase();
  const normalized = cleaned.replace(/\s+/g, " ").trim();

  const state = findState(lower);
  let city: string | null = null;
  let county: string | null = null;

  if (state) {
    const parts = normalized.split(/,|\-/).map((part) => part.trim());
    if (parts.length >= 1) {
      const leading = parts[0];
      if (isCountyString(leading)) {
        county = titleCase(leading);
      } else if (leading.length > 0) {
        city = titleCase(leading);
      }
    }

    if (!county && !city && parts.length > 1) {
      county = titleCase(parts[1]);
    }

    return {
      city,
      county,
      state,
    };
  }

  const countyMatch = KNOWN_COUNTY_SUFFIXES.find((suffix) =>
    lower.includes(suffix),
  );
  if (countyMatch) {
    const beforeSuffix = normalized
      .split(new RegExp(`\\b${countyMatch}\\b`, "i"))[0]
      .trim();
    if (beforeSuffix) {
      county = titleCase(`${beforeSuffix} ${countyMatch}`);
    }
  }

  const cityCandidate = KNOWN_CITIES.find((candidate) =>
    lower.includes(candidate),
  );
  if (cityCandidate) {
    city = titleCase(cityCandidate);
  }

  return {
    city,
    county,
    state: null,
  };
}

function normalizeValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function findState(lower: string): string | null {
  for (const [name, abbreviation] of Object.entries(STATE_NAMES)) {
    if (lower.includes(name)) {
      return abbreviation;
    }
  }

  const stateAbbreviationMatch = lower.match(/\b([a-z]{2})\b/);
  if (stateAbbreviationMatch) {
    const candidate = stateAbbreviationMatch[1].toUpperCase();
    if (Object.values(STATE_NAMES).includes(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isCountyString(value: string) {
  return KNOWN_COUNTY_SUFFIXES.some((suffix) =>
    value.toLowerCase().includes(suffix),
  );
}

function titleCase(value: string) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
