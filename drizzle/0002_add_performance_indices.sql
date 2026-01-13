-- Add indices for better search performance

-- Index on program_name for text search
CREATE INDEX IF NOT EXISTS idx_program_name ON eligibility_documents(program_name);

-- Index on page_title for text search
CREATE INDEX IF NOT EXISTS idx_page_title ON eligibility_documents(page_title);

-- Index on source_url for lookups
CREATE INDEX IF NOT EXISTS idx_source_url ON eligibility_documents(source_url);

-- GIN index for full-text search on raw_eligibility_text
CREATE INDEX IF NOT EXISTS idx_raw_eligibility_text_gin
  ON eligibility_documents
  USING GIN (to_tsvector('english', raw_eligibility_text));

-- GIN index on JSONB for better query performance
CREATE INDEX IF NOT EXISTS idx_eligibility_json_gin
  ON eligibility_documents
  USING GIN (eligibility_json);

-- Index on created_at for sorting
CREATE INDEX IF NOT EXISTS idx_created_at ON eligibility_documents(created_at DESC);

-- Index on source_type for filtering
CREATE INDEX IF NOT EXISTS idx_source_type ON eligibility_documents(source_type);

-- Index on hash for duplicate detection
CREATE INDEX IF NOT EXISTS idx_hash ON eligibility_documents(hash);
