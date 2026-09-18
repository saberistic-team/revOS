import { Context } from "@temporalio/activity";
import { eq, and, notInArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, pool, artifactJobs, artifactFiles } from "../../../database/src";
import { loadOutputSource } from "../../../engine/src/output-source";
import {
  generateHostedArtifacts,
  downloadProviderFile,
  validateArtifactFile,
} from "../../../engine/src/artifact-generator";
import {
  outputSettingsSchema,
  type ArtifactActivities,
} from "../../../shared/src/outputs";
export function createArtifactActivities(): ArtifactActivities {
  return {
    async prepareArtifact(input) {
      const source = await loadOutputSource(input.source);
      const settings = outputSettingsSchema.parse(
        input.settings ?? source.settings,
      );
      if (
        !settings.artifacts.formats.length ||
        (!input.manual && settings.artifacts.mode === "manual")
      )
        return null;
      const sourceHash = createHash("sha256")
        .update(JSON.stringify(source.output))
        .digest("hex");
      const sourceKey = createHash("sha256")
        .update(JSON.stringify({ source: input.source, sourceHash, settings }))
        .digest("hex");
      await db
        .insert(artifactJobs)
        .values({
          sourceKey,
          runId: input.source.runId,
          workflowStepId: input.source.workflowStepId,
          sessionId: input.source.sessionId,
          turn: input.source.turn,
          skillVersionId: source.skillVersionId,
          title: source.title,
          sourceHash,
          sourceOutput: source.output,
          settings,
        })
        .onConflictDoNothing();
      const [job] = await db
        .select()
        .from(artifactJobs)
        .where(eq(artifactJobs.sourceKey, sourceKey));
      return job.id;
    },
    async generateArtifact(jobId) {
      const lock = await pool.connect();
      let locked = false;
      const ctx = Context.current();
      const heartbeat = setInterval(() => ctx.heartbeat({ jobId }), 10000);
      const signal = AbortSignal.any([
        ctx.cancellationSignal,
        AbortSignal.timeout(8 * 60 * 1000),
      ]);
      try {
        locked = (
          await lock.query(
            "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
            [jobId],
          )
        ).rows[0].locked;
        if (!locked)
          throw new Error("Artifact is already being generated; retry later");
        let [job] = await db
          .select()
          .from(artifactJobs)
          .where(eq(artifactJobs.id, jobId));
        if (!job) throw new Error("Artifact job missing");
        if (["completed", "skipped"].includes(job.state)) return;
        await db
          .update(artifactJobs)
          .set({ state: "running", error: null, updatedAt: new Date() })
          .where(eq(artifactJobs.id, jobId));
        // Reuse persisted provider references after a download failure, until the container expires.
        let refs = job.providerFiles;
        if (!refs || Date.now() - job.updatedAt.getTime() > 18 * 60 * 1000) {
          const result = await generateHostedArtifacts(
            job.title,
            job.sourceOutput,
            job.settings,
            signal,
          );
          refs = result.files;
          await db
            .update(artifactJobs)
            .set({
              providerFiles: refs,
              summary: result.summary,
              updatedAt: new Date(),
            })
            .where(eq(artifactJobs.id, jobId));
          if (!refs.length) {
            await db
              .update(artifactJobs)
              .set({ state: "skipped" })
              .where(eq(artifactJobs.id, jobId));
            return;
          }
        }
        if (refs.length > 4)
          throw new Error("Model produced too many final artifacts");
        const files: (typeof artifactFiles.$inferInsert)[] = [];
        let total = 0;
        for (const ref of refs) {
          const bytes = await downloadProviderFile(ref, signal);
          total += bytes.length;
          if (total > 30 * 1024 * 1024)
            throw new Error("Artifact batch exceeds 30 MB");
          const metadata = validateArtifactFile(
            ref.filename,
            bytes,
            job.settings.artifacts.formats,
          );
          files.push({
            jobId,
            ...metadata,
            byteSize: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            contentBase64: bytes.toString("base64"),
          });
        }
        if (
          job.settings.artifacts.mode !== "model" &&
          job.settings.artifacts.formats.some(
            (f) =>
              !files.some((file) =>
                file.filename.toLowerCase().endsWith("." + f),
              ),
          )
        )
          throw new Error(
            "Some requested artifact formats are missing. Received: " +
              files.map((f) => f.filename).join(", "),
          );
        await db.transaction(async (tx) => {
          await tx.delete(artifactFiles).where(eq(artifactFiles.jobId, jobId));
          await tx.insert(artifactFiles).values(files);
          await tx
            .update(artifactJobs)
            .set({ state: "completed", error: null, updatedAt: new Date() })
            .where(eq(artifactJobs.id, jobId));
        });
      } catch (e) {
        if (locked)
          await db
            .update(artifactJobs)
            .set({
              error: String(e),
              updatedAt: new Date(),
              ...(String(e).includes("Artifact download failed (404)") ||
              String(e).includes("formats are missing")
                ? { providerFiles: null }
                : {}),
            })
            .where(eq(artifactJobs.id, jobId));
        throw e;
      } finally {
        clearInterval(heartbeat);
        if (locked)
          await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [jobId]);
        lock.release();
      }
    },
    async failArtifact({ jobId, error }) {
      const lock = await pool.connect();
      let acquired = false;
      try {
        acquired = (
          await lock.query(
            "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
            [jobId],
          )
        ).rows[0].locked;
        // Another workflow may still be generating this same cached output.
        if (!acquired)
          throw new Error(
            "Artifact generator still holds the job lock; retry status update",
          );
        await db
          .update(artifactJobs)
          .set({ state: "failed", error, updatedAt: new Date() })
          .where(
            and(
              eq(artifactJobs.id, jobId),
              notInArray(artifactJobs.state, ["completed", "skipped"]),
            ),
          );
      } finally {
        if (acquired)
          await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [jobId]);
        lock.release();
      }
    },
  };
}
