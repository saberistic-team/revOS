import { test } from "node:test";
import assert from "node:assert/strict";
import { extractResearch } from "../packages/engine/src/web-research";
test("research retains public citations and hosted actions, excluding unsafe links and private reasoning", () => {
  const a = {
    type: "url_citation",
    url: "https://example.org/evidence",
    title: "Evidence",
    start_index: 4,
    end_index: 9,
  };
  const result = extractResearch([
    {
      output: [
        { type: "reasoning", hidden: { ...a, url: "https://private.invalid" } },
        {
          type: "hosted_tool_call",
          name: "web_search_call",
          id: "search1",
          status: "completed",
          providerData: {
            action: { type: "search", query: "market evidence" },
          },
        },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Fact [1]",
              providerData: {
                annotations: [a, a, { ...a, url: "javascript:alert(1)" }],
              },
            },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(result.citations, [{ url: a.url, title: a.title }]);
  assert.equal(result.searches.length, 1);
  assert.equal(result.passages[0].annotations.length, 2);
  assert.equal(result.passages[0].text, "Fact [1]");
});
