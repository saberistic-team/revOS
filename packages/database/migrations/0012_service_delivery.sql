CREATE TABLE product_delivery_config (
  product_id uuid PRIMARY KEY REFERENCES platform_product(id),
  organization_id uuid NOT NULL REFERENCES organization(id),
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  configuration jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product_id,organization_id) REFERENCES platform_product(id,organization_id)
);
--> statement-breakpoint
CREATE TABLE product_release (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES platform_product(id),
  organization_id uuid NOT NULL REFERENCES organization(id),
  build_id uuid NOT NULL REFERENCES code_build(id),
  request_id uuid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('preview','live')),
  state text NOT NULL DEFAULT 'ci_pending' CHECK(state IN ('ci_pending','awaiting_approval','publishing','syncing','healthy','failed')),
  source_commit text NOT NULL,
  repository_url text NOT NULL,
  image text,
  configuration jsonb NOT NULL,
  config_revision integer NOT NULL,
  ci_branch text NOT NULL,
  gitops_commit text,
  url text,
  error text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id, request_id),
  FOREIGN KEY(product_id,organization_id) REFERENCES platform_product(id,organization_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION product_release_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.product_id <> OLD.product_id OR NEW.organization_id <> OLD.organization_id OR NEW.build_id <> OLD.build_id OR NEW.source_commit <> OLD.source_commit OR NEW.configuration <> OLD.configuration OR NEW.environment <> OLD.environment OR NEW.request_id <> OLD.request_id OR (OLD.image IS NOT NULL AND NEW.image IS DISTINCT FROM OLD.image) THEN
    RAISE EXCEPTION 'Release source, configuration, ownership and image are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER immutable_product_release BEFORE UPDATE ON product_release FOR EACH ROW EXECUTE FUNCTION product_release_immutable();
