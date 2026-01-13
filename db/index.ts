import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

type Database = NodePgDatabase<typeof schema>;

function createMissingDatabaseProxy(): Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("DATABASE_URL is not set");
      },
    },
  ) as Database;
}

if (!connectionString) {
  if (process.env.NODE_ENV !== "test") {
    console.warn(
      "DATABASE_URL is not set. Database operations will fail at runtime.",
    );
  }
}

const pool = connectionString
  ? new Pool({
      connectionString,
      max: 10,
      ssl:
        process.env.NODE_ENV === "production"
          ? {
              rejectUnauthorized: true,
              ca: process.env.DATABASE_CA_CERT,
            }
          : undefined,
    })
  : null;

export const db: Database = pool
  ? drizzle(pool, { schema })
  : createMissingDatabaseProxy();
