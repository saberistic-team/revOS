-- Versions are append-only from creation (stronger than immutable once used).
CREATE FUNCTION reject_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is immutable; create a new version', TG_TABLE_NAME; END $$;
CREATE TRIGGER immutable_workflow_version BEFORE UPDATE OR DELETE ON workflow_version FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();
CREATE TRIGGER immutable_skill_version BEFORE UPDATE OR DELETE ON skill_version FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();
-- Keep publication history, even when a newer version becomes current.
CREATE TABLE workflow_version_seal (version_id uuid PRIMARY KEY REFERENCES workflow_version(id));
CREATE FUNCTION guard_workflow_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid;
BEGIN
 IF NEW.current_version_id IS NOT NULL THEN
  SELECT workflow_id INTO owner_id FROM workflow_version WHERE id=NEW.current_version_id FOR UPDATE;
  IF owner_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Current version belongs to a different workflow'; END IF;
  IF NOT EXISTS(SELECT 1 FROM workflow_step WHERE workflow_version_id=NEW.current_version_id) THEN RAISE EXCEPTION 'Cannot publish an empty workflow'; END IF;
  INSERT INTO workflow_version_seal VALUES(NEW.current_version_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_publication BEFORE INSERT OR UPDATE OF current_version_id ON workflow FOR EACH ROW EXECUTE FUNCTION guard_workflow_publication();
CREATE FUNCTION guard_step_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_org uuid; skill_org uuid;
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Workflow steps are immutable; create a new version'; END IF;
 PERFORM 1 FROM workflow_version WHERE id=NEW.workflow_version_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM workflow_version_seal WHERE version_id=NEW.workflow_version_id) THEN RAISE EXCEPTION 'Published workflow steps are sealed'; END IF;
 IF NEW.skill_version_id IS NOT NULL THEN
  SELECT w.organization_id INTO owner_org FROM workflow w JOIN workflow_version v ON v.workflow_id=w.id WHERE v.id=NEW.workflow_version_id;
  SELECT s.organization_id INTO skill_org FROM skill s JOIN skill_version v ON v.skill_id=s.id WHERE v.id=NEW.skill_version_id;
  IF skill_org IS NOT NULL AND skill_org IS DISTINCT FROM owner_org THEN RAISE EXCEPTION 'Skill belongs to a different organization'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_workflow_step BEFORE INSERT OR UPDATE OR DELETE ON workflow_step FOR EACH ROW EXECUTE FUNCTION guard_step_mutation();
CREATE FUNCTION guard_run_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workflow_id_for_task uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.workflow_version_id<>OLD.workflow_version_id OR NEW.task_id<>OLD.task_id OR NEW.temporal_workflow_id<>OLD.temporal_workflow_id OR NEW.input IS DISTINCT FROM OLD.input THEN RAISE EXCEPTION 'Run execution identity is immutable'; END IF;
  IF OLD.execution_definition IS NOT NULL AND NEW.execution_definition IS DISTINCT FROM OLD.execution_definition THEN RAISE EXCEPTION 'Run snapshot is immutable'; END IF;
 ELSE
  SELECT workflow_id INTO workflow_id_for_task FROM task WHERE id=NEW.task_id;
  PERFORM 1 FROM workflow_version WHERE id=NEW.workflow_version_id AND workflow_id=workflow_id_for_task FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Run version does not belong to task workflow'; END IF;
  INSERT INTO workflow_version_seal VALUES(NEW.workflow_version_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_run_identity BEFORE INSERT OR UPDATE ON run FOR EACH ROW EXECUTE FUNCTION guard_run_identity();
CREATE FUNCTION guard_task_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.organization_id<>OLD.organization_id OR NEW.agent_id<>OLD.agent_id OR NEW.workflow_id<>OLD.workflow_id OR NEW.input IS DISTINCT FROM OLD.input) THEN RAISE EXCEPTION 'Task execution identity is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM agent WHERE id=NEW.agent_id AND organization_id=NEW.organization_id) OR NOT EXISTS(SELECT 1 FROM workflow WHERE id=NEW.workflow_id AND organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'Task organization mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_task_identity BEFORE INSERT OR UPDATE ON task FOR EACH ROW EXECUTE FUNCTION guard_task_identity();
CREATE UNIQUE INDEX skill_global_slug ON skill(slug) WHERE organization_id IS NULL;
