ALTER TABLE "eligibility_documents"
  ADD COLUMN "location_city" text,
  ADD COLUMN "location_county" text,
  ADD COLUMN "location_state" text,
  ADD COLUMN "search_text" text NOT NULL DEFAULT '';

ALTER TABLE "eligibility_documents"
  ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (
    to_tsvector('english', search_text)
  ) STORED;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "eligibility_documents_search_tsv_idx"
  ON "eligibility_documents" USING gin("search_tsv");

CREATE INDEX IF NOT EXISTS "eligibility_documents_search_trgm_idx"
  ON "eligibility_documents" USING gin("search_text" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "eligibility_documents_city_idx"
  ON "eligibility_documents" ("location_city");

CREATE INDEX IF NOT EXISTS "eligibility_documents_county_idx"
  ON "eligibility_documents" ("location_county");

CREATE INDEX IF NOT EXISTS "eligibility_documents_state_idx"
  ON "eligibility_documents" ("location_state");

UPDATE "eligibility_documents"
SET
  search_text = trim(concat_ws(' ',
    program_name,
    page_title,
    raw_eligibility_text,
    (eligibility_json->>'notes'),
    COALESCE((eligibility_json->'locationConstraints'->>0), '')
  )),
  location_city = NULLIF(trim(split_part((eligibility_json->'locationConstraints'->>0), ',', 1)), ''),
  location_state = NULLIF(trim(split_part((eligibility_json->'locationConstraints'->>0), ',', 2)), '');
