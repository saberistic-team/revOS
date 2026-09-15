import type { Json, StepContext } from "./index";
// A deliberately small, explicit binding language: whole JSON values, no eval.
export function bindInput(
  configuration: Record<string, Json>,
  context: StepContext,
): Json {
  const source = configuration.inputFrom ?? "previous";
  if (source === "initial") return context.initial;
  if (source === "previous") return context.previous;
  if (source === "context") return context as unknown as Json;
  if (typeof source === "string" && source.startsWith("steps.")) {
    const key = source.slice(6);
    if (!Object.hasOwn(context.steps, key))
      throw new Error(`Unknown step binding: ${key}`);
    return context.steps[key];
  }
  throw new Error(`Unsupported inputFrom: ${String(source)}`);
}
