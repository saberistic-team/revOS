import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://engine:engine-local-only@127.0.0.1:15432/agent_engine",
  max: 10,
});
// A database pod restart can close idle pooled sockets. Subsequent queries reconnect.
pool.on("error", (error) =>
  console.warn("Idle database connection closed:", error.message),
);
export const db = drizzle(pool, { schema });
export * from "./schema";
