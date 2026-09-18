CREATE TABLE platform_product (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organization(id),
 name text NOT NULL, description text NOT NULL DEFAULT '', owner_person_id uuid,
 repository_url text NOT NULL DEFAULT '', runtime_kind text NOT NULL DEFAULT 'static' CHECK(runtime_kind IN ('static','service')),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','building','preview','live','archived')),
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id, organization_id), FOREIGN KEY(owner_person_id,organization_id) REFERENCES organization_person(id,organization_id)
);
--> statement-breakpoint
ALTER TABLE code_build ADD COLUMN product_id uuid;
--> statement-breakpoint
WITH RECURSIVE lineage AS (
 SELECT b.id,b.id AS root_id,b.organization_id FROM code_build b WHERE b.parent_id IS NULL OR NOT EXISTS(SELECT 1 FROM code_build p WHERE p.id=b.parent_id AND p.organization_id=b.organization_id)
 UNION ALL SELECT b.id,l.root_id,b.organization_id FROM code_build b JOIN lineage l ON b.parent_id=l.id AND b.organization_id=l.organization_id
)
INSERT INTO platform_product(id,organization_id,name,description,state,created_at)
SELECT b.id,b.organization_id,coalesce(m.name,left(regexp_replace(split_part(b.brief,E'\n',1),'^(Product: |#+[[:space:]]*)',''),160)),coalesce(m.description,''),
 CASE WHEN EXISTS(SELECT 1 FROM lineage l JOIN code_build v ON v.id=l.id WHERE l.root_id=b.id AND v.state='completed' AND v.result->>'previewUrl' IS NOT NULL) THEN 'preview' ELSE 'draft' END,b.created_at
FROM code_build b LEFT JOIN product_metadata m ON m.product_id=b.id AND m.organization_id=b.organization_id WHERE b.id IN(SELECT root_id FROM lineage)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
WITH RECURSIVE lineage AS (
 SELECT b.id,b.id AS root_id,b.organization_id FROM code_build b WHERE b.parent_id IS NULL OR NOT EXISTS(SELECT 1 FROM code_build p WHERE p.id=b.parent_id AND p.organization_id=b.organization_id)
 UNION ALL SELECT b.id,l.root_id,b.organization_id FROM code_build b JOIN lineage l ON b.parent_id=l.id AND b.organization_id=l.organization_id
)
UPDATE code_build b SET product_id=l.root_id FROM lineage l WHERE b.id=l.id;
--> statement-breakpoint
ALTER TABLE code_build ADD CONSTRAINT code_build_product_org_fk FOREIGN KEY(product_id,organization_id) REFERENCES platform_product(id,organization_id);
--> statement-breakpoint
CREATE FUNCTION assign_build_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.product_id IS NULL AND NEW.parent_id IS NOT NULL THEN SELECT product_id INTO NEW.product_id FROM code_build WHERE id=NEW.parent_id AND organization_id=NEW.organization_id; END IF;
 IF NEW.product_id IS NULL THEN
   NEW.product_id := NEW.id;
   INSERT INTO platform_product(id,organization_id,name,created_at) VALUES(NEW.id,NEW.organization_id,left(regexp_replace(split_part(NEW.brief,E'\n',1),'^(Product: |#+[[:space:]]*)',''),160),coalesce(NEW.created_at,now())) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER code_build_product BEFORE INSERT ON code_build FOR EACH ROW EXECUTE FUNCTION assign_build_product();
--> statement-breakpoint
CREATE TABLE platform_campaign (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organization(id), product_id uuid,
 name text NOT NULL, objective text NOT NULL, success_measure text NOT NULL DEFAULT '', owner_person_id uuid, stakeholder_ids uuid[] NOT NULL DEFAULT '{}',
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','running','review','completed','cancelled')), engagement_id uuid REFERENCES engagement(id),
 budget_micros bigint CHECK(budget_micros >= 0), currency text NOT NULL DEFAULT 'USD', revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,organization_id),
 FOREIGN KEY(product_id,organization_id) REFERENCES platform_product(id,organization_id), FOREIGN KEY(owner_person_id,organization_id) REFERENCES organization_person(id,organization_id)
);
--> statement-breakpoint
CREATE TABLE platform_requirement (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organization(id), campaign_id uuid NOT NULL,
 current_revision integer NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','changes_requested','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,organization_id),
 FOREIGN KEY(campaign_id,organization_id) REFERENCES platform_campaign(id,organization_id)
);
--> statement-breakpoint
CREATE TABLE requirement_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid NOT NULL REFERENCES platform_requirement(id), revision integer NOT NULL,
 title text NOT NULL, description text NOT NULL, acceptance_criteria jsonb NOT NULL, evidence jsonb NOT NULL DEFAULT '[]', author text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(requirement_id,revision)
);
--> statement-breakpoint
CREATE TABLE requirement_decision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid NOT NULL, revision integer NOT NULL,
 action text NOT NULL CHECK(action IN ('approve','request_changes','reject')), actor text NOT NULL, feedback text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(requirement_id,revision) REFERENCES requirement_revision(requirement_id,revision), UNIQUE(requirement_id,revision)
);
--> statement-breakpoint
CREATE TABLE usage_rate (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organization(id), provider text NOT NULL, category text NOT NULL, unit text NOT NULL,
 amount_micros bigint NOT NULL CHECK(amount_micros >= 0), per_units numeric NOT NULL CHECK(per_units > 0), currency text NOT NULL,
 effective_at timestamptz NOT NULL, source text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,provider,category,unit,currency,effective_at)
);
--> statement-breakpoint
CREATE TABLE usage_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organization(id), product_id uuid, campaign_id uuid, run_id uuid REFERENCES run(id), build_id uuid REFERENCES code_build(id),
 provider text NOT NULL, category text NOT NULL, event_key text NOT NULL, attempt_id text NOT NULL DEFAULT '', payload_hash text NOT NULL,
 units numeric(24,6) NOT NULL CHECK(units >= 0), unit text NOT NULL, measured_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 cost_micros bigint CHECK(cost_micros >= 0), cost_status text NOT NULL CHECK(cost_status IN ('actual','estimated','unpriced')), currency text NOT NULL, rate_id uuid REFERENCES usage_rate(id), metadata jsonb NOT NULL DEFAULT '{}',
 UNIQUE(organization_id,provider,event_key,attempt_id), UNIQUE(id,organization_id),
 FOREIGN KEY(product_id,organization_id) REFERENCES platform_product(id,organization_id), FOREIGN KEY(campaign_id,organization_id) REFERENCES platform_campaign(id,organization_id)
);
--> statement-breakpoint
CREATE INDEX usage_event_org_time ON usage_event(organization_id,measured_at);
--> statement-breakpoint
CREATE TABLE usage_reconciliation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, usage_event_id uuid NOT NULL, reconciliation_key text NOT NULL,
 actual_cost_micros bigint NOT NULL CHECK(actual_cost_micros >= 0), source text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,reconciliation_key), FOREIGN KEY(usage_event_id,organization_id) REFERENCES usage_event(id,organization_id)
);
--> statement-breakpoint
CREATE TABLE organization_budget (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organization(id), product_id uuid, month text NOT NULL,
 amount_micros bigint NOT NULL CHECK(amount_micros >= 0), currency text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(product_id,organization_id) REFERENCES platform_product(id,organization_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX organization_budget_scope ON organization_budget(organization_id,coalesce(product_id,'00000000-0000-0000-0000-000000000000'::uuid),month,currency);
--> statement-breakpoint
CREATE TABLE billing_terms (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organization(id), product_id uuid,
 revision integer NOT NULL, effective_month text NOT NULL, terms jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(product_id,organization_id) REFERENCES platform_product(id,organization_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX billing_terms_scope_revision ON billing_terms(organization_id,coalesce(product_id,'00000000-0000-0000-0000-000000000000'::uuid),revision);
--> statement-breakpoint
CREATE FUNCTION reject_platform_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'History is append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER usage_event_immutable BEFORE UPDATE OR DELETE ON usage_event FOR EACH ROW EXECUTE FUNCTION reject_platform_history_mutation();
--> statement-breakpoint
CREATE TRIGGER usage_reconciliation_immutable BEFORE UPDATE OR DELETE ON usage_reconciliation FOR EACH ROW EXECUTE FUNCTION reject_platform_history_mutation();
--> statement-breakpoint
CREATE TRIGGER usage_rate_immutable BEFORE UPDATE OR DELETE ON usage_rate FOR EACH ROW EXECUTE FUNCTION reject_platform_history_mutation();
--> statement-breakpoint
CREATE TRIGGER requirement_revision_immutable BEFORE UPDATE OR DELETE ON requirement_revision FOR EACH ROW EXECUTE FUNCTION reject_platform_history_mutation();
--> statement-breakpoint
CREATE TRIGGER requirement_decision_immutable BEFORE UPDATE OR DELETE ON requirement_decision FOR EACH ROW EXECUTE FUNCTION reject_platform_history_mutation();
--> statement-breakpoint
CREATE TRIGGER billing_terms_immutable BEFORE UPDATE OR DELETE ON billing_terms FOR EACH ROW EXECUTE FUNCTION reject_platform_history_mutation();
--> statement-breakpoint
CREATE TABLE usage_collection_config (
 organization_id uuid PRIMARY KEY REFERENCES organization(id), forgejo_enabled boolean NOT NULL DEFAULT true, opencost_enabled boolean NOT NULL DEFAULT false,
 interval_minutes integer NOT NULL DEFAULT 15 CHECK(interval_minutes BETWEEN 5 AND 1440), last_collected_at timestamptz, last_error text, updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE usage_storage_sample (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organization(id), product_id uuid,
 provider text NOT NULL, resource_key text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes>=0), bucket_start timestamptz NOT NULL,
 measured_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,provider,resource_key,bucket_start),
 FOREIGN KEY(product_id,organization_id) REFERENCES platform_product(id,organization_id)
);
--> statement-breakpoint
CREATE TABLE usage_ingestion_credential (
 product_id uuid PRIMARY KEY REFERENCES platform_product(id), token_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
