import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { usageSchema } from "../../shared/src/product-platform";
import { recordUsage, type UsageInput } from "./usage-ledger";

export const usageJournalPath = () =>
  process.env.USAGE_SPOOL_DIR ||
  join(process.env.BUILD_DATA_DIR || "/build-data", "usage-spool");
type JournalOptions = {
  directory?: string;
  record?: (input: UsageInput) => Promise<unknown>;
  warn?: (message: string, details: Record<string, unknown>) => void;
};
const warnDefault = (message: string, details: Record<string, unknown>) =>
  console.warn(message, details);
const safeError = (error: unknown) => ({
  errorType: error instanceof Error ? error.name : "UsageRecordingError",
  code:
    typeof (error as any)?.code === "string" ? (error as any).code : undefined,
});

/** Write-ahead usage receipts contain counts, IDs, and attribution only. A failed ledger never reruns paid work. */
export async function recordUsageDurably(
  raw: UsageInput,
  options: JournalOptions = {},
): Promise<"recorded" | "pending" | "failed"> {
  const input = usageSchema.parse(raw),
    directory = options.directory || usageJournalPath(),
    record = options.record || recordUsage,
    warn = options.warn || warnDefault;
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        input.organizationId,
        input.provider,
        input.eventKey,
        input.attemptId,
      ]),
    )
    .digest("hex");
  const filename = join(directory, key + ".json");
  let journaled = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(filename, "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({
          version: 1,
          capturedAt: new Date().toISOString(),
          input,
        }),
      );
      await file.sync();
      journaled = true;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as any)?.code === "EEXIST") journaled = true;
    else
      warn("Usage journal unavailable", {
        ...safeError(error),
        organizationId: input.organizationId,
      });
  }
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await record(input);
      if (journaled) await unlink(filename).catch(() => {});
      return "recorded";
    } catch (error) {
      failure = error;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 30));
    }
  }
  warn(
    journaled
      ? "Usage recording deferred; receipt retained"
      : "Usage recording failed; manual reconciliation required",
    {
      ...safeError(failure),
      organizationId: input.organizationId,
      provider: input.provider,
      eventKey: input.eventKey,
    },
  );
  return journaled ? "pending" : "failed";
}

export async function replayUsageJournal(
  options: JournalOptions = {},
): Promise<{ recorded: number; pending: number }> {
  const directory = options.directory || usageJournalPath(),
    record = options.record || recordUsage,
    warn = options.warn || warnDefault;
  let files: string[];
  try {
    files = (await readdir(directory))
      .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
      .slice(0, 100);
  } catch (error) {
    if ((error as any)?.code === "ENOENT") return { recorded: 0, pending: 0 };
    throw error;
  }
  let recorded = 0,
    pending = 0;
  for (const filename of files) {
    const path = join(directory, filename);
    try {
      const receipt = JSON.parse(await readFile(path, "utf8"));
      if (receipt.version !== 1) throw Error("Unsupported usage receipt");
      const input = usageSchema.parse(receipt.input);
      await record(input);
      await unlink(path).catch(() => {});
      recorded++;
    } catch (error) {
      if ((error as any)?.code === "ENOENT") continue;
      pending++;
      warn("Usage receipt still pending", {
        receipt: filename,
        ...safeError(error),
      });
    }
  }
  return { recorded, pending };
}
let replayStarted = false;
export function startUsageJournalReplay() {
  if (replayStarted) return;
  replayStarted = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await replayUsageJournal();
    } catch (error) {
      warnDefault("Usage journal replay deferred", safeError(error));
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 60000);
  timer.unref();
  void tick();
  return () => {
    clearInterval(timer);
    replayStarted = false;
  };
}
