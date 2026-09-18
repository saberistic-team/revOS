import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Client } from "@temporalio/client";
import {
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { pool } from "../../../packages/database/src";
import * as service from "../../../packages/engine/src/participation";
import { questionInput } from "../../../packages/shared/src/participation";
export const participationTaskQueue =
  process.env.PARTICIPATION_TASK_QUEUE ||
  process.env.TEMPORAL_TASK_QUEUE ||
  "agent-engine-platform";
const uuid = z.uuid();
export function cookieValue(raw: string | undefined, name: string) {
  return (
    raw
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(name + "="))
      ?.slice(name.length + 1) || ""
  );
}
export interface ParticipationApiOptions {
  portalOnly?: boolean;
  service?: typeof service;
  background?: boolean;
}
export function registerParticipation(
  app: FastifyInstance,
  client?: Client,
  options: ParticipationApiOptions = {},
) {
  const s = options.service || service,
    portalOnly =
      options.portalOnly ?? process.env.CUSTOMER_PORTAL_ONLY === "true";
  // The separately exposed customer service must deny operator APIs, even when registered before this hook.
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (portalOnly && !s.isPortalPath(path))
      return reply.code(404).send({ error: "Not found" });
    if (path.startsWith("/customer")) {
      reply
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .header("X-Frame-Options", "DENY");
      if (req.method !== "GET" && req.headers.origin) {
        let expected: string;
        try {
          expected = new URL(
            process.env.PUBLIC_PORTAL_URL || "http://localhost:3005/customer",
          ).origin;
        } catch {
          expected = "";
        }
        const localOrigin = `${req.protocol}://${req.headers.host}`;
        if (req.headers.origin !== (portalOnly ? expected : localOrigin))
          return reply.code(403).send({ error: "Untrusted origin" });
      }
    }
  });
  const wrap =
    (fn: (r: any, reply: any) => Promise<any>) =>
    async (r: any, reply: any) => {
      try {
        return await fn(r, reply);
      } catch (e: any) {
        const duplicate = e.code === "23505";
        return reply
          .code(
            e instanceof z.ZodError
              ? 400
              : duplicate
                ? 409
                : e.statusCode || 400,
          )
          .send({
            error: duplicate
              ? "This person or record already exists"
              : e.message,
          });
      }
    };
  const auth = async (r: FastifyRequest, write = false) =>
    s.customerSession(
      cookieValue(r.headers.cookie, "revos_customer"),
      write ? String(r.headers["x-csrf-token"] || "") : undefined,
    );
  const wake = async (kind: "question" | "email", id: string) => {
    if (!client) return;
    try {
      await client.workflow.signalWithStart("ParticipationWorkflow", {
        workflowId: `participation:${kind}:${id}`,
        taskQueue: participationTaskQueue,
        args: [{ kind, id }],
        signal: "participationChanged",
        signalArgs: [],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        workflowIdReusePolicy:
          WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      });
    } catch (e) {
      app.log.warn(
        { id, kind },
        "Participation dispatch pending; record retained",
      );
    }
  };
  const org = (r: any) => uuid.parse(r.params.org),
    id = (r: any) => uuid.parse(r.params.id);
  app.get(
    "/participation/:org",
    wrap((r) => s.participationState(org(r))),
  );
  app.post(
    "/participation/:org/people",
    wrap((r) => s.savePerson(org(r), r.body)),
  );
  app.put(
    "/participation/:org/people/:id",
    wrap((r) => s.savePerson(org(r), r.body, id(r))),
  );
  app.post(
    "/participation/:org/people/:id/membership",
    wrap((r) =>
      s.setMembership(
        org(r),
        id(r),
        z
          .object({
            productId: uuid.nullable().optional(),
            campaignId: uuid.nullable().optional(),
            role: z.string().trim().min(1).max(100),
            canReview: z.boolean().default(false),
          })
          .parse(r.body),
      ),
    ),
  );
  app.post(
    "/participation/:org/people/:id/invite",
    wrap((r) => s.createInvite(org(r), id(r))),
  );
  app.post(
    "/participation/:org/people/:id/send-invite",
    wrap(async (r) => {
      const out = await s.queueInvitation(org(r), id(r));
      await wake("email", out.id);
      return out;
    }),
  );
  app.post(
    "/participation/:org/people/:id/revoke",
    wrap((r) => s.revokePersonAccess(org(r), id(r))),
  );
  app.post(
    "/participation/:org/questions",
    wrap(async (r) => {
      const q = await s.createQuestion(org(r), r.body);
      await wake("question", q.id);
      return q;
    }),
  );
  app.put(
    "/participation/:org/questions/:id",
    wrap(async (r) => {
      const b = questionInput
        .extend({ expectedRevision: z.number().int().positive() })
        .parse(r.body);
      const q = await s.editQuestion(org(r), id(r), b, b.expectedRevision);
      await wake("question", q.id);
      return q;
    }),
  );
  app.post(
    "/participation/:org/questions/:id/review",
    wrap(async (r) => {
      const q = await s.reviewAnswer(org(r), id(r), r.body);
      await wake("question", q.id);
      return q;
    }),
  );
  app.post(
    "/participation/:org/questions/:id/retry-sync",
    wrap(async (r) => {
      const state = await s.participationState(org(r));
      const q = state.questions.find((q: any) => q.id === id(r));
      if (!q || q.state !== "accepted")
        throw new service.ParticipationError(
          "Accepted question not found",
          404,
        );
      await wake("question", q.id);
      return { queued: true };
    }),
  );
  const folder = join(__dirname, "customer-portal");
  for (const [route, file, type] of [
    ["/customer", "index.html", "text/html"],
    ["/customer/", "index.html", "text/html"],
    ["/customer/app.js", "app.js", "text/javascript"],
    ["/customer/style.css", "style.css", "text/css"],
  ]) {
    const content = readFileSync(join(folder, file), "utf8");
    app.get(route, async (_, reply) =>
      reply
        .type(type)
        .header(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        )
        .send(content),
    );
  }
  const attempts = new Map<string, { count: number; until: number }>();
  app.post(
    "/customer-api/redeem",
    wrap(async (r, reply) => {
      const now = Date.now(),
        ip = r.ip;
      for (const [key, v] of attempts) if (v.until < now) attempts.delete(key);
      const rate = attempts.get(ip) || { count: 0, until: now + 60000 };
      if (++rate.count > 20)
        throw new service.ParticipationError(
          "Too many attempts. Try again in a minute.",
          429,
        );
      attempts.set(ip, rate);
      const b = z.object({ token: z.string().max(200) }).parse(r.body);
      const result = await s.redeemInvite(b.token);
      const secure = (process.env.PUBLIC_PORTAL_URL || "").startsWith("https:")
        ? "; Secure"
        : "";
      reply.header("Set-Cookie", [
        `revos_customer=${result.token}; HttpOnly; SameSite=Strict; Path=/customer-api; Max-Age=1209600${secure}`,
        `revos_customer_csrf=${result.csrf}; SameSite=Strict; Path=/; Max-Age=1209600${secure}`,
      ]);
      return { name: result.name };
    }),
  );
  app.get(
    "/customer-api/me",
    wrap(async (r) => s.portalState(await auth(r))),
  );
  app.post(
    "/customer-api/questions/:id/draft",
    wrap(async (r) => s.writeAnswer(await auth(r, true), id(r), r.body, false)),
  );
  app.post(
    "/customer-api/questions/:id/answer",
    wrap(async (r) => {
      const answer = await s.writeAnswer(
        await auth(r, true),
        id(r),
        r.body,
        true,
      );
      await wake("question", id(r));
      return answer;
    }),
  );
  app.post(
    "/customer-api/questions/:id/delegate",
    wrap(async (r) =>
      s.suggestDelegate(
        await auth(r, true),
        id(r),
        z.object({ comment: z.string().trim().min(3).max(3000) }).parse(r.body)
          .comment,
      ),
    ),
  );
  app.post(
    "/customer-api/nominate",
    wrap(async (r) => s.nominatePerson(await auth(r, true), r.body)),
  );
  app.post(
    "/customer-api/logout",
    wrap(async (r, reply) => {
      const session = await auth(r, true);
      await pool.query(
        "UPDATE participation_session SET revoked_at=now() WHERE id=$1",
        [session.id],
      );
      reply.header("Set-Cookie", [
        "revos_customer=; HttpOnly; SameSite=Strict; Path=/customer-api; Max-Age=0",
        "revos_customer_csrf=; SameSite=Strict; Path=/; Max-Age=0",
      ]);
      return { signedOut: true };
    }),
  );
  // Durable records remain discoverable if Temporal was unavailable when the API accepted the action.
  if (
    !portalOnly &&
    (options.background ??
      (process.env.PLATFORM_DISPATCH_ENABLED === "true" ||
        process.env.DISABLE_BACKGROUND_DISPATCH !== "true"))
  ) {
    let busy = false;
    const dispatch = async () => {
      if (busy) return;
      busy = true;
      try {
        const questions = (
          await pool.query(
            "SELECT id FROM participation_question WHERE state NOT IN ('accepted','rejected') OR knowledge_state IN ('pending','failed','applying') ORDER BY updated_at LIMIT 100",
          )
        ).rows;
        for (const q of questions) await wake("question", q.id);
        const outbox = (
          await pool.query(
            "SELECT id FROM participation_outbox WHERE state IN ('pending','failed') AND attempts<5 ORDER BY created_at LIMIT 30",
          )
        ).rows;
        for (const o of outbox) await wake("email", o.id);
      } catch (e) {
        app.log.warn("Participation dispatch deferred");
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void dispatch(), 30000);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }
}
