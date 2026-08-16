import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const eligibilityDocuments = pgTable("eligibility_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => sql`now()`),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  fileSize: bigint("file_size", { mode: "number" }).notNull(),
  mimeType: varchar("mime_type", { length: 128 }).notNull(),
  rawText: text("raw_text").notNull(),
  rawEligibilityText: text("raw_eligibility_text").notNull(),
  eligibilityJson: jsonb("eligibility_json").notNull(),
  programName: varchar("program_name", { length: 255 }),
  hash: varchar("hash", { length: 128 }),
  sourceType: text("source_type").notNull().default("pdf"),
  sourceUrl: text("source_url"),
  pageTitle: text("page_title"),
  locationCity: text("location_city"),
  locationCounty: text("location_county"),
  locationState: text("location_state"),
  searchText: text("search_text").notNull().default(""),
  searchTsv: tsvector("search_tsv")
    .generatedAlwaysAs(sql`to_tsvector('english', search_text)`)
    .stored(),
});

export type EligibilityDocument = typeof eligibilityDocuments.$inferSelect;
export type NewEligibilityDocument = typeof eligibilityDocuments.$inferInsert;
