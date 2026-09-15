import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'postgresql', schema: './packages/database/src/schema.ts', out: './packages/database/migrations', dbCredentials: { url: process.env.DATABASE_URL ?? 'postgresql://engine:engine-local-only@127.0.0.1:15432/agent_engine' } });
