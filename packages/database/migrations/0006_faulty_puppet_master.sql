ALTER TABLE "organization" ADD COLUMN "kind" text DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "domain" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "aliases" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "customer_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "organization_resolution" jsonb;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_customer_organization_id_organization_id_fk" FOREIGN KEY ("customer_organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_domain_unique" UNIQUE("domain");--> statement-breakpoint
UPDATE organization SET kind='platform' WHERE lower(name)='revos';
--> statement-breakpoint
CREATE FUNCTION guard_customer_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.customer_organization_id IS NOT NULL AND NEW.customer_organization_id IS DISTINCT FROM OLD.customer_organization_id THEN RAISE EXCEPTION 'Customer binding is immutable'; END IF;
 IF OLD.execution_definition IS NOT NULL AND NEW.customer_organization_id IS DISTINCT FROM OLD.customer_organization_id THEN RAISE EXCEPTION 'Cannot change customer after execution starts'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER immutable_customer_binding BEFORE UPDATE ON run FOR EACH ROW EXECUTE FUNCTION guard_customer_binding();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_step_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_org uuid; skill_org uuid;
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Workflow steps are immutable; create a new version'; END IF;
 PERFORM 1 FROM workflow_version WHERE id=NEW.workflow_version_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM workflow_version_seal WHERE version_id=NEW.workflow_version_id) THEN RAISE EXCEPTION 'Published workflow steps are sealed'; END IF;
 IF NEW.skill_version_id IS NOT NULL THEN
  SELECT w.organization_id INTO owner_org FROM workflow w JOIN workflow_version v ON v.workflow_id=w.id WHERE v.id=NEW.workflow_version_id;
  SELECT s.organization_id INTO skill_org FROM skill s JOIN skill_version v ON v.skill_id=s.id WHERE v.id=NEW.skill_version_id;
  IF skill_org IS NOT NULL AND skill_org IS DISTINCT FROM owner_org AND NOT EXISTS(SELECT 1 FROM organization WHERE id=skill_org AND kind='platform') THEN RAISE EXCEPTION 'Skill belongs to a different organization'; END IF;
 END IF;
 RETURN NEW;
END $$;
