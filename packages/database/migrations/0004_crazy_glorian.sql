CREATE TABLE "artifact_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"content_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_key" text NOT NULL,
	"run_id" uuid NOT NULL,
	"workflow_step_id" uuid NOT NULL,
	"session_id" uuid,
	"turn" integer,
	"skill_version_id" uuid,
	"title" text NOT NULL,
	"source_hash" text NOT NULL,
	"source_output" jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"summary" text,
	"provider_files" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_job_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
ALTER TABLE "artifact_file" ADD CONSTRAINT "artifact_file_job_id_artifact_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."artifact_job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_job" ADD CONSTRAINT "artifact_job_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_job" ADD CONSTRAINT "artifact_job_workflow_step_id_workflow_step_id_fk" FOREIGN KEY ("workflow_step_id") REFERENCES "public"."workflow_step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_job" ADD CONSTRAINT "artifact_job_session_id_reasoning_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."reasoning_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_job" ADD CONSTRAINT "artifact_job_skill_version_id_skill_version_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_version"("id") ON DELETE no action ON UPDATE no action;