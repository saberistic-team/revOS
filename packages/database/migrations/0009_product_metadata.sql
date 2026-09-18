CREATE TABLE "product_metadata" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_metadata" ADD CONSTRAINT "product_metadata_product_id_code_build_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."code_build"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_metadata" ADD CONSTRAINT "product_metadata_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;