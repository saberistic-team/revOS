import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  OpenAIProvider,
  type Model,
  type ModelProvider,
  type ModelResponse,
} from "@openai/agents";

export interface UsageContext {
  organizationId: string;
  productId?: string;
  campaignId?: string;
  runId?: string;
  buildId?: string;
  operation?: string;
  attemptId?: string;
}
export const usageContext = new AsyncLocalStorage<UsageContext>();

/** Provider usage is authoritative. Cached input is part of input; reasoning is part of output. */
export function tokenUsage(response: any) {
  const usage = response?.rawUsage ?? response?.usage;
  if (!usage) return null;
  const input = usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens;
  const output =
    usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens;
  if (
    !Number.isSafeInteger(input) ||
    input < 0 ||
    !Number.isSafeInteger(output) ||
    output < 0
  )
    return null;
  const details =
    usage.inputTokensDetails ??
    usage.input_tokens_details ??
    usage.prompt_tokens_details;
  const parts = Array.isArray(details) ? details : [details];
  const cached = parts.reduce(
    (sum: number, p: any) =>
      sum + (Number.isSafeInteger(p?.cached_tokens) ? p.cached_tokens : 0),
    0,
  );
  if (cached < 0 || cached > input) return null;
  return { input: input - cached, cached, output };
}

export function usageMeasurements(response: any, fallbackId: string) {
  const measured = tokenUsage(response);
  const id =
    response?.responseId ?? response?.id ?? response?.requestId ?? fallbackId;
  const measurements: {
    category: "llm_input" | "llm_cached_input" | "llm_output" | "hosted_tools";
    units: number;
    unit: string;
    eventKey: string;
    metadata?: Record<string, unknown>;
  }[] = [];
  if (measured) {
    for (const [category, units] of [
      ["llm_input", measured.input],
      ["llm_cached_input", measured.cached],
      ["llm_output", measured.output],
    ] as const)
      if (units > 0)
        measurements.push({
          category,
          units,
          unit: "tokens",
          eventKey: `${id}:${category}`,
        });
  }
  const seen = new Set<string>();
  for (const item of response?.output ?? []) {
    const name = item.type === "hosted_tool_call" ? item.name : item.type;
    if (
      !["web_search_call", "code_interpreter_call"].includes(name) ||
      !item.id ||
      seen.has(item.id)
    )
      continue;
    seen.add(item.id);
    measurements.push({
      category: "hosted_tools",
      units: 1,
      unit: "calls",
      eventKey: `${id}:tool:${item.id}`,
      metadata: { tool: name, measurement: "calls, not billable sessions" },
    });
  }
  return measurements;
}

export function modelUsageEntries(
  response: any,
  model: string,
  scope: UsageContext | undefined = usageContext.getStore(),
) {
  if (!scope) return [];
  const stableId = response?.responseId ?? response?.id ?? response?.requestId;
  return usageMeasurements(response, randomUUID()).map((measurement) => ({
    ...scope,
    provider: "openai:" + model,
    attemptId: stableId ? "" : scope.attemptId,
    ...measurement,
    metadata: { model, operation: scope.operation, ...measurement.metadata },
  }));
}
export async function recordModelResponse(
  response: any,
  model: string,
  scope = usageContext.getStore(),
) {
  const { recordUsageDurably } = await import("./usage-journal");
  for (const measurement of modelUsageEntries(response, model, scope))
    await recordUsageDurably(measurement);
}

/** Wrap the model boundary so invalid structured answers still accrue their actual usage. */
export class MeteredOpenAIProvider implements ModelProvider {
  constructor(
    private provider: ModelProvider = new OpenAIProvider(),
    private record = recordModelResponse,
    private warn: (message: string) => void = console.warn,
  ) {}
  async getModel(name?: string): Promise<Model> {
    const delegate = await this.provider.getModel(name);
    const record = this.record,
      warn = this.warn;
    const observe = async (response: unknown) => {
      try {
        await record(response, name ?? "default");
      } catch {
        warn(
          "Model usage could not be recorded; response preserved for the caller",
        );
      }
    };
    return {
      async getResponse(request) {
        const response = await delegate.getResponse(request);
        await observe(response);
        return response;
      },
      async *getStreamedResponse(request) {
        for await (const event of delegate.getStreamedResponse(request)) {
          if ((event as any).type === "response_done")
            await observe((event as any).response as ModelResponse);
          yield event;
        }
      },
    };
  }
}
