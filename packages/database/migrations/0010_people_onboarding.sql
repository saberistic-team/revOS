CREATE TABLE organization_person (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organization(id),
 name text NOT NULL, email text NOT NULL, role text NOT NULL DEFAULT '', expertise jsonb NOT NULL DEFAULT '[]',
 primary_contact boolean NOT NULL DEFAULT false, source text NOT NULL DEFAULT 'operator' CHECK(source IN ('operator','customer','inferred')),
 evidence text NOT NULL DEFAULT '', state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','proposed','archived')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id), UNIQUE(organization_id,email)
);
CREATE UNIQUE INDEX organization_one_primary_contact ON organization_person(organization_id) WHERE primary_contact AND state='active';
CREATE TABLE participation_membership (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organization(id),
 person_id uuid NOT NULL, product_id uuid, campaign_id uuid, role text NOT NULL DEFAULT 'participant', can_review boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(person_id,organization_id) REFERENCES organization_person(id,organization_id)
);
CREATE TABLE participation_question (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organization(id),
 assigned_person_id uuid NOT NULL, title text NOT NULL, detail text NOT NULL DEFAULT '', why text NOT NULL DEFAULT '',
 priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('urgent','high','normal','low')), due_at timestamptz,
 campaign_id uuid, product_id uuid, run_id uuid REFERENCES run(id), source_key text UNIQUE,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','submitted','clarification','accepted','rejected')),
 latest_answer_id uuid, knowledge_change_id uuid, knowledge_state text NOT NULL DEFAULT 'none', knowledge_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id), FOREIGN KEY(assigned_person_id,organization_id) REFERENCES organization_person(id,organization_id)
);
CREATE INDEX participation_question_org_assignee ON participation_question(organization_id,assigned_person_id,state);
CREATE TABLE participation_question_revision (
 question_id uuid NOT NULL REFERENCES participation_question(id), revision integer NOT NULL, snapshot jsonb NOT NULL, actor text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(question_id,revision)
);
CREATE TABLE participation_answer_draft (
 question_id uuid NOT NULL, organization_id uuid NOT NULL, person_id uuid NOT NULL,
 question_revision integer NOT NULL, content text NOT NULL, evidence jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(question_id,person_id), FOREIGN KEY(question_id,organization_id) REFERENCES participation_question(id,organization_id),
 FOREIGN KEY(person_id,organization_id) REFERENCES organization_person(id,organization_id)
);
CREATE TABLE participation_answer (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), question_id uuid NOT NULL, organization_id uuid NOT NULL, person_id uuid NOT NULL,
 question_revision integer NOT NULL, content text NOT NULL, evidence jsonb NOT NULL DEFAULT '[]', submitted_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(question_id,organization_id) REFERENCES participation_question(id,organization_id),
 FOREIGN KEY(person_id,organization_id) REFERENCES organization_person(id,organization_id)
);
ALTER TABLE participation_question ADD CONSTRAINT participation_latest_answer FOREIGN KEY(latest_answer_id) REFERENCES participation_answer(id);
CREATE TABLE participation_review (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), question_id uuid NOT NULL REFERENCES participation_question(id), answer_id uuid REFERENCES participation_answer(id),
 action text NOT NULL CHECK(action IN ('accept','clarify','reassign','handoff','delegate','edit','reject')), comment text NOT NULL DEFAULT '',
 actor text NOT NULL, person_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE participation_invite (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, person_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, redeemed_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(person_id,organization_id) REFERENCES organization_person(id,organization_id)
);
CREATE TABLE participation_session (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, person_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE, csrf_hash text NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(person_id,organization_id) REFERENCES organization_person(id,organization_id)
);
CREATE TABLE participation_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, person_id uuid NOT NULL, invite_id uuid NOT NULL REFERENCES participation_invite(id),
 payload_ciphertext text NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed')),
 attempts integer NOT NULL DEFAULT 0, error text, message_id text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(person_id,organization_id) REFERENCES organization_person(id,organization_id)
);
CREATE FUNCTION participation_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Participation history is immutable'; END $$;
CREATE TRIGGER participation_answer_immutable BEFORE UPDATE OR DELETE ON participation_answer FOR EACH ROW EXECUTE FUNCTION participation_immutable_record();
CREATE TRIGGER participation_question_revision_immutable BEFORE UPDATE OR DELETE ON participation_question_revision FOR EACH ROW EXECUTE FUNCTION participation_immutable_record();
CREATE TRIGGER participation_review_immutable BEFORE UPDATE OR DELETE ON participation_review FOR EACH ROW EXECUTE FUNCTION participation_immutable_record();
