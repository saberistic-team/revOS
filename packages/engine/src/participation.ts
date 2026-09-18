import { z } from "zod";
import {
  createHash,
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { createInterface } from "node:readline";
import type { PoolClient } from "pg";
import { pool } from "../../database/src";
import {
  personInput,
  questionInput,
  answerInput,
  reviewInput,
  type CustomerSession,
} from "../../shared/src/participation";

export class ParticipationError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export function tokenMatches(raw: string, hash: string) {
  const a = Buffer.from(tokenHash(raw));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function isPortalPath(path: string) {
  return (
    path === "/customer" ||
    path === "/customer/" ||
    /^\/customer\/(app\.js|style\.css)$/.test(path) ||
    path.startsWith("/customer-api/") ||
    ["/health", "/ready"].includes(path)
  );
}
const fail = (message: string, code = 400): never => {
  throw new ParticipationError(message, code);
};
async function tx<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function requireOrg(c: PoolClient, org: string) {
  if (
    !(await c.query("SELECT id FROM organization WHERE id=$1", [org])).rowCount
  )
    fail("Organization not found", 404);
}
async function person(c: PoolClient, org: string, id: string, active = true) {
  const p = (
    await c.query(
      "SELECT * FROM organization_person WHERE organization_id=$1 AND id=$2",
      [org, id],
    )
  ).rows[0];
  if (!p || (active && p.state !== "active"))
    fail("Participant is unavailable in this organization", 404);
  return p;
}
async function question(c: PoolClient, org: string, id: string) {
  const q = (
    await c.query(
      "SELECT * FROM participation_question WHERE id=$1 AND organization_id=$2 FOR UPDATE",
      [id, org],
    )
  ).rows[0];
  if (!q) fail("Question not found", 404);
  return q;
}
export function assertAssigned(
  q: any,
  session: Pick<CustomerSession, "organizationId" | "personId">,
) {
  if (
    q.organization_id !== session.organizationId ||
    q.assigned_person_id !== session.personId
  )
    fail("This question is not assigned to you", 404);
}
export function assertRevision(q: any, expected: number) {
  if (q.revision !== expected)
    fail("This question changed. Refresh before continuing.", 409);
}
async function snapshot(c: PoolClient, q: any, actor: string) {
  await c.query(
    "INSERT INTO participation_question_revision(question_id,revision,snapshot,actor) VALUES($1,$2,$3,$4)",
    [q.id, q.revision, JSON.stringify(q), actor],
  );
}
async function scopedReferences(c: PoolClient, org: string, b: any) {
  if (b.campaignId) {
    const campaign = (
      await c.query(
        "SELECT product_id FROM platform_campaign WHERE id=$1 AND organization_id=$2 FOR SHARE",
        [b.campaignId, org],
      )
    ).rows[0];
    if (!campaign)
      fail("The selected campaign belongs to another organization", 404);
    if (
      campaign.product_id &&
      b.productId &&
      campaign.product_id !== b.productId
    )
      fail("The selected campaign belongs to a different product", 409);
    if (campaign.product_id) b.productId = campaign.product_id;
  }
  if (
    b.productId &&
    !(
      await c.query(
        "SELECT id FROM platform_product WHERE id=$1 AND organization_id=$2",
        [b.productId, org],
      )
    ).rowCount
  )
    fail("The selected product belongs to another organization", 404);
  if (
    b.runId &&
    !(
      await c.query(
        "SELECT r.id FROM run r JOIN task t ON t.id=r.task_id WHERE r.id=$1 AND coalesce(r.customer_organization_id,t.organization_id)=$2",
        [b.runId, org],
      )
    ).rowCount
  )
    fail("Run belongs to another organization", 404);
}
export async function participationState(org: string) {
  return tx(async (c) => {
    await requireOrg(c, org);
    const people = (
      await c.query(
        "SELECT * FROM organization_person WHERE organization_id=$1 ORDER BY primary_contact DESC,name",
        [org],
      )
    ).rows;
    const questions = (
      await c.query(
        "SELECT q.*,p.name AS assignee_name,product.name AS product_name,campaign.name AS campaign_name FROM participation_question q JOIN organization_person p ON p.id=q.assigned_person_id LEFT JOIN platform_product product ON product.id=q.product_id AND product.organization_id=q.organization_id LEFT JOIN platform_campaign campaign ON campaign.id=q.campaign_id AND campaign.organization_id=q.organization_id WHERE q.organization_id=$1 ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,q.created_at DESC",
        [org],
      )
    ).rows;
    const answers = (
      await c.query(
        "SELECT a.*,p.name AS respondent_name FROM participation_answer a JOIN organization_person p ON p.id=a.person_id WHERE a.organization_id=$1 ORDER BY a.submitted_at DESC",
        [org],
      )
    ).rows;
    const reviews = (
      await c.query(
        "SELECT r.* FROM participation_review r JOIN participation_question q ON q.id=r.question_id WHERE q.organization_id=$1 ORDER BY r.created_at DESC",
        [org],
      )
    ).rows;
    const invitations = (
      await c.query(
        "SELECT id,person_id,expires_at,redeemed_at,revoked_at,created_at FROM participation_invite WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
        [org],
      )
    ).rows;
    const deliveries = (
      await c.query(
        "SELECT id,person_id,state,attempts,error,sent_at,created_at FROM participation_outbox WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
        [org],
      )
    ).rows;
    const memberships = (
      await c.query(
        "SELECT * FROM participation_membership WHERE organization_id=$1",
        [org],
      )
    ).rows;
    const products = (
      await c.query(
        "SELECT id,name FROM platform_product WHERE organization_id=$1 ORDER BY name,id",
        [org],
      )
    ).rows;
    const campaigns = (
      await c.query(
        "SELECT id,name,product_id FROM platform_campaign WHERE organization_id=$1 ORDER BY name,id",
        [org],
      )
    ).rows;
    return {
      people,
      products,
      campaigns,
      questions,
      answers,
      reviews,
      invitations,
      deliveries,
      memberships,
      mailMode: process.env.MAIL_DELIVERY_MODE || "disabled",
    };
  });
}
export async function savePerson(org: string, input: unknown, id?: string) {
  const b = personInput.parse(input);
  if (b.source === "inferred" && b.primaryContact)
    fail("Confirm this participant before choosing a primary contact");
  return tx(async (c) => {
    await requireOrg(c, org);
    await c.query("SELECT id FROM organization WHERE id=$1 FOR UPDATE", [org]);
    if (id) await person(c, org, id, false);
    if (b.primaryContact)
      await c.query(
        "UPDATE organization_person SET primary_contact=false,updated_at=now() WHERE organization_id=$1 AND primary_contact",
        [org],
      );
    const state = b.source === "inferred" ? "proposed" : "active";
    const p = id
      ? (
          await c.query(
            "UPDATE organization_person SET name=$3,email=$4,role=$5,expertise=$6,primary_contact=$7,source=$8,evidence=$9,state=$10,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *",
            [
              id,
              org,
              b.name,
              b.email,
              b.role,
              JSON.stringify(b.expertise),
              b.primaryContact,
              b.source,
              b.evidence,
              state,
            ],
          )
        ).rows[0]
      : (
          await c.query(
            "INSERT INTO organization_person(organization_id,name,email,role,expertise,primary_contact,source,evidence,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
            [
              org,
              b.name,
              b.email,
              b.role,
              JSON.stringify(b.expertise),
              b.primaryContact,
              b.source,
              b.evidence,
              state,
            ],
          )
        ).rows[0];
    return p;
  });
}
/** Stable proposal IDs make retries safe without silently modifying an existing directory entry. */
export async function createParticipant(
  org: string,
  input: unknown,
  options: { id?: string } = {},
) {
  if (!options.id) return savePerson(org, input);
  const id = z.uuid().parse(options.id),
    b = personInput.parse(input);
  if (b.primaryContact && b.source === "inferred")
    fail("Confirm this participant before choosing a primary contact");
  return tx(async (c) => {
    await requireOrg(c, org);
    await c.query("SELECT id FROM organization WHERE id=$1 FOR UPDATE", [org]);
    const existing = (
      await c.query(
        "SELECT * FROM organization_person WHERE id=$1 OR (organization_id=$2 AND email=$3)",
        [id, org, b.email],
      )
    ).rows[0];
    if (existing) {
      if (existing.organization_id !== org)
        fail("Participant proposal belongs to another organization", 404);
      return existing;
    }
    if (b.primaryContact)
      await c.query(
        "UPDATE organization_person SET primary_contact=false,updated_at=now() WHERE organization_id=$1 AND primary_contact",
        [org],
      );
    return (
      await c.query(
        "INSERT INTO organization_person(id,organization_id,name,email,role,expertise,primary_contact,source,evidence,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
        [
          id,
          org,
          b.name,
          b.email,
          b.role,
          JSON.stringify(b.expertise),
          b.primaryContact,
          b.source,
          b.evidence,
          b.source === "inferred" ? "proposed" : "active",
        ],
      )
    ).rows[0];
  });
}
export async function setMembership(
  org: string,
  personId: string,
  b: {
    productId?: string | null;
    campaignId?: string | null;
    role: string;
    canReview: boolean;
  },
) {
  return tx(async (c) => {
    await person(c, org, personId);
    await scopedReferences(c, org, b);
    await c.query(
      "DELETE FROM participation_membership WHERE organization_id=$1 AND person_id=$2 AND product_id IS NOT DISTINCT FROM $3::uuid AND campaign_id IS NOT DISTINCT FROM $4::uuid",
      [org, personId, b.productId || null, b.campaignId || null],
    );
    return (
      await c.query(
        "INSERT INTO participation_membership(organization_id,person_id,product_id,campaign_id,role,can_review) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [
          org,
          personId,
          b.productId || null,
          b.campaignId || null,
          b.role,
          b.canReview,
        ],
      )
    ).rows[0];
  });
}
export async function createQuestion(org: string, input: unknown) {
  const b = questionInput.parse(input);
  return tx(async (c) => {
    await person(c, org, b.assignedPersonId);
    await scopedReferences(c, org, b);
    if (b.sourceKey) {
      const old = (
        await c.query(
          "SELECT * FROM participation_question WHERE source_key=$1",
          [b.sourceKey],
        )
      ).rows[0];
      if (old) {
        if (old.organization_id !== org) fail("Question source conflict", 409);
        return old;
      }
    }
    const q = (
      await c.query(
        "INSERT INTO participation_question(organization_id,assigned_person_id,title,detail,why,priority,due_at,campaign_id,product_id,run_id,source_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
        [
          org,
          b.assignedPersonId,
          b.title,
          b.detail,
          b.why,
          b.priority,
          b.dueAt || null,
          b.campaignId || null,
          b.productId || null,
          b.runId || null,
          b.sourceKey || null,
        ],
      )
    ).rows[0];
    await snapshot(c, q, "operator");
    return q;
  });
}
export async function editQuestion(
  org: string,
  id: string,
  input: unknown,
  expectedRevision: number,
) {
  const b = questionInput.parse(input);
  return tx(async (c) => {
    const q = await question(c, org, id);
    assertRevision(q, expectedRevision);
    if (["accepted", "rejected"].includes(q.state))
      fail("Create a follow-up question to preserve the accepted answer", 409);
    await person(c, org, b.assignedPersonId);
    await scopedReferences(c, org, b);
    const updated = (
      await c.query(
        "UPDATE participation_question SET assigned_person_id=$3,title=$4,detail=$5,why=$6,priority=$7,due_at=$8,campaign_id=$9,product_id=$10,run_id=$11,revision=revision+1,state='open',latest_answer_id=null,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *",
        [
          id,
          org,
          b.assignedPersonId,
          b.title,
          b.detail,
          b.why,
          b.priority,
          b.dueAt || null,
          b.campaignId || null,
          b.productId || null,
          b.runId || null,
        ],
      )
    ).rows[0];
    await snapshot(c, updated, "operator");
    return updated;
  });
}
export async function createInvite(org: string, personId: string) {
  return tx(async (c) => {
    const p = await person(c, org, personId);
    await c.query("SELECT id FROM organization_person WHERE id=$1 FOR UPDATE", [
      personId,
    ]);
    const raw = newToken();
    await c.query(
      "UPDATE participation_invite SET revoked_at=now() WHERE organization_id=$1 AND person_id=$2 AND redeemed_at IS NULL AND revoked_at IS NULL",
      [org, personId],
    );
    const row = (
      await c.query(
        "INSERT INTO participation_invite(organization_id,person_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '7 days') RETURNING id,expires_at",
        [org, personId, tokenHash(raw)],
      )
    ).rows[0];
    const url = new URL(
      process.env.PUBLIC_PORTAL_URL || "http://localhost:3005/customer",
    );
    url.hash = "invite=" + raw;
    return { ...row, url: url.toString(), name: p.name, email: p.email };
  });
}
export async function redeemInvite(raw: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw))
    fail("Invitation is invalid or expired", 401);
  return tx(async (c) => {
    const row = (
      await c.query(
        "SELECT i.*,p.name,p.state,p.primary_contact FROM participation_invite i JOIN organization_person p ON p.id=i.person_id WHERE i.token_hash=$1 FOR UPDATE OF i",
        [tokenHash(raw)],
      )
    ).rows[0];
    if (
      !row ||
      row.revoked_at ||
      row.redeemed_at ||
      new Date(row.expires_at) <= new Date() ||
      row.state !== "active"
    )
      fail(
        "Invitation is invalid, expired, or already used. Ask your contact for a new link.",
        401,
      );
    const token = newToken(),
      csrf = newToken();
    await c.query(
      "UPDATE participation_invite SET redeemed_at=now() WHERE id=$1",
      [row.id],
    );
    await c.query(
      "INSERT INTO participation_session(organization_id,person_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '14 days')",
      [row.organization_id, row.person_id, tokenHash(token), tokenHash(csrf)],
    );
    return { token, csrf, name: row.name };
  });
}
export async function customerSession(
  raw: string,
  csrf?: string,
): Promise<CustomerSession> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw))
    fail("Sign in with your invitation link", 401);
  const row = (
    await pool.query(
      "SELECT s.*,p.name,p.primary_contact,p.state FROM participation_session s JOIN organization_person p ON p.id=s.person_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()",
      [tokenHash(raw)],
    )
  ).rows[0];
  if (!row || row.state !== "active")
    fail("Your session expired. Ask for a new invitation.", 401);
  if (csrf !== undefined && !tokenMatches(csrf, row.csrf_hash))
    fail("Refresh this page before submitting", 403);
  return {
    id: row.id,
    organizationId: row.organization_id,
    personId: row.person_id,
    name: row.name,
    primaryContact: row.primary_contact,
    csrf: row.csrf_hash,
  };
}
export async function revokePersonAccess(org: string, personId: string) {
  return tx(async (c) => {
    await person(c, org, personId, false);
    await c.query(
      "UPDATE participation_session SET revoked_at=now() WHERE organization_id=$1 AND person_id=$2 AND revoked_at IS NULL",
      [org, personId],
    );
    await c.query(
      "UPDATE participation_invite SET revoked_at=now() WHERE organization_id=$1 AND person_id=$2 AND revoked_at IS NULL",
      [org, personId],
    );
    return { revoked: true };
  });
}
export async function portalState(session: CustomerSession) {
  return tx(async (c) => {
    const org = (
      await c.query("SELECT name FROM organization WHERE id=$1", [
        session.organizationId,
      ])
    ).rows[0];
    const qs = (
      await c.query(
        "SELECT q.id,q.title,q.detail,q.why,q.priority,q.due_at,q.revision,q.state,q.latest_answer_id,d.content AS draft_content,d.evidence AS draft_evidence,d.question_revision AS draft_revision FROM participation_question q LEFT JOIN participation_answer_draft d ON d.question_id=q.id AND d.person_id=$2 WHERE q.organization_id=$1 AND q.assigned_person_id=$2 ORDER BY CASE q.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,q.created_at",
        [session.organizationId, session.personId],
      )
    ).rows;
    const answers = (
      await c.query(
        "SELECT a.id,a.question_id,a.content,a.evidence,a.submitted_at,a.question_revision,p.name AS respondent_name FROM participation_answer a JOIN participation_question q ON q.id=a.question_id JOIN organization_person p ON p.id=a.person_id WHERE q.organization_id=$1 AND q.assigned_person_id=$2 ORDER BY a.submitted_at DESC",
        [session.organizationId, session.personId],
      )
    ).rows;
    const reviews = (
      await c.query(
        "SELECT r.id,r.question_id,r.action,r.comment,r.created_at FROM participation_review r JOIN participation_question q ON q.id=r.question_id WHERE q.organization_id=$1 AND q.assigned_person_id=$2 ORDER BY r.created_at DESC",
        [session.organizationId, session.personId],
      )
    ).rows;
    const onboarding = session.primaryContact
      ? {
          people: (
            await c.query(
              "SELECT id,name,role,primary_contact FROM organization_person WHERE organization_id=$1 AND state='active' ORDER BY name",
              [session.organizationId],
            )
          ).rows,
          progress: (
            await c.query(
              "SELECT p.id,p.name,count(q.id)::int AS total,count(q.id) FILTER(WHERE q.state='accepted')::int AS accepted FROM organization_person p LEFT JOIN participation_question q ON q.assigned_person_id=p.id AND q.organization_id=p.organization_id WHERE p.organization_id=$1 AND p.state='active' GROUP BY p.id,p.name",
              [session.organizationId],
            )
          ).rows,
        }
      : null;
    return {
      organization: org.name,
      person: { name: session.name, primaryContact: session.primaryContact },
      questions: qs,
      answers,
      reviews,
      onboarding,
    };
  });
}
export async function writeAnswer(
  session: CustomerSession,
  id: string,
  input: unknown,
  submit = false,
) {
  const b = answerInput.parse(input);
  return tx(async (c) => {
    const q = await question(c, session.organizationId, id);
    assertAssigned(q, session);
    assertRevision(q, b.questionRevision);
    if (["accepted", "submitted", "rejected"].includes(q.state))
      fail(
        q.state === "accepted"
          ? "This answer was accepted. Ask your contact to open a follow-up."
          : "This answer is awaiting review.",
        409,
      );
    if (!submit) {
      await c.query(
        "INSERT INTO participation_answer_draft(question_id,organization_id,person_id,question_revision,content,evidence) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(question_id,person_id) DO UPDATE SET question_revision=excluded.question_revision,content=excluded.content,evidence=excluded.evidence,updated_at=now()",
        [
          id,
          session.organizationId,
          session.personId,
          q.revision,
          b.content,
          JSON.stringify(b.evidence),
        ],
      );
      return { saved: true };
    }
    const answer = (
      await c.query(
        "INSERT INTO participation_answer(question_id,organization_id,person_id,question_revision,content,evidence) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [
          id,
          session.organizationId,
          session.personId,
          q.revision,
          b.content,
          JSON.stringify(b.evidence),
        ],
      )
    ).rows[0];
    await c.query(
      "UPDATE participation_question SET state='submitted',latest_answer_id=$2,updated_at=now() WHERE id=$1",
      [id, answer.id],
    );
    await c.query(
      "DELETE FROM participation_answer_draft WHERE question_id=$1 AND person_id=$2",
      [id, session.personId],
    );
    return answer;
  });
}
export async function suggestDelegate(
  session: CustomerSession,
  id: string,
  comment: string,
) {
  return tx(async (c) => {
    const q = await question(c, session.organizationId, id);
    assertAssigned(q, session);
    if (["accepted", "rejected"].includes(q.state))
      fail("Question already closed", 409);
    return (
      await c.query(
        "INSERT INTO participation_review(question_id,action,comment,actor,person_id) VALUES($1,'delegate',$2,$3,$4) RETURNING *",
        [id, comment, session.name, session.personId],
      )
    ).rows[0];
  });
}
export async function nominatePerson(session: CustomerSession, input: unknown) {
  if (!session.primaryContact)
    fail("Only the primary contact may nominate participants", 403);
  const b = personInput.parse(input);
  return savePerson(session.organizationId, {
    ...b,
    source: "inferred",
    primaryContact: false,
    evidence: `Nominated by ${session.name}. ${b.evidence}`,
  });
}
export async function reviewAnswer(org: string, id: string, input: unknown) {
  const b = reviewInput.parse(input);
  return tx(async (c) => {
    const q = await question(c, org, id);
    assertRevision(q, b.expectedRevision);
    if (["accepted", "rejected"].includes(q.state))
      fail("Question already closed; create a follow-up", 409);
    if (
      ["accept", "clarify"].includes(b.action) &&
      (q.state !== "submitted" || q.latest_answer_id !== b.answerId)
    )
      fail("This answer is no longer awaiting review", 409);
    if (
      b.answerId &&
      !(
        await c.query(
          "SELECT id FROM participation_answer WHERE id=$1 AND question_id=$2 AND organization_id=$3",
          [b.answerId, id, org],
        )
      ).rowCount
    )
      fail("Answer does not belong to this question", 404);
    let target = b.action === "reassign" ? b.personId : undefined;
    if (b.action === "handoff") {
      target = (
        await c.query(
          "SELECT id FROM organization_person WHERE organization_id=$1 AND primary_contact AND state='active'",
          [org],
        )
      ).rows[0]?.id;
      if (!target) fail("Choose a primary contact first");
    }
    if (target) await person(c, org, target);
    const nextState =
      b.action === "accept"
        ? "accepted"
        : b.action === "reject"
          ? "rejected"
          : b.action === "clarify"
            ? "clarification"
            : "open";
    const updated = (
      await c.query(
        "UPDATE participation_question SET state=$3,assigned_person_id=coalesce($4::uuid,assigned_person_id),revision=revision+1,knowledge_state=CASE WHEN $3='accepted' THEN 'pending' ELSE knowledge_state END,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *",
        [id, org, nextState, target || null],
      )
    ).rows[0];
    await snapshot(c, updated, b.reviewer);
    await c.query(
      "INSERT INTO participation_review(question_id,answer_id,action,comment,actor,person_id) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        b.answerId || q.latest_answer_id,
        b.action,
        b.comment,
        b.reviewer,
        target || null,
      ],
    );
    return updated;
  });
}
export async function publishAcceptedAnswer(id: string) {
  const data = (
    await pool.query(
      "SELECT q.*,a.content,a.evidence,a.person_id,a.submitted_at,a.question_revision AS answered_revision,p.name AS respondent_name FROM participation_question q JOIN participation_answer a ON a.id=q.latest_answer_id JOIN organization_person p ON p.id=a.person_id WHERE q.id=$1 AND q.state='accepted'",
      [id],
    )
  ).rows[0];
  if (!data || data.knowledge_state === "applied") return;
  try {
    const { createChange, applyChange } = await import("./workspace-service");
    const body = {
      title: data.title.slice(0, 200),
      category: "business",
      evidence: "customer_confirmed",
      content: `## Question\n${data.detail || data.title}\n\n## Answer\n${data.content}\n\nAnswered by **${data.respondent_name}** on ${new Date(data.submitted_at).toISOString()}.\n\n${data.evidence.map((e: any) => `- ${e.label}: ${e.url}`).join("\n")}`,
      relatedIds: [],
    };
    const change = await createChange({
      organizationId: data.organization_id,
      kind: "knowledge",
      title: `Accepted answer: ${data.title}`.slice(0, 200),
      reason: "A reviewer accepted the customer's attributed response.",
      body,
      sourceKey: `participation-answer:${data.latest_answer_id}`,
      state: "approved",
      provenance: {
        questionId: id,
        answerId: data.latest_answer_id,
        questionRevision: data.answered_revision,
        respondentId: data.person_id,
        productId: data.product_id,
        campaignId: data.campaign_id,
        runId: data.run_id,
      },
    });
    await pool.query(
      "UPDATE participation_question SET knowledge_change_id=$2,knowledge_state='applying',knowledge_error=null WHERE id=$1",
      [id, change.id],
    );
    await applyChange(change.id, data.organization_id);
    await pool.query(
      "UPDATE participation_question SET knowledge_state='applied',knowledge_error=null WHERE id=$1",
      [id],
    );
  } catch (e) {
    await pool.query(
      "UPDATE participation_question SET knowledge_state='failed',knowledge_error=$2 WHERE id=$1",
      [id, (e as Error).message.slice(0, 1000)],
    );
    throw e;
  }
}
function encryptionKey() {
  const raw = process.env.PARTICIPATION_TOKEN_KEY || "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32)
    fail(
      "Configure PARTICIPATION_TOKEN_KEY before preparing email invitations",
      503,
    );
  return key;
}
export function encryptEmail(payload: unknown, key = encryptionKey()) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((x) => x.toString("base64url"))
    .join(".");
}
export function decryptEmail(value: string, key = encryptionKey()) {
  const [iv, tag, data] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", key, iv);
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8"),
  );
}
export async function queueInvitation(org: string, personId: string) {
  encryptionKey();
  const mode = process.env.MAIL_DELIVERY_MODE || "disabled";
  if (!["local", "smtp"].includes(mode))
    fail(
      "Email delivery is disabled. You can copy an invitation link instead.",
      503,
    );
  const invite = await createInvite(org, personId);
  const id = randomUUID();
  const payload = {
    to: invite.email,
    subject: "Your customer onboarding invitation",
    text: `Hello ${invite.name},\n\nYou have been invited to answer questions for your organization. Your private link is valid for seven days and can be used once:\n\n${invite.url}\n\nPlease do not forward this link. Your answers will be reviewed before updating organization knowledge.`,
  };
  await pool.query(
    "INSERT INTO participation_outbox(id,organization_id,person_id,invite_id,payload_ciphertext,message_id) VALUES($1,$2,$3,$4,$5,$6)",
    [
      id,
      org,
      personId,
      invite.id,
      encryptEmail(payload),
      `<${id}@revos.local>`,
    ],
  );
  return { id, mode };
}
export async function sendSmtp(
  payload: { to: string; subject: string; text: string },
  messageId: string,
) {
  const mode = process.env.MAIL_DELIVERY_MODE,
    host = process.env.SMTP_HOST || "",
    port = Number(process.env.SMTP_PORT || 1025),
    secure = process.env.SMTP_SECURE === "true";
  if (!host || !["local", "smtp"].includes(mode || ""))
    fail("SMTP is not configured", 503);
  if (mode === "smtp" && !secure)
    fail("External SMTP requires TLS (SMTP_SECURE=true)", 503);
  if (
    mode === "local" &&
    !/^(mailpit(?:\.[a-z0-9.-]+)?|localhost|127\.0\.0\.1)$/.test(host)
  )
    fail("Local inbox delivery must target Mailpit or localhost", 503);
  const socket = secure
    ? tlsConnect({ host, port, servername: host })
    : netConnect({ host, port });
  socket.setTimeout(20000, () => socket.destroy(new Error("SMTP timed out")));
  const lines = createInterface({ input: socket, crlfDelay: Infinity }),
    reader = lines[Symbol.asyncIterator]();
  let connectionError: Error | undefined;
  socket.on("error", (error) => {
    connectionError = error;
    lines.close();
  });
  const response = async () => {
    let final = "";
    for (let n = 0; n < 50; n++) {
      const r = await reader.next();
      if (r.done) throw connectionError || Error("SMTP connection closed");
      final = r.value;
      if (/^\d{3} /.test(final))
        return { code: Number(final.slice(0, 3)), text: final };
    }
    throw Error("SMTP invalid response");
  };
  const command = async (line: string, expected: number[]) => {
    socket.write(line + "\r\n");
    const reply = await response();
    if (!expected.includes(reply.code))
      throw Error(`SMTP rejected command (${reply.code})`);
  };
  try {
    const greeting = await response();
    if (greeting.code !== 220) throw Error("SMTP greeting failed");
    await command("EHLO revos.local", [250]);
    if (process.env.SMTP_USER) {
      if (!secure) fail("SMTP credentials require TLS", 503);
      await command(
        "AUTH PLAIN " +
          Buffer.from(
            `\0${process.env.SMTP_USER}\0${process.env.SMTP_PASSWORD || ""}`,
          ).toString("base64"),
        [235],
      );
    }
    const from = process.env.SMTP_FROM || "onboarding@revos.local";
    if (
      /[\r\n<>]/.test(from + payload.to) ||
      /[\r\n]/.test(payload.subject + messageId)
    )
      throw Error("Invalid mail header");
    await command(`MAIL FROM:<${from}>`, [250]);
    await command(`RCPT TO:<${payload.to}>`, [250, 251]);
    await command("DATA", [354]);
    const body = payload.text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    await command(
      `From: ${from}\r\nTo: ${payload.to}\r\nSubject: =?UTF-8?B?${Buffer.from(payload.subject).toString("base64")}?=\r\nMessage-ID: ${messageId}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}\r\n.`,
      [250],
    );
    await command("QUIT", [221]);
  } finally {
    socket.destroy();
  }
}
export async function deliverOutbox(id: string) {
  const lock = await pool.connect();
  let acquired = false;
  try {
    acquired = (
      await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [
        "participation-mail:" + id,
      ])
    ).rows[0].ok;
    if (!acquired) throw Error("Invitation delivery already running");
    const row = (
      await lock.query(
        "SELECT o.*,i.expires_at,i.revoked_at,i.redeemed_at FROM participation_outbox o JOIN participation_invite i ON i.id=o.invite_id WHERE o.id=$1",
        [id],
      )
    ).rows[0];
    if (!row) throw Error("Invitation delivery missing");
    if (row.state === "sent") return;
    if (
      row.revoked_at ||
      row.redeemed_at ||
      new Date(row.expires_at) < new Date()
    )
      throw Error("Invitation is no longer active; create a new invitation");
    await lock.query(
      "UPDATE participation_outbox SET state='sending',attempts=attempts+1,error=null,updated_at=now() WHERE id=$1",
      [id],
    );
    await sendSmtp(decryptEmail(row.payload_ciphertext), row.message_id);
    await lock.query(
      "UPDATE participation_outbox SET state='sent',payload_ciphertext='',sent_at=now(),updated_at=now() WHERE id=$1",
      [id],
    );
  } catch (e) {
    await lock.query(
      "UPDATE participation_outbox SET state='failed',error=$2,updated_at=now() WHERE id=$1 AND state<>'sent'",
      [id, (e as Error).message.slice(0, 500)],
    );
    throw e;
  } finally {
    if (acquired)
      await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [
        "participation-mail:" + id,
      ]);
    lock.release();
  }
}
export const participationTools = {
  participation_people: async (organizationId: string) =>
    (await participationState(organizationId)).people,
  participation_propose_person: async (
    organizationId: string,
    input: unknown,
  ) =>
    savePerson(organizationId, {
      ...personInput.parse(input),
      source: "inferred",
      primaryContact: false,
    }),
  participation_assign_question: createQuestion,
};
export async function reviewedParticipationResult(input: {
  questionId: string;
  organizationId: string;
}): Promise<
  import("../../shared/src/participation").ReviewedParticipationAnswer | null
> {
  const q = (
    await pool.query(
      "SELECT * FROM participation_question WHERE id=$1 AND organization_id=$2",
      [input.questionId, input.organizationId],
    )
  ).rows[0];
  if (!q) fail("Question not found", 404);
  if (!["accepted", "rejected"].includes(q.state)) return null;
  const answer = q.latest_answer_id
    ? (
        await pool.query(
          "SELECT a.*,p.name AS respondent_name FROM participation_answer a JOIN organization_person p ON p.id=a.person_id WHERE a.id=$1",
          [q.latest_answer_id],
        )
      ).rows[0]
    : null;
  const review = (
    await pool.query(
      "SELECT * FROM participation_review WHERE question_id=$1 AND action IN ('accept','reject') ORDER BY created_at DESC LIMIT 1",
      [q.id],
    )
  ).rows[0];
  return {
    state: q.state,
    questionId: q.id,
    questionRevision: q.revision,
    answer: answer
      ? {
          id: answer.id,
          content: answer.content,
          evidence: answer.evidence,
          personId: answer.person_id,
          respondentName: answer.respondent_name,
          submittedAt: new Date(answer.submitted_at).toISOString(),
          questionRevision: answer.question_revision,
        }
      : null,
    review: review
      ? {
          action: review.action,
          comment: review.comment,
          reviewer: review.actor,
        }
      : null,
  };
}
export const participationToolDefinitions: {
  name: string;
  slug: string;
  handler: string;
  description: string;
  inputSchema: import("../../shared/src").Json;
  outputSchema: import("../../shared/src").Json;
}[] = [
  {
    name: "List organization participants",
    slug: "organization-people",
    handler: "participation.people",
    description:
      "Read confirmed and proposed stakeholders in this run's organization. Does not contact anyone.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200 },
        offset: { type: "integer", minimum: 0, maximum: 10000 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { people: { type: "array" } },
      required: ["people"],
    },
  },
  {
    name: "Propose organization participant",
    slug: "organization-person-propose",
    handler: "participation.propose-person",
    description:
      "Propose a stakeholder for human confirmation. Requires a verified email; never guesses an address and never sends an invitation.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 160 },
        email: { type: "string", format: "email" },
        role: { type: "string", maxLength: 160 },
        evidence: { type: "string", maxLength: 3000 },
      },
      required: ["name", "email", "role", "evidence"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { personId: { type: "string" }, state: { type: "string" } },
      required: ["personId", "state"],
    },
  },
  {
    name: "Ask organization participant",
    slug: "organization-person-question",
    handler: "participation.ask",
    description:
      "Assign a prioritized question to a confirmed named stakeholder. Pauses reasoning durably until a reviewer accepts or rejects their response. Does not send an email automatically.",
    inputSchema: {
      type: "object",
      properties: {
        assignedPersonId: { type: "string", format: "uuid" },
        title: { type: "string", maxLength: 300 },
        detail: { type: "string", maxLength: 12000 },
        why: { type: "string", maxLength: 3000 },
        priority: { type: "string", enum: ["urgent", "high", "normal", "low"] },
      },
      required: ["assignedPersonId", "title", "detail", "why", "priority"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        participationQuestionId: { type: "string" },
        state: { type: "string" },
        assignedPersonId: { type: "string" },
        question: { type: "string" },
        organizationId: { type: "string" },
      },
      required: [
        "participationQuestionId",
        "state",
        "assignedPersonId",
        "question",
        "organizationId",
      ],
    },
  },
  {
    name: "Read reviewed participant answer",
    slug: "organization-person-answer",
    handler: "participation.answer",
    description:
      "Read an attributed, versioned, human-reviewed stakeholder answer for this organization.",
    inputSchema: {
      type: "object",
      properties: { questionId: { type: "string", format: "uuid" } },
      required: ["questionId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        state: { type: "string" },
        result: { type: ["object", "null"] },
      },
      required: ["state", "result"],
    },
  },
];
async function participationToolContext(key?: string) {
  const sessionId = z.uuid().parse(key?.split(":")[0]);
  const row = (
    await pool.query(
      "SELECT r.id AS run_id,coalesce(r.customer_organization_id,t.organization_id) AS organization_id FROM reasoning_session s JOIN run r ON r.id=s.run_id JOIN task t ON t.id=r.task_id WHERE s.id=$1",
      [sessionId],
    )
  ).rows[0];
  if (!row) fail("Participation tools require a durable reasoning session");
  return row;
}
export function registerParticipationTools(
  registry: import("./index").ToolRegistry,
) {
  registry.register(
    "participation.people",
    async (input, _config, context) => {
      const ctx = await participationToolContext(context?.idempotencyKey);
      const b = z
        .object({
          query: z.string().max(200).default(""),
          offset: z.number().int().min(0).max(10000).default(0),
        })
        .parse(input);
      const rows = (
        await pool.query(
          "SELECT id,name,email,role,expertise,state,primary_contact,left(evidence,1000) AS evidence FROM organization_person WHERE organization_id=$1 AND state<>'archived' AND ($2='' OR name ILIKE '%'||$2||'%' OR role ILIKE '%'||$2||'%') ORDER BY primary_contact DESC,name,id LIMIT 31 OFFSET $3",
          [ctx.organization_id, b.query, b.offset],
        )
      ).rows;
      return {
        people: rows.slice(0, 30).map((p: any) => ({
          id: p.id,
          name: p.name,
          email: p.email,
          role: p.role,
          expertise: p.expertise,
          state: p.state,
          primaryContact: p.primary_contact,
          evidence: p.evidence,
        })),
        nextOffset: rows.length > 30 ? b.offset + 30 : null,
      };
    },
    { retrySafe: true },
  );
  registry.register(
    "participation.propose-person",
    async (input, _config, context) => {
      const ctx = await participationToolContext(context?.idempotencyKey),
        b = personInput.parse(input);
      const existing = (
        await pool.query(
          "SELECT id,state FROM organization_person WHERE organization_id=$1 AND email=$2",
          [ctx.organization_id, b.email],
        )
      ).rows[0];
      const p =
        existing ||
        (await savePerson(ctx.organization_id, {
          ...b,
          source: "inferred",
          primaryContact: false,
        }));
      return { personId: p.id, state: p.state };
    },
    { retrySafe: true },
  );
  registry.register(
    "participation.ask",
    async (input, _config, context) => {
      const ctx = await participationToolContext(context?.idempotencyKey),
        q = await createQuestion(ctx.organization_id, {
          ...(input as any),
          runId: ctx.run_id,
          sourceKey: "participation-tool:" + context!.idempotencyKey,
        });
      return {
        participationQuestionId: q.id,
        state: ["accepted", "rejected"].includes(q.state) ? q.state : "waiting",
        assignedPersonId: q.assigned_person_id,
        question: q.title,
        organizationId: ctx.organization_id,
      };
    },
    { retrySafe: true },
  );
  registry.register(
    "participation.answer",
    async (input, _config, context) => {
      const ctx = await participationToolContext(context?.idempotencyKey);
      const questionId = z.uuid().parse((input as any).questionId);
      const result = await reviewedParticipationResult({
        questionId,
        organizationId: ctx.organization_id,
      });
      return { state: result?.state || "waiting", result } as any;
    },
    { retrySafe: true },
  );
}

/** Fresh, bounded context is read independently of immutable tool-assignment outcomes. */
export async function readReviewedParticipantResponses(
  sessionId: string,
  runId: string,
  queryable: Pick<typeof pool, "query"> = pool,
): Promise<import("../../shared/src").Json[]> {
  z.uuid().parse(sessionId);
  z.uuid().parse(runId);
  const result = await queryable.query(
    `SELECT q.id AS "questionId",q.title,q.state,q.revision,
 a.id AS "answerId",a.person_id AS "respondentId",p.name AS "respondentName",a.question_revision AS "answeredQuestionRevision",a.submitted_at AS "submittedAt",left(a.content,3000) AS content,
 length(a.content)>3000 AS excerpt,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('label',left(e.value->>'label',200),'url',left(e.value->>'url',1000),'truncated',length(e.value->>'url')>1000)), '[]'::jsonb)
 FROM (SELECT value FROM jsonb_array_elements(coalesce(a.evidence,'[]'::jsonb)) LIMIT 2) e) AS evidence,
 jsonb_array_length(coalesce(a.evidence,'[]'::jsonb))>2 AS "evidenceExcerpt",
 v.action AS "reviewAction",left(v.comment,1500) AS "reviewComment",v.actor AS reviewer
 FROM participation_question q
 JOIN run r ON r.id=q.run_id JOIN task t ON t.id=r.task_id
 JOIN reasoning_session s ON s.id=$1 AND s.run_id=r.id
 LEFT JOIN participation_answer a ON a.id=q.latest_answer_id
 LEFT JOIN organization_person p ON p.id=a.person_id
 LEFT JOIN LATERAL (SELECT * FROM participation_review WHERE question_id=q.id AND action IN ('accept','reject') ORDER BY created_at DESC LIMIT 1) v ON true
 WHERE q.run_id=$2 AND q.organization_id=coalesce(r.customer_organization_id,t.organization_id)
 AND q.source_key LIKE $3 AND q.state IN ('accepted','rejected')
 ORDER BY q.updated_at DESC LIMIT 4`,
    [sessionId, runId, "participation-tool:" + sessionId + ":%"],
  );
  return result.rows;
}
