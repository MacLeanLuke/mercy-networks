# Extraction evals

Measures whether `extractEligibility` actually reads documents correctly, against
a set of hand-labeled cases.

```bash
npm test                        # scorer unit tests — offline, no API key
npm run eval                    # score the real extractor against every fixture
npm run eval -- --filter=youth  # one case
npm run eval -- --save          # write evals/baseline.json
npm run eval -- --threshold=0.9 # exit non-zero below 90% (for CI)
```

## Why it's built this way

**The scorer is deterministic. No model grades another model.** An LLM judge
introduces exactly the variance the harness exists to measure — if the score
moves, you'd never know whether the extractor changed or the judge did. Every
field here is scored by an explicit rule: set F1 for arrays, null-aware exact
match for scalars, substring containment for quotes.

**The scorer has its own tests.** `scorer.test.ts` runs offline in `npm test` with
no API key. This matters: a green eval should mean the extractor improved, not
that the scoring drifted. The scorer is the instrument, so the instrument gets
calibrated first.

**Empty sets score 1.0.** Most real documents state no requirements. Scoring that
as failure would drown the signal. Inventing entries the document never mentioned
drives precision to 0 — that asymmetry is deliberate, because over-extraction is
the failure mode that actually hurts users.

**Grounding is scored separately from accuracy.** The model is told to quote the
passage stating eligibility, so that quote must appear verbatim in the source.
A run can get every structured field right and still fail here, which is exactly
the case worth catching: plausible structure attached to a fabricated citation.

## Scoring

| Field | Rule |
| --- | --- |
| `programName` | Normalized exact match, null-aware |
| `population` | Set F1 |
| `genderRestriction` | Exact match |
| `requirements` | Set F1 |
| `locationConstraints` | Set F1, normalized |
| `maxStayDays` | Exact match, null-aware |
| `ageRange.min` / `.max` | Exact match, null-aware |
| `rawEligibilityText` | Grounding — see below |

Grounding has two correct behaviors depending on the document:

- Source **states** eligibility → the quote must appear verbatim (whitespace-normalized)
- Source states **none** → the only correct answer is an empty quote; any quote is a fabrication

## Fixtures

Ten labeled documents under `fixtures/<slug>/`, each with `source.txt` and
`expected.json`. Labels are parsed through the live `eligibilitySchema`, so a
schema change fails the fixtures loudly instead of silently scoring a shape that
no longer exists.

| Fixture | Exercises |
| --- | --- |
| `womens-shelter-with-children` | Gender restriction + families; hard residency rule |
| `veterans-transitional-housing` | Veteran status, sobriety, 24-month cap |
| `youth-drop-in-center` | Explicit age band |
| `sober-living-men` | Four stacked requirements |
| `family-emergency-shelter` | Required minor child, two counties |
| `senior-housing-income-limit` | Income cap, open-ended minimum age |
| `low-barrier-night-shelter` | Explicitly unrestricted — catches invented requirements |
| `no-eligibility-stated` | **Control.** An annual report. Any requirement extracted is a hallucination |
| `multi-site-locations` | Three service areas |
| `narrative-buried-rules` | Rules in prose, not a labeled section |

### Adding a case

```bash
mkdir -p evals/fixtures/my-case
# source.txt      the document text
# expected.json   { "description": "...", "expected": { ...Eligibility } }
npm test          # confirms the label parses and its quote is grounded
```

## What this harness has already caught

**The schema made hallucination mandatory.** `rawEligibilityText` was
`z.string().min(1)`. For a document that states no eligibility rules, there was no
valid answer — the model had to invent a quote to satisfy the schema. Found by
`no-eligibility-stated` on the first run. The field now allows `""`, and the
system prompt states that an empty answer is preferred over an invented one.

**A stale browser-AI provider.** `lib/ai-providers/browser.ts` cached the provider
in a module-level singleton that closed over whichever `window.ai` existed on the
first call. A provider created before the user granted Chrome AI permission kept
serving a dead session afterward. Now keyed on the `ai` object via `WeakMap`.

**The test suite did not run at all.** `jsdom` was missing, the `@/` path alias was
absent from `vitest.config.ts`, and `globals` was off — three independent reasons
`npm test` failed before reaching a single assertion.

## Cost

Ten cases at four-way concurrency. One run is ten extraction calls, so iterating
on the prompt is cheap. Use `--filter` while developing and the full set before
committing.
