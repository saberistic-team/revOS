import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import {
  answerInput,
  reviewInput,
  personInput,
} from "../packages/shared/src/participation";
import {
  assertAssigned,
  assertRevision,
  newToken,
  tokenHash,
  tokenMatches,
  encryptEmail,
  decryptEmail,
  isPortalPath,
} from "../packages/engine/src/participation";
import {
  registerParticipation,
  cookieValue,
} from "../apps/api/src/participation";
import * as participation from "../packages/engine/src/participation";

const personId = "00000000-0000-4000-8000-000000000001",
  org = "00000000-0000-4000-8000-000000000002",
  questionId = "00000000-0000-4000-8000-000000000003";
test("invitation tokens have 256 bits of entropy and only hashes can be compared", () => {
  const token = newToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.equal(tokenMatches(token, tokenHash(token)), true);
  assert.equal(tokenMatches(newToken(), tokenHash(token)), false);
  assert.equal(tokenMatches(token, "bad"), false);
  assert.notEqual(newToken(), token);
});
test("pending email is encrypted and tampering is detected", () => {
  const key = randomBytes(32),
    value = {
      to: "person@example.test",
      text: "https://example.test/#invite=private-token",
    };
  const encrypted = encryptEmail(value, key);
  assert(!encrypted.includes("private-token"));
  assert.deepEqual(decryptEmail(encrypted, key), value);
  assert.throws(() => decryptEmail(encrypted, randomBytes(32)));
  const parts = encrypted.split(".");
  parts[1] = randomBytes(16).toString("base64url");
  assert.throws(() => decryptEmail(parts.join("."), key));
});
test("organization, person and question revision all constrain answer writes", () => {
  const q = { organization_id: org, assigned_person_id: personId, revision: 3 };
  assert.doesNotThrow(() =>
    assertAssigned(q, { organizationId: org, personId }),
  );
  assert.throws(
    () => assertAssigned(q, { organizationId: "other", personId }),
    /not assigned/,
  );
  assert.throws(
    () => assertAssigned(q, { organizationId: org, personId: "other" }),
    /not assigned/,
  );
  assert.throws(() => assertRevision(q, 2), /changed/);
  assert.doesNotThrow(() => assertRevision(q, 3));
});
test("review and evidence require concrete valid input", () => {
  assert.throws(
    () =>
      reviewInput.parse({
        action: "clarify",
        expectedRevision: 1,
        answerId: questionId,
      }),
    /follow-up/,
  );
  assert.throws(
    () =>
      reviewInput.parse({
        action: "reassign",
        expectedRevision: 1,
        comment: "Ask finance",
      }),
    /participant/,
  );
  assert.throws(() =>
    answerInput.parse({
      content: "Answer",
      questionRevision: 1,
      evidence: [{ label: "bad", url: "javascript:alert(1)" }],
    }),
  );
  assert.equal(
    personInput.parse({ name: "Person", email: "Person@Example.test" }).email,
    "person@example.test",
  );
});
test("portal public surface does not include operator endpoints or assets", () => {
  for (const path of [
    "/customer",
    "/customer/app.js",
    "/customer/style.css",
    "/customer-api/me",
  ])
    assert(isPortalPath(path));
  for (const path of [
    "/next",
    "/next/assets/app.js",
    "/workspace/id/state",
    "/participation/id",
    "/customerish",
    "/customer/secrets",
  ])
    assert(!isPortalPath(path));
});

test("customer-only deployment denies existing and future operator routes", async () => {
  const app = Fastify();
  app.get("/workspace/leak", async () => ({
    secret: "must never be returned",
  }));
  registerParticipation(app, undefined, {
    portalOnly: true,
    background: false,
  });
  app.get("/next-api/leak", async () => ({ secret: "also private" }));
  for (const url of [
    "/workspace/leak",
    "/next-api/leak",
    "/participation/" + org,
  ]) {
    const r = await app.inject({ url });
    assert.equal(r.statusCode, 404);
    assert(!r.body.includes("secret"));
  }
  const html = await app.inject({ url: "/customer" });
  assert.equal(html.statusCode, 200);
  assert.match(
    html.headers["content-security-policy"] as string,
    /frame-ancestors 'none'/,
  );
  assert.equal(html.headers["cache-control"], "no-store");
  await app.close();
});

test("portal session is required, CSRF checked and request-supplied organization ignored", async () => {
  let call: any;
  const fake = {
    ...participation,
    customerSession: async (token: string, csrf?: string) => {
      if (token !== "valid-session")
        throw new participation.ParticipationError("Sign in", 401);
      if (csrf !== undefined && csrf !== "csrf-token")
        throw new participation.ParticipationError("CSRF", 403);
      return {
        id: "session",
        organizationId: org,
        personId,
        name: "Test",
        primaryContact: false,
        csrf: "hash",
      };
    },
    portalState: async (session: any) => ({
      organizationId: session.organizationId,
    }),
    writeAnswer: async (
      session: any,
      id: string,
      input: any,
      submit: boolean,
    ) => {
      call = { session, id, input, submit };
      return { saved: true };
    },
  } as any;
  const app = Fastify();
  registerParticipation(app, undefined, {
    service: fake,
    portalOnly: true,
    background: false,
  });
  assert.equal((await app.inject({ url: "/customer-api/me" })).statusCode, 401);
  const cookie = "revos_customer=valid-session";
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/customer-api/questions/${questionId}/answer`,
        headers: { cookie },
        payload: { content: "test" },
      })
    ).statusCode,
    403,
  );
  const r = await app.inject({
    method: "POST",
    url: `/customer-api/questions/${questionId}/answer`,
    headers: { cookie, "x-csrf-token": "csrf-token" },
    payload: {
      content: "test",
      organizationId: "attacker-org",
      personId: "someone-else",
    },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(call.session.organizationId, org);
  assert.equal(call.session.personId, personId);
  assert.equal(call.submit, true);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/customer-api/questions/${questionId}/answer`,
        headers: {
          cookie,
          "x-csrf-token": "csrf-token",
          origin: "https://attacker.test",
        },
        payload: {},
      })
    ).statusCode,
    403,
  );
  await app.close();
});

test("redeeming sets an HttpOnly session and separate CSRF cookie without returning credentials", async () => {
  const app = Fastify();
  const fake = {
    ...participation,
    redeemInvite: async () => ({
      token: "secret-token",
      csrf: "csrf-token",
      name: "Test",
    }),
  } as any;
  registerParticipation(app, undefined, {
    service: fake,
    portalOnly: true,
    background: false,
  });
  const r = await app.inject({
    method: "POST",
    url: "/customer-api/redeem",
    payload: { token: "invite" },
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { name: "Test" });
  const cookies = r.headers["set-cookie"] as unknown as string[];
  assert(
    cookies.some(
      (v) =>
        v.includes("HttpOnly") &&
        v.includes("SameSite=Strict") &&
        v.includes("Path=/customer-api"),
    ),
  );
  assert(cookies.some((v) => v.includes("revos_customer_csrf=")));
  assert.equal(
    cookieValue(
      "not_revos_customer=evil; revos_customer=correct",
      "revos_customer",
    ),
    "correct",
  );
  await app.close();
});
