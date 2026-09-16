import Ajv from "ajv";
import type { Json } from "../../shared/src";
const ajv = new Ajv({ allErrors: true, strict: false });
export function validate(schema: Json, value: Json, label: string): void {
  const check = ajv.compile(schema as object);
  if (!check(value))
    throw new Error(`${label}: ${ajv.errorsText(check.errors)}`);
}
export { bindInput } from "../../shared/src/bindings";
export type ToolHandler = (
  input: Json,
  configuration: Record<string, Json>,
  context?: { idempotencyKey: string; signal?: AbortSignal },
) => Promise<Json>;
export class ToolRegistry {
  private handlers = new Map<string, ToolHandler>();
  private retrySafe = new Set<string>();
  isRetrySafe(name: string) {
    return this.retrySafe.has(name);
  }
  register(
    name: string,
    handler: ToolHandler,
    options?: { retrySafe: boolean },
  ) {
    if (this.handlers.has(name)) throw new Error(`Duplicate tool: ${name}`);
    this.handlers.set(name, handler);
    if (options?.retrySafe) this.retrySafe.add(name);
  }
  resolve(name: string): ToolHandler {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Unknown tool handler: ${name}`);
    return handler;
  }
}
export interface ModelRequest {
  instructions: string;
  input: Json;
  outputSchema: Json;
  configuration: Record<string, Json>;
  context: Json;
}
export interface ModelResponse {
  output: Json;
}
export interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
// Fixtures are stored in SkillVersion.configuration, never selected by business name.
export class MockModelProvider implements ModelProvider {
  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (!("mockResponse" in request.configuration))
      throw new Error("Mock skill requires configuration.mockResponse");
    return { output: request.configuration.mockResponse };
  }
}
