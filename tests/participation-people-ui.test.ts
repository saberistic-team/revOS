import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(
  resolve(__dirname, "../apps/api/src/next/people.js"),
  "utf8",
);
const box: any = {};
vm.runInNewContext(
  source.replace(/^import[^\n]+\n/, "").replace(/^export /gm, ""),
  box,
);
const links = (campaignId: string, productId: string) =>
  JSON.parse(
    JSON.stringify(
      box.questionLinks(
        [{ id: "portal" }, { id: "analytics" }],
        [
          { id: "launch", product_id: "portal" },
          { id: "discovery", product_id: null },
        ],
        campaignId,
        productId,
      ),
    ),
  );

test("a campaign-bound assignment uses and locks the campaign product", () => {
  assert.deepEqual(links("launch", "analytics"), {
    campaignId: "launch",
    productId: "portal",
    productLocked: true,
  });
});

test("clearing a campaign or choosing one without a product permits a product choice", () => {
  assert.deepEqual(links("", "portal"), {
    campaignId: null,
    productId: "portal",
    productLocked: false,
  });
  assert.deepEqual(links("discovery", "analytics"), {
    campaignId: "discovery",
    productId: "analytics",
    productLocked: false,
  });
});

test("only organization catalog choices become links; organization-wide questions remain valid", () => {
  assert.deepEqual(links("foreign-campaign", "foreign-product"), {
    campaignId: null,
    productId: null,
    productLocked: false,
  });
  assert.deepEqual(links("", ""), {
    campaignId: null,
    productId: null,
    productLocked: false,
  });
});
