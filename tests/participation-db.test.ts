import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:net";

// Runs entirely in an isolated temporary schema, including invitation mail to an in-process local SMTP inbox.
// TEST_PARTICIPATION_DATABASE_URL must point at a PostgreSQL database where a temporary schema is permitted.
test(
  "participation database lifecycle, tenant isolation, replay protection and durable email",
  { skip: !process.env.TEST_PARTICIPATION_DATABASE_URL },
  async (t) => {
    const url = process.env.TEST_PARTICIPATION_DATABASE_URL!,
      admin = new Pool({ connectionString: url }),
      schema = "participation_test_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const configured = new URL(url);
    configured.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = configured.toString();
    process.env.PARTICIPATION_TOKEN_KEY = randomBytes(32).toString("base64");
    process.env.MAIL_DELIVERY_MODE = "local";
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.PUBLIC_PORTAL_URL = "http://localhost:3005/customer";
    const { pool } = await import("../packages/database/src");
    const s = await import("../packages/engine/src/participation");
    try {
      await pool.query(
        "CREATE TABLE organization(id uuid PRIMARY KEY,name text); CREATE TABLE task(id uuid PRIMARY KEY,organization_id uuid); CREATE TABLE run(id uuid PRIMARY KEY,task_id uuid REFERENCES task(id),customer_organization_id uuid); CREATE TABLE reasoning_session(id uuid PRIMARY KEY,run_id uuid REFERENCES run(id)); CREATE TABLE platform_product(id uuid PRIMARY KEY, organization_id uuid, name text); CREATE TABLE platform_campaign(id uuid PRIMARY KEY, organization_id uuid, name text, product_id uuid)",
      );
      await pool.query(
        readFileSync(
          new URL(
            "../packages/database/migrations/0010_people_onboarding.sql",
            `file://${__filename}`,
          ),
          "utf8",
        ),
      );
      const org = randomUUID(),
        other = randomUUID();
      await pool.query("INSERT INTO organization VALUES($1,$2),($3,$4)", [
        org,
        "Test organization",
        other,
        "Other organization",
      ]);
      const poc = await s.savePerson(org, {
        name: "Primary Contact",
        email: "primary@example.test",
        primaryContact: true,
      });
      const person = await s.savePerson(org, {
        name: "Finance Person",
        email: "finance@example.test",
        role: "Finance",
      });
      const outsider = await s.savePerson(other, {
        name: "Outsider",
        email: "outsider@example.test",
      });
      const q = await s.createQuestion(org, {
        title: "What is the budget?",
        assignedPersonId: person.id,
        priority: "high",
      });
      let session: any;
      await t.test(
        "one-use invitations and hashed expiring sessions",
        async () => {
          const invite = await s.createInvite(org, person.id);
          const token = new URLSearchParams(
            new URL(invite.url).hash.slice(1),
          ).get("invite")!;
          const stored = (
            await pool.query("SELECT * FROM participation_invite WHERE id=$1", [
              invite.id,
            ])
          ).rows[0];
          assert.equal(stored.token_hash, s.tokenHash(token));
          assert(!JSON.stringify(stored).includes(token));
          const redeemed = await s.redeemInvite(token);
          session = await s.customerSession(redeemed.token, redeemed.csrf);
          await assert.rejects(s.redeemInvite(token), /already used/);
          await assert.rejects(
            s.customerSession(redeemed.token, "wrong-csrf"),
            /Refresh/,
          );
          await pool.query(
            "UPDATE participation_session SET expires_at=now()-interval '1 second' WHERE id=$1",
            [session.id],
          );
          await assert.rejects(s.customerSession(redeemed.token), /expired/);
          await pool.query(
            "UPDATE participation_session SET expires_at=now()+interval '1 day' WHERE id=$1",
            [session.id],
          );
        },
      );
      await t.test(
        "cross-organization creation and forged assignment fail",
        async () => {
          await assert.rejects(
            s.createQuestion(org, {
              title: "Invalid",
              assignedPersonId: outsider.id,
            }),
            /unavailable/,
          );
          await assert.rejects(
            s.writeAnswer({ ...session, organizationId: other }, q.id, {
              content: "Forged",
              questionRevision: 1,
            }),
            /not found/,
          );
          await assert.rejects(
            s.writeAnswer({ ...session, personId: poc.id }, q.id, {
              content: "Forged",
              questionRevision: 1,
            }),
            /not assigned/,
          );
        },
      );
      await t.test(
        "question product and campaign links are scoped and consistent",
        async () => {
          const productA = randomUUID(),
            productB = randomUUID(),
            foreignProduct = randomUUID(),
            campaign = randomUUID(),
            foreignCampaign = randomUUID();
          await pool.query(
            "INSERT INTO platform_product(id,organization_id,name) VALUES($1,$2,'Customer portal'),($3,$2,'Analytics'),($4,$5,'Private product')",
            [productA, org, productB, foreignProduct, other],
          );
          await pool.query(
            "INSERT INTO platform_campaign(id,organization_id,name,product_id) VALUES($1,$2,'Launch campaign',$3),($4,$5,'Other campaign',$6)",
            [campaign, org, productA, foreignCampaign, other, foreignProduct],
          );
          const linked = await s.createQuestion(org, {
            title: "Confirm the launch scope",
            assignedPersonId: person.id,
            campaignId: campaign,
          });
          assert.equal(linked.product_id, productA);
          assert.equal(linked.campaign_id, campaign);
          await assert.rejects(
            s.createQuestion(org, {
              title: "Mismatch",
              assignedPersonId: person.id,
              campaignId: campaign,
              productId: productB,
            }),
            /different product/,
          );
          await assert.rejects(
            s.createQuestion(org, {
              title: "Foreign product",
              assignedPersonId: person.id,
              productId: foreignProduct,
            }),
            /another organization/,
          );
          await assert.rejects(
            s.createQuestion(org, {
              title: "Foreign campaign",
              assignedPersonId: person.id,
              campaignId: foreignCampaign,
            }),
            /another organization/,
          );
          await assert.rejects(
            s.editQuestion(
              org,
              linked.id,
              {
                title: "Mismatch edit",
                assignedPersonId: person.id,
                campaignId: campaign,
                productId: productB,
              },
              1,
            ),
            /different product/,
          );
          const state = await s.participationState(org);
          assert.equal(state.products.length, 2);
          assert.equal(state.campaigns.length, 1);
          assert(!state.products.some((p: any) => p.id === foreignProduct));
          assert(!state.campaigns.some((c: any) => c.id === foreignCampaign));
          const q = state.questions.find((q: any) => q.id === linked.id);
          assert.equal(q.product_name, "Customer portal");
          assert.equal(q.campaign_name, "Launch campaign");
        },
      );
      await t.test(
        "draft, review clarification and immutable answer revisions",
        async () => {
          await s.writeAnswer(session, q.id, {
            content: "Draft answer",
            questionRevision: 1,
          });
          let state = await s.portalState(session);
          assert.equal(
            state.questions.find((item: any) => item.id === q.id)
              ?.draft_content,
            "Draft answer",
          );
          const first: any = await s.writeAnswer(
            session,
            q.id,
            { content: "Budget is not finalized", questionRevision: 1 },
            true,
          );
          await assert.rejects(
            s.writeAnswer(
              session,
              q.id,
              { content: "Duplicate", questionRevision: 1 },
              true,
            ),
            /awaiting review/,
          );
          await assert.rejects(
            pool.query(
              "UPDATE participation_answer SET content=$2 WHERE id=$1",
              [first.id, "tampered"],
            ),
            /immutable/,
          );
          const clarified = await s.reviewAnswer(org, q.id, {
            action: "clarify",
            answerId: first.id,
            expectedRevision: 1,
            comment: "Please provide a range",
            reviewer: "Reviewer",
          });
          assert.equal(clarified.revision, 2);
          await assert.rejects(
            s.writeAnswer(
              session,
              q.id,
              { content: "Old page", questionRevision: 1 },
              true,
            ),
            /changed/,
          );
          const second: any = await s.writeAnswer(
            session,
            q.id,
            { content: "The approved range is 10–20k", questionRevision: 2 },
            true,
          );
          await assert.rejects(
            s.reviewAnswer(org, q.id, {
              action: "accept",
              answerId: first.id,
              expectedRevision: 2,
            }),
            /no longer/,
          );
          await s.reviewAnswer(org, q.id, {
            action: "accept",
            answerId: second.id,
            expectedRevision: 2,
            reviewer: "Reviewer",
          });
          const reviewed = await s.reviewedParticipationResult({
            organizationId: org,
            questionId: q.id,
          });
          assert.equal(reviewed?.answer?.id, second.id);
          assert.equal(reviewed?.answer?.personId, person.id);
          assert.equal(reviewed?.state, "accepted");
          assert.equal(reviewed?.questionRevision, 3);
          state = await s.portalState(session);
          assert.equal(state.answers.length, 2);
          assert.equal(
            state.questions.find((item: any) => item.id === q.id)
              ?.draft_content,
            null,
          );
          await assert.rejects(
            s.writeAnswer(
              session,
              q.id,
              { content: "Tamper accepted", questionRevision: 3 },
              true,
            ),
            /accepted/,
          );
        },
      );
      await t.test(
        "handoff gives only explicitly assigned question context to primary contact",
        async () => {
          const privateQ = await s.createQuestion(org, {
            title: "Separate private question",
            assignedPersonId: person.id,
          });
          const handoff = await s.createQuestion(org, {
            title: "Please decide",
            assignedPersonId: person.id,
          });
          const answer: any = await s.writeAnswer(
            session,
            handoff.id,
            { content: "Finance recommends option A", questionRevision: 1 },
            true,
          );
          await s.reviewAnswer(org, handoff.id, {
            action: "handoff",
            expectedRevision: 1,
            answerId: answer.id,
            comment: "Please confirm the finance recommendation",
          });
          const pocSession = {
            ...session,
            personId: poc.id,
            primaryContact: true,
            name: poc.name,
          };
          const visible = await s.portalState(pocSession);
          assert(visible.questions.some((v: any) => v.id === handoff.id));
          assert(!visible.questions.some((v: any) => v.id === privateQ.id));
          assert(visible.answers.some((v: any) => v.id === answer.id));
          assert(visible.onboarding);
          await assert.rejects(
            s.writeAnswer(
              session,
              handoff.id,
              { content: "No longer mine", questionRevision: 2 },
              true,
            ),
            /not assigned/,
          );
        },
      );
      await t.test(
        "assistant proposals create scoped people and questions idempotently",
        async () => {
          const proposal =
            await import("../packages/engine/src/collaboration-proposals");
          const id = randomUUID(),
            changeId = randomUUID();
          const raw = {
            name: "Suggested Contact",
            email: "suggested@example.test",
            role: "Operations",
            source: "operator",
            primaryContact: true,
          };
          const first = await proposal.applyCollaborationProposal(
            org,
            "participant",
            raw,
            id,
            changeId,
          );
          const replay = await proposal.applyCollaborationProposal(
            org,
            "participant",
            raw,
            id,
            changeId,
          );
          assert.equal(first.id, id);
          assert.equal(replay.id, id);
          assert.equal(first.source, "inferred");
          assert.equal(first.state, "proposed");
          assert.equal(first.primary_contact, false);
          await assert.rejects(
            proposal.applyCollaborationProposal(
              other,
              "participant",
              { ...raw, email: "other@example.test" },
              id,
              randomUUID(),
            ),
            /another organization/,
          );
          const questionChange = randomUUID(),
            questionBody = {
              title: "Confirm the operating hours",
              assignedPersonId: person.id,
            };
          const one = await proposal.applyCollaborationProposal(
            org,
            "participant_question",
            questionBody,
            randomUUID(),
            questionChange,
          );
          const two = await proposal.applyCollaborationProposal(
            org,
            "participant_question",
            questionBody,
            randomUUID(),
            questionChange,
          );
          assert.equal(one.id, two.id);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM participation_question WHERE source_key=$1",
                ["proposal:" + questionChange],
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            proposal.applyCollaborationProposal(
              other,
              "participant_question",
              questionBody,
              randomUUID(),
              randomUUID(),
            ),
            /outside this organization/,
          );
        },
      );
      await t.test(
        "model assignments retry safely and fresh reasoning sees only reviewed scoped answers",
        async () => {
          const taskId = randomUUID(),
            runId = randomUUID(),
            sessionId = randomUUID();
          await pool.query("INSERT INTO task VALUES($1,$2)", [taskId, org]);
          await pool.query("INSERT INTO run VALUES($1,$2,$3)", [
            runId,
            taskId,
            org,
          ]);
          await pool.query("INSERT INTO reasoning_session VALUES($1,$2)", [
            sessionId,
            runId,
          ]);
          const handlers = new Map<string, any>();
          s.registerParticipationTools({
            register: (name: string, fn: any) => handlers.set(name, fn),
          } as any);
          const ask = handlers.get("participation.ask"),
            input = {
              title: "Describe the decision",
              detail: "Testing durable questions",
              why: "To proceed",
              priority: "high",
              assignedPersonId: person.id,
            };
          const assigned = await ask(
              input,
              {},
              { idempotencyKey: sessionId + ":0" },
            ),
            again = await ask(input, {}, { idempotencyKey: sessionId + ":0" });
          assert.equal(
            assigned.participationQuestionId,
            again.participationQuestionId,
          );
          assert.equal(assigned.state, "waiting");
          const questionId = assigned.participationQuestionId;
          assert.equal(
            await s.reviewedParticipationResult({
              questionId,
              organizationId: org,
            }),
            null,
          );
          const evidence = Array.from({ length: 20 }, (_, i) => ({
            label: "evidence " + i,
            url: "https://example.test/" + "x".repeat(1800) + i,
          }));
          const answer: any = await s.writeAnswer(
            session,
            questionId,
            { content: "A".repeat(45000), questionRevision: 1, evidence },
            true,
          );
          assert.equal(
            await s.reviewedParticipationResult({
              questionId,
              organizationId: org,
            }),
            null,
          );
          assert.deepEqual(
            await s.readReviewedParticipantResponses(sessionId, runId),
            [],
          );
          await s.reviewAnswer(org, questionId, {
            action: "accept",
            answerId: answer.id,
            expectedRevision: 1,
            reviewer: "Named reviewer",
          });
          const context: any[] = await s.readReviewedParticipantResponses(
            sessionId,
            runId,
          );
          assert.equal(context.length, 1);
          assert.equal(context[0].respondentId, person.id);
          assert.equal(context[0].answeredQuestionRevision, 1);
          assert.equal(context[0].reviewer, "Named reviewer");
          assert.equal(context[0].state, "accepted");
          assert.equal(context[0].content.length, 3000);
          assert.equal(context[0].excerpt, true);
          assert.equal(context[0].evidence.length, 2);
          assert.equal(context[0].evidenceExcerpt, true);
          assert.equal(context[0].evidence[0].truncated, true);
          assert(JSON.stringify(context).length < 8000);
          assert.deepEqual(
            await s.readReviewedParticipantResponses(randomUUID(), runId),
            [],
          );
          const rejected = await ask(
            { ...input, title: "A question that cannot proceed" },
            {},
            { idempotencyKey: sessionId + ":1" },
          );
          await s.reviewAnswer(org, rejected.participationQuestionId, {
            action: "reject",
            expectedRevision: 1,
            comment:
              "The customer cannot disclose this; proceed with an explicit assumption",
            reviewer: "Named reviewer",
          });
          const updated: any[] = await s.readReviewedParticipantResponses(
            sessionId,
            runId,
          );
          assert.equal(updated[0].state, "rejected");
          assert.match(updated[0].reviewComment, /cannot disclose/);
          assert.equal(updated[0].answerId, null);
          await assert.rejects(
            ask(
              { ...input, assignedPersonId: outsider.id },
              {},
              { idempotencyKey: sessionId + ":2" },
            ),
            /unavailable/,
          );
        },
      );
      await t.test(
        "revocation invalidates session and pending invitations",
        async () => {
          const invite = await s.createInvite(org, person.id);
          await s.revokePersonAccess(org, person.id);
          await assert.rejects(
            s.redeemInvite(
              new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
                "invite",
              )!,
            ),
            /invalid/,
          );
          assert(
            (
              await pool.query(
                "SELECT revoked_at FROM participation_session WHERE id=$1",
                [session.id],
              )
            ).rows[0].revoked_at,
          );
        },
      );
      await t.test(
        "local mail outbox encrypts link, delivers once and clears secret payload",
        async () => {
          const messages: string[] = [];
          const server = createServer((socket) => {
            socket.write("220 local test SMTP\r\n");
            let buffer = "",
              inData = false,
              body = "";
            socket.on("data", (chunk) => {
              buffer += chunk;
              while (buffer.includes("\r\n")) {
                const at = buffer.indexOf("\r\n"),
                  line = buffer.slice(0, at);
                buffer = buffer.slice(at + 2);
                if (inData) {
                  if (line === ".") {
                    messages.push(body);
                    body = "";
                    inData = false;
                    socket.write("250 queued\r\n");
                  } else body += line + "\n";
                } else if (line.startsWith("EHLO"))
                  socket.write("250 local\r\n");
                else if (
                  line.startsWith("MAIL FROM") ||
                  line.startsWith("RCPT TO")
                )
                  socket.write("250 ok\r\n");
                else if (line === "DATA") {
                  inData = true;
                  socket.write("354 continue\r\n");
                } else if (line === "QUIT") {
                  socket.write("221 bye\r\n");
                  socket.end();
                }
              }
            });
          });
          await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
          );
          process.env.SMTP_PORT = String((server.address() as any).port);
          try {
            const queued = await s.queueInvitation(org, person.id);
            const before = (
              await pool.query(
                "SELECT * FROM participation_outbox WHERE id=$1",
                [queued.id],
              )
            ).rows[0];
            assert.equal(before.state, "pending");
            assert(!before.payload_ciphertext.includes("#invite="));
            const email = s.decryptEmail(before.payload_ciphertext);
            assert.match(email.text, /#invite=/);
            await s.deliverOutbox(queued.id);
            await s.deliverOutbox(queued.id);
            assert.equal(messages.length, 1);
            assert.match(messages[0], /To: finance@example.test/);
            const sent = (
              await pool.query(
                "SELECT * FROM participation_outbox WHERE id=$1",
                [queued.id],
              )
            ).rows[0];
            assert.equal(sent.state, "sent");
            assert.equal(sent.payload_ciphertext, "");
            assert.equal(sent.attempts, 1);
          } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        },
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
