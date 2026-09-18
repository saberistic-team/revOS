import { createHash } from "node:crypto";

export interface BuildChatMessage {
  id: string;
  at: string | null;
  role: "assistant";
  kind: "summary" | "message";
  text: string;
}
export const BUILD_CHAT_LIMIT = 50;
const TEXT_LIMIT = 4000;
const TOTAL_BYTES = 50_000;
const TOOL_ARGUMENT_DUMP = /^\s*[\w.-]+\s*:\s*[\[{]/;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

function containsScratchpad(value: string) {
  let decoded = value.replace(controls, "");
  for (let pass = 0; pass < 3; pass++) {
    decoded = decoded.replace(/&(lt|gt|amp|quot|apos);/gi, (_, name: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[name.toLowerCase()]!)
      .replace(/&#(x[0-9a-f]+|\d+);?/gi, (full, code: string) => {
        const number = parseInt(code.startsWith("x") || code.startsWith("X") ? code.slice(1) : code, /^x/i.test(code) ? 16 : 10);
        return number <= 0x10ffff ? String.fromCodePoint(number) : full;
      }).replace(controls, "");
    if (/<\s*\/?\s*(?:think|thinking|analysis|reasoning|scratchpad|chain_of_thought|chain-of-thought)\b/i.test(decoded)) return true;
  }
  return false;
}

export function sanitizeBuildChat(value: string): { text: string; truncated: boolean } {
  // Do not try to recover prose from mixed public text and private scratchpads.
  if (containsScratchpad(value)) return { text: "", truncated: false };
  let text = value;
  // Redact before truncation, including credentials crossing the cutoff.
  for (const [name, secret] of Object.entries(process.env)) {
    if (/secret|token|password|api_?key/i.test(name) && secret && secret.length >= 8)
      text = text.split(secret).join("[redacted]");
  }
  text = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|glpat-|gitea_|forgejo_|xox[baprs]-)[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(["']?\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|secret|authorization)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(controls, "")
    .trim();
  return { text: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT };
}

const timestamp = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value + "Z");
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** Only public SDK fields: never thought, reasoning, prompt extensions or tool output. */
export function publicBuildMessages(raw: any, fallbackId = "event") {
  const messages: BuildChatMessage[] = [];
  let truncated = false;
  if (!raw || raw.source !== "agent") return { messages, truncated };
  const type = raw.kind || raw.eventType || raw.type;
  function add(value: unknown, suffix: string, kind: BuildChatMessage["kind"]) {
    if (typeof value !== "string") return;
    const safe = sanitizeBuildChat(value);
    truncated ||= safe.truncated;
    if (!safe.text || (kind === "summary" && TOOL_ARGUMENT_DUMP.test(safe.text))) return;
    const id = typeof raw.id === "string" && /^[\w-]{1,100}$/.test(raw.id)
      ? raw.id : createHash("sha256").update(fallbackId + ":" + kind + ":" + safe.text).digest("hex").slice(0, 32);
    messages.push({ id: id + ":" + suffix, at: timestamp(raw.timestamp), role: "assistant", kind, text: safe.text });
  }
  if (type === "ActionEvent") {
    // SDK fallback summaries serialize tool arguments; these are not chat.
    if (typeof raw.summary === "string" && raw.summary.length <= 600 && !TOOL_ARGUMENT_DUMP.test(raw.summary))
      add(raw.summary, "summary", "summary");
    if (raw.tool_name === "finish") add(raw.action?.message, "finish", "message");
  } else if (type === "MessageEvent" && raw.llm_message?.role === "assistant" && Array.isArray(raw.llm_message.content)) {
    add(raw.llm_message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n"), "message", "message");
  }
  return { messages, truncated };
}

/** Revalidate the separate, already projected Python progress message buffer. */
export function savedBuildMessages(raw: unknown) {
  const messages: BuildChatMessage[] = [];
  let truncated = false;
  if (!Array.isArray(raw)) return { messages, truncated };
  for (const item of raw.slice(-BUILD_CHAT_LIMIT)) {
    if (item?.role !== "assistant" || !["summary", "message"].includes(item.kind) || typeof item.text !== "string") continue;
    if (item.kind === "summary" && (item.text.length > 600 || TOOL_ARGUMENT_DUMP.test(item.text))) continue;
    const safe = sanitizeBuildChat(item.text);
    truncated ||= safe.truncated;
    if (!safe.text || (item.kind === "summary" && TOOL_ARGUMENT_DUMP.test(safe.text)) || typeof item.id !== "string" || !/^[\w:-]{1,140}$/.test(item.id)) continue;
    messages.push({ id: item.id, at: timestamp(item.at), role: "assistant", kind: item.kind, text: safe.text });
  }
  return boundedBuildMessages(messages, truncated || raw.length > BUILD_CHAT_LIMIT);
}

export function boundedBuildMessages(input: BuildChatMessage[], truncated = false) {
  const deduped = [...new Map(input.map((message) => [message.id, message])).values()]
    .sort((a, b) => (a.at || "").localeCompare(b.at || "") || a.id.localeCompare(b.id));
  const messages = deduped.slice(-BUILD_CHAT_LIMIT);
  truncated ||= deduped.length > messages.length;
  let bytes = messages.reduce((total, message) => total + Buffer.byteLength(message.text, "utf8"), 0);
  while (bytes > TOTAL_BYTES && messages.length) {
    bytes -= Buffer.byteLength(messages.shift()!.text, "utf8");
    truncated = true;
  }
  return { messages, truncated };
}
