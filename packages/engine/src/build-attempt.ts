import { z } from "zod";
export function buildAttempt(build: { result?: any }): number {
  const n = build.result?._retry?.attempt;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
export function buildJobName(id: string, attempt = 0) {
  z.uuid().parse(id);
  z.number().int().min(0).max(100000).parse(attempt);
  return `build-${id}${attempt ? `-r${attempt}` : ""}`;
}
export function buildWorkflowId(id: string, attempt = 0) {
  buildJobName(id, attempt);
  return `build:${id}${attempt ? `:retry:${attempt}` : ""}`;
}
export function acceptedBuildResume(build: { result?: any }, requestId: string): boolean {
  return build.result?._retry?.requestId === requestId ||
    (Array.isArray(build.result?._attemptHistory) && build.result._attemptHistory.some((entry: any) => entry.requestId === requestId));
}
export function resumedBuildResult(build: { state: string; result?: any; error?: string; updated_at?: unknown }, requestId: string) {
  z.uuid().parse(requestId);
  if (acceptedBuildResume(build, requestId)) return build.result;
  if (!["failed","paused"].includes(build.state)) throw Error("Only a failed or paused build can be resumed");
  const attempt = buildAttempt(build) + 1;
  z.number().max(100000).parse(attempt);
  return {
    ...build.result,
    _retry: { attempt, requestId, requestedAt: new Date().toISOString() },
    _attemptHistory: [...(Array.isArray(build.result?._attemptHistory) ? build.result._attemptHistory : []), {
      attempt: attempt - 1, requestId: build.result?._retry?.requestId ?? null,
      error: build.error ?? null, finishedAt: build.updated_at ?? null,
    }],
  };
}
