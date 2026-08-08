# Mercy Networks

Finding a shelter bed tonight should not require reading a PDF.

Mercy Networks connects people experiencing homelessness — and the caseworkers who
serve them — to shelters, meals, medical care, and housing programs through plain
language. Ask for "bed tonight near Plano" instead of decoding a county services
packet.

## The problem it solves

Social services publish eligibility rules as PDF flyers, intake packets, and dense
program pages. A caseworker answering "does this person qualify?" reads the same
documents over and over, and someone in crisis has no realistic path through them
at all.

The core idea here is that **the first person to ask a question should make it
easier for the next one.** When a service isn't in the database yet, the app can
ingest it — parse the PDF or scrape the program page, extract structured
eligibility data, and persist it. The next person searching gets a verified answer
instead of a dead end.

## How it works

**Ingestion.** Two entry points, both landing in the same normalized shape:

| Route | Input | What it does |
| --- | --- | --- |
| `POST /api/parse-eligibility` | PDF upload | Extracts text with `pdf-parse`, then structures it with the AI SDK |
| `POST /api/parse-url` | Program page URL | Fetches and cleans with `cheerio`, then structures it |

Both persist to a single `eligibility_documents` table that deliberately keeps
**three representations** of every service:

- `rawText` — the full source document, so nothing is lost to a bad extraction
- `rawEligibilityText` — just the eligibility-relevant passage
- `eligibilityJson` — the structured `jsonb` payload the UI actually reads

Keeping the raw text alongside the structured output means a parsing bug is
recoverable — the source is still there to re-extract from. A `hash` column
deduplicates re-uploads of the same document.

**Search.** `POST /api/search-eligibility` interprets the query and matches against
stored services. Results are presented as plain-language answers — *who this helps*,
*what's required*, *where it is* — rather than raw database rows, because the person
reading is often in crisis and the interface should not add cognitive load.

**On-device interpretation.** `app/hooks/useBuiltInAiInterpreter.ts` uses Chrome's
built-in AI where available, so query interpretation can run locally without a
round trip. See [`docs/CHROME_AI.md`](docs/CHROME_AI.md).

## Stack

| | |
| --- | --- |
| Framework | Next.js (App Router) |
| AI | Vercel AI SDK — Anthropic and OpenAI providers |
| Database | PostgreSQL via Drizzle ORM |
| Parsing | `pdf-parse` for documents, `cheerio` for web pages |
| Validation | Zod on every extracted payload |

## Running locally

```bash
npm install
cp .env.example .env.local     # add database URL and an AI provider key
npm run db:migrate
npm run dev
```

`npm test` runs the unit and scorer tests offline — no API key needed.
Deployment notes are in [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Measuring extraction quality

Getting a model to return structured JSON is easy. Knowing whether that JSON is
*correct* is the actual problem, so extraction is scored against hand-labeled
documents.

```bash
npm run eval                     # score the extractor against every fixture
npm run eval -- --threshold=0.9  # exit non-zero below 90%
```

Two decisions worth stating: **the scorer is deterministic** — no model grades
another model, because an LLM judge introduces exactly the variance the harness
exists to measure. And **the scorer has its own unit tests**, so a green eval
means the extractor improved rather than the scoring drifting.

Grounding is scored separately from field accuracy: the model must quote the
passage stating eligibility *verbatim from the source*, and on a document that
states no eligibility rules the only correct answer is no quote at all. A run can
get every structured field right and still fail that check — which is the case
worth catching.

That control case earned its keep immediately. It exposed that
`rawEligibilityText` was declared `z.string().min(1)`, meaning a document with no
eligibility rules had **no valid answer** and the model was structurally forced to
fabricate a quote to satisfy the schema.

See [`evals/README.md`](evals/README.md) for the scoring rules and the full
fixture set.

## Layout

```
app/api/          ingestion, search, and record endpoints
app/records/      browse and inspect stored services
components/       search bar, result cards, UI primitives
db/schema.ts      the eligibility_documents table
drizzle/          migrations
evals/            labeled fixtures, deterministic scorer, runner
docs/             brand guide, Chrome AI notes, search spec
```

## Status

Working and deployed. `docs/SEARCH_TECH_SPEC.md` is a **draft** proposal for a
multi-stage search rewrite — `pg_trgm` fuzzy matching, a generated `search_tsv`
column, and ranked match tiers. It describes intended work, not what currently
ships.

## License

MIT — see [LICENSE.md](LICENSE.md).
