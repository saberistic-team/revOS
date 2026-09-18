import { recordModelResponse } from "./model-usage";
import type { ModelProvider, ModelRequest, ModelResponse } from "./index";
import { MockModelProvider } from "./index";
export class OpenAIModelProvider implements ModelProvider {
  constructor(private key: string) {}
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              request.instructions +
              "\nReturn JSON matching: " +
              JSON.stringify(request.outputSchema) +
              "\nContext: " +
              JSON.stringify(request.context),
          },
          { role: "user", content: JSON.stringify(request.input) },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok)
      throw new Error(`Model request failed (${response.status})`);
    const body = (await response.json()) as {
      choices: { message: { content: string } }[];
      id?: string; usage?: unknown;
    };
    await recordModelResponse(body, process.env.OPENAI_MODEL ?? "gpt-4.1-mini");
    return { output: JSON.parse(body.choices[0].message.content) };
  }
}
export function modelProvider(): ModelProvider {
  const provider = process.env.MODEL_PROVIDER ?? "mock";
  if (provider === "mock") return new MockModelProvider();
  if (provider !== "openai")
    throw new Error(`Unsupported MODEL_PROVIDER: ${provider}`);
  return process.env.OPENAI_API_KEY
    ? new OpenAIModelProvider(process.env.OPENAI_API_KEY)
    : new MockModelProvider();
}
