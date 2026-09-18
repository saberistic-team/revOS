import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { boundedBuildMessages, publicBuildMessages, savedBuildMessages, type BuildChatMessage } from "./build-chat";

export interface BuildActivity {
  id: string;
  at: string | null;
  kind: string;
  message: string;
}
export interface BuildProgress {
  phase: string;
  message: string;
  updatedAt: string | null;
  lastEventAt: string | null;
  events: BuildActivity[];
  messages: BuildChatMessage[];
  messagesTruncated: boolean;
  files: { path: string; size: number }[];
  maxIterations?: number;
}

const iso = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value + "Z");
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function publicBuildPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const relative = value.replace(/^\/workspace\/site\//, "").replace(/^\.\//, "");
  if (!relative || relative.length > 240 || !/^[a-zA-Z0-9_./ -]+$/.test(relative)) return null;
  if (/(?:secret|credential|password|token|private[_-]?key|api[_-]?key|sk-[a-z0-9])/i.test(relative)) return null;
  if (relative.split("/").some((p) => !p || p.startsWith(".") || ["node_modules", "__pycache__"].includes(p))) return null;
  return relative;
}

// Whitelist metadata only. SDK events can contain hidden reasoning, prompts,
// credentials in commands, and raw outputs; none are copied to the response.
export function publicBuildActivity(raw: any, fallbackId: string): BuildActivity | null {
  if (!raw || typeof raw !== "object") return null;
  const type = raw.eventType || raw.kind || raw.type;
  const tool = raw.tool_name || raw.toolName;
  let message: string;
  let kind = "activity";
  if (type === "ActionEvent" || type === "action") {
    if (tool === "file_editor" || tool === "FileEditorTool") {
      const file = publicBuildPath(raw.action?.path ?? raw.filePath);
      const operation = raw.action?.command ?? raw.commandKind;
      const verb = operation === "view" ? "Reading" : operation === "create" ? "Creating" : "Editing";
      message = `${verb} ${file || "a project file"}`;
    } else if (tool === "terminal" || tool === "TerminalTool") message = "Running a command in the build workspace";
    else if (tool === "finish" || tool === "FinishTool") message = "Finishing the coding work";
    else message = "Using a build tool";
  } else if (type === "ObservationEvent" || type === "observation") {
    const code = raw.observation?.exit_code ?? raw.observation?.metadata?.exit_code ?? raw.exitCode;
    const failed = raw.observation?.is_error === true || raw.isError === true || (typeof code === "number" && Number.isInteger(code) && code !== 0 && code !== -1);
    kind = failed ? "warning" : "activity";
    message = failed ? "A build tool reported an error"
      : code === -1 ? "A build command is still running"
      : tool === "file_editor" || tool === "FileEditorTool" ? "File operation completed"
      : tool === "terminal" || tool === "TerminalTool" ? "Build command completed" : "Build tool returned a result";
  } else if (type === "ConversationErrorEvent") {
    kind = "error";
    message = raw.code === "MaxIterationsReached" ? "OpenHands reached its coding-turn limit before finishing"
      : raw.code === "MaxBudgetReached" ? "OpenHands reached its configured budget before finishing"
      : "The OpenHands coding session stopped with an error";
  } else if (["AgentErrorEvent", "AgentErrorObservation", "ToolErrorEvent", "error"].includes(type)) {
    kind = "warning";
    message = "An agent action reported an error";
  } else if (type === "SystemPromptEvent") message = "Coding session initialized";
  else if (type === "MessageEvent") message = "Coding session received a message";
  else return null;
  return {
    id: typeof raw.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(raw.id) ? raw.id : fallbackId,
    at: iso(raw.timestamp ?? raw.at), kind, message,
  };
}

async function safeStat(base: string, relative: string) {
  let current = base;
  if ((await lstat(base)).isSymbolicLink()) throw Error("Invalid build directory");
  for (const part of relative.split("/")) {
    if (!part || part === "..") throw Error("Invalid progress path");
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw Error("Invalid progress link");
  }
  return lstat(current);
}

async function jsonFile(base: string, relative: string) {
  try {
    const stat = await safeStat(base, relative);
    if (!stat.isFile() || stat.size > 512_000) return null;
    return { value: JSON.parse(await readFile(path.join(base, relative), "utf8")), at: stat.mtime.toISOString() };
  } catch { return null; }
}

// Cache only the public projection, never raw SDK reasoning or tool payloads.
const eventCache = new Map<string, { signature: string; activity: BuildActivity | null; messages: BuildChatMessage[]; truncated: boolean }>();
async function publicEventFile(base: string, relative: string, fallbackId: string) {
  try {
    const stat = await safeStat(base, relative);
    if (!stat.isFile() || stat.size > 512_000) return null;
    const key = path.join(base, relative), signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = eventCache.get(key);
    if (cached?.signature === signature) return cached;
    const raw = JSON.parse(await readFile(key, "utf8"));
    const activity = publicBuildActivity(raw, fallbackId);
    const chat = publicBuildMessages(raw, fallbackId);
    const value = { signature, activity: activity ? { ...activity, at: activity.at || stat.mtime.toISOString() } : null, ...chat };
    eventCache.delete(key);
    eventCache.set(key, value);
    while (eventCache.size > 1000) eventCache.delete(eventCache.keys().next().value!);
    return value;
  } catch { return null; }
}

export async function readBuildProgress(
  build: { id: string; state: string; result?: any },
  dataRoot = process.env.BUILD_DATA_DIR || "/build-data",
): Promise<BuildProgress> {
  const base = path.join(dataRoot, "jobs", z.uuid().parse(build.id));
  const [saved, result] = await Promise.all([jsonFile(base, "progress.json"), jsonFile(base, "result.json")]);
  const events: BuildActivity[] = [];
  const savedChat = savedBuildMessages(saved?.value.messages);
  const messages = [...savedChat.messages];
  let messagesTruncated = savedChat.truncated || saved?.value.messagesTruncated === true;
  // Read persisted SDK metadata too: builds already running use the old image,
  // whose progress file contains only event class names and no timestamps.
  for (const conversationId of [build.id.replaceAll("-", ""), build.id]) {
    const relative = `conversation/${conversationId}/events`;
    try {
      if (!(await safeStat(base, relative)).isDirectory()) continue;
      const allNames = (await readdir(path.join(base, relative)))
        .filter((name) => /^event-\d+-[a-zA-Z0-9-]+\.json$/.test(name)).sort();
      const names = allNames.slice(-200);
      messagesTruncated ||= allNames.length > names.length;
      const items = await Promise.all(names.map((name) => publicEventFile(base, `${relative}/${name}`, name)));
      items.forEach((item) => {
        if (item?.activity) events.push(item.activity);
        if (item) { messages.push(...item.messages); messagesTruncated ||= item.truncated; }
      });
      if (events.length) break;
    } catch { /* Progress is best effort and must not break the run inspector. */ }
  }
  const chat = boundedBuildMessages(messages, messagesTruncated);
  if (events.length > 40) events.splice(0, events.length - 40);
  if (!events.length && Array.isArray(saved?.value.events)) {
    saved.value.events.slice(-40).forEach((event: unknown, index: number) => {
      const activity = publicBuildActivity(event, `legacy-${index}`);
      if (activity) events.push(activity);
    });
  }
  const files: BuildProgress["files"] = [];
  async function scan(relative: string, depth = 0): Promise<void> {
    if (depth > 5 || files.length >= 100) return;
    try {
      if (!(await safeStat(base, relative)).isDirectory()) return;
      for (const entry of (await readdir(path.join(base, relative))).sort().slice(0, 150)) {
        if (files.length >= 100 || !publicBuildPath(entry)) continue;
        const target = `${relative}/${entry}`;
        try {
          const stat = await safeStat(base, target);
          if (stat.isDirectory()) await scan(target, depth + 1);
          else if (stat.isFile()) files.push({ path: target.slice(5), size: stat.size });
        } catch { /* A file can be renamed while OpenHands is working. */ }
      }
    } catch { /* The coding environment may not have started yet. */ }
  }
  await scan("site");
  const lastEventAt = events.at(-1)?.at || iso(saved?.value.lastEventAt) || saved?.at || null;
  let phase = ["starting", "building", "validating", "checkpoint", "paused"].includes(saved?.value.phase) ? saved!.value.phase : events.length ? "building" : "starting";
  let message = phase === "validating" ? "Checking the generated files" : phase === "starting" ? "Waiting for the coding environment to report activity" : events.at(-1)?.message || "OpenHands is building the site";
  if (build.state === "pending") { phase = "queued"; message = "Waiting for a build worker"; }
  else if (build.state === "failed") { phase = "failed"; message = [...events].reverse().find((e) => e.kind === "error")?.message || "The build stopped before completion"; }
  else if (build.state === "paused" || result?.value.state === "paused") { phase = "paused"; message = "Progress is saved. Review the budget or remaining work before continuing."; }
  else if (build.state === "completed") { phase = "completed"; message = build.result?.previewUrl ? "Build completed and preview is available" : "Build completed and source saved to Forgejo"; }
  else if (result?.value.state === "failed") { phase = "failed"; message = "The coding process stopped; the engine is collecting its result"; }
  else if (result?.value.state === "completed") { phase = "publishing"; message = "Coding finished; saving and verifying the source in Forgejo"; }
  const maxIterations = saved?.value.maxIterations ?? result?.value.maxIterations;
  return { phase, message, updatedAt: iso(saved?.value.updatedAt) || saved?.at || lastEventAt, lastEventAt, events, files,
    messages: chat.messages, messagesTruncated: chat.truncated,
    ...(Number.isSafeInteger(maxIterations) && maxIterations > 0 && maxIterations <= 1000 ? { maxIterations } : {}) };
}
