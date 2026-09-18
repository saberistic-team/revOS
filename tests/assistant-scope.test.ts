import test from "node:test";
import assert from "node:assert/strict";
import {
  assistantScopeSchema,
  assertAssistantProposal,
} from "../packages/shared/src/assistant-scope";
import { withAppShell } from "../apps/api/src/app-shell";
for (const scope of ["run", "library", "knowledge"] as const) {
  test(`${scope} proposals are restricted to the section's capabilities`, () => {
    const allowed =
      scope === "run"
        ? ["run"]
        : scope === "library"
          ? ["workflow", "skill"]
          : ["knowledge", "product"];
    for (const kind of [
      "run",
      "workflow",
      "skill",
      "knowledge",
      "product",
      "arbitrary_tool",
    ]) {
      if (allowed.includes(kind))
        assert.doesNotThrow(() => assertAssistantProposal(scope, kind));
      else
        assert.throws(
          () => assertAssistantProposal(scope, kind),
          /cannot propose/,
        );
    }
  });
}
test("unknown assistant scopes are rejected", () =>
  assert.equal(assistantScopeSchema.safeParse("admin").success, false));
test("Run and Library mount independent assistants without duplicating the Knowledge assistant", () => {
  for (const scope of ["run", "library"] as const)
    assert.match(
      withAppShell("<head></head><body><!-- APP_HEADER --></body>", scope),
      new RegExp(`data-scope="${scope}"`),
    );
  assert.doesNotMatch(
    withAppShell("<head></head><body><!-- APP_HEADER --></body>", "knowledge"),
    /section-assistant.js/,
  );
});
