import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractArtifactFiles,
  validateArtifactFile,
} from "../packages/engine/src/artifact-generator";
import { outputSettingsSchema } from "../packages/shared/src/outputs";
test("artifact settings reject unsupported formats and preserve explicit generation mode", () => {
  assert.equal(outputSettingsSchema.parse({}).artifacts.mode, "manual");
  assert.equal(
    outputSettingsSchema.parse({
      artifacts: { mode: "model", formats: ["pdf"] },
    }).artifacts.mode,
    "model",
  );
  assert.throws(() =>
    outputSettingsSchema.parse({ artifacts: { formats: ["html"] } }),
  );
});
test("only cited downloadable files are extracted; reasoning and duplicate references are excluded", () => {
  const citation = {
    type: "container_file_citation",
    container_id: "cntr_x",
    file_id: "cfile_x",
    filename: "brief.pdf",
  };
  assert.deepEqual(
    extractArtifactFiles([
      { type: "reasoning", content: [{ ...citation, file_id: "private" }] },
      {
        type: "output_text",
        providerData: { annotations: [citation, citation] },
      },
      { url: "https://example.com/pretend.pdf" },
    ]),
    [{ containerId: "cntr_x", fileId: "cfile_x", filename: "brief.pdf" }],
  );
});
test("artifact validation rejects wrong signatures, forbidden files, and oversized outputs", () => {
  const pdf = Buffer.from("%PDF-1.4\ncontent\n%%EOF");
  assert.equal(
    validateArtifactFile("/mnt/data/report.pdf", pdf, ["pdf"]).filename,
    "report.pdf",
  );
  assert.throws(() =>
    validateArtifactFile("report.pdf", Buffer.from("<html>bad</html>"), [
      "pdf",
    ]),
  );
  assert.throws(() => validateArtifactFile("report.html", pdf, ["pdf"]));
  assert.throws(() =>
    validateArtifactFile("report.pdf", Buffer.alloc(16 * 1024 * 1024), ["pdf"]),
  );
  assert.throws(() =>
    validateArtifactFile("report.xlsx", Buffer.from("PK not a workbook"), [
      "xlsx",
    ]),
  );
});

test("artifact request identity survives reordered database JSON keys", async () => {
  const { stableOutputJson } = await import("../packages/shared/src/outputs");
  assert.equal(
    stableOutputJson({
      source: { runId: "r", turn: 0 },
      settings: { formats: ["pdf"] },
    }),
    stableOutputJson({
      settings: { formats: ["pdf"] },
      source: { turn: 0, runId: "r" },
    }),
  );
  assert.notEqual(stableOutputJson({ turn: 0 }), stableOutputJson({ turn: 1 }));
});
