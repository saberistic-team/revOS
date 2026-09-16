ALTER TYPE "public"."execution_type" ADD VALUE 'agent';--> statement-breakpoint
ALTER TYPE "public"."step_type" ADD VALUE 'agent_loop';--> statement-breakpoint
CREATE TABLE "reasoning_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"workflow_step_id" uuid NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" "execution_status" DEFAULT 'running' NOT NULL,
	"output" jsonb,
	"error" text,
	"review_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reasoning_turn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"turn" integer NOT NULL,
	"request" jsonb NOT NULL,
	"decision" jsonb NOT NULL,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "positive_turn" CHECK ("reasoning_turn"."turn" >= 0)
);
--> statement-breakpoint
ALTER TABLE "workflow_step" DROP CONSTRAINT "step_skill_required";--> statement-breakpoint
ALTER TABLE "reasoning_session" ADD CONSTRAINT "reasoning_session_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reasoning_session" ADD CONSTRAINT "reasoning_session_workflow_step_id_workflow_step_id_fk" FOREIGN KEY ("workflow_step_id") REFERENCES "public"."workflow_step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reasoning_turn" ADD CONSTRAINT "reasoning_turn_session_id_reasoning_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."reasoning_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reasoning_session_step" ON "reasoning_session" USING btree ("run_id","workflow_step_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reasoning_turn_once" ON "reasoning_turn" USING btree ("session_id","turn");--> statement-breakpoint
ALTER TABLE "workflow_step" ADD CONSTRAINT "step_skill_required" CHECK (("workflow_step"."type" = 'skill' AND "workflow_step"."skill_version_id" IS NOT NULL) OR ("workflow_step"."type"::text IN ('human_review', 'agent_loop') AND "workflow_step"."skill_version_id" IS NULL));--> statement-breakpoint
CREATE FUNCTION guard_reasoning_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reasoning session is durable; deletion is not supported'; END IF;
 IF TG_OP='UPDATE' AND (NEW.run_id<>OLD.run_id OR NEW.workflow_step_id<>OLD.workflow_step_id OR NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.input IS DISTINCT FROM OLD.input) THEN RAISE EXCEPTION 'Reasoning session snapshot is immutable'; END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM run r JOIN workflow_step s ON s.workflow_version_id=r.workflow_version_id WHERE r.id=NEW.run_id AND s.id=NEW.workflow_step_id) THEN RAISE EXCEPTION 'Session step does not belong to run'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_session_identity BEFORE INSERT OR UPDATE OR DELETE ON reasoning_session FOR EACH ROW EXECUTE FUNCTION guard_reasoning_session();
CREATE FUNCTION guard_reasoning_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reasoning turn is immutable'; END IF;
 IF NEW.session_id<>OLD.session_id OR NEW.turn<>OLD.turn OR NEW.request IS DISTINCT FROM OLD.request OR NEW.decision IS DISTINCT FROM OLD.decision THEN RAISE EXCEPTION 'Reasoning decision is immutable'; END IF;
 IF OLD.outcome IS NOT NULL AND NEW.outcome IS DISTINCT FROM OLD.outcome THEN RAISE EXCEPTION 'Reasoning outcome is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_turn_identity BEFORE UPDATE OR DELETE ON reasoning_turn FOR EACH ROW EXECUTE FUNCTION guard_reasoning_turn();
