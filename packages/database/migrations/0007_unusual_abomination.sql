ALTER TABLE "workspace_thread" ADD COLUMN "scope" text DEFAULT 'knowledge' NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_thread" ADD CONSTRAINT "workspace_thread_scope_check" CHECK (scope IN ('run', 'library', 'knowledge'));
