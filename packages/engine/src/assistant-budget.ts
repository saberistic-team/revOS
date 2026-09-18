import { getEncoding } from "js-tiktoken";
const encoding = getEncoding("o200k_base");
export const ASSISTANT_OUTPUT_TOKENS = 8000;
// Leave 6,000 tokens below the account's 30k TPM ceiling for SDK framing,
// structured-output schema and provider estimation differences.
export const ASSISTANT_INPUT_TOKENS = 16000;
export const tokenCount = (text: string) => encoding.encode(text).length;
export function checkAssistantBudget(input: string, instructions: string) {
  const tokens = tokenCount(input) + tokenCount(instructions);
  if (tokens > ASSISTANT_INPUT_TOKENS)
    throw Error(
      "This selection is too large for the assistant's token budget. Choose a smaller workflow or shorten your message; no content has been changed.",
    );
  return tokens;
}
export function fitAssistantInput(value: any, instructions: string) {
  const input = structuredClone(value);
  const fits = () =>
    tokenCount(JSON.stringify(input)) + tokenCount(instructions) <=
    ASSISTANT_INPUT_TOKENS;
  // Keep the current request and the complete selected workflow. Trim optional
  // background first; never silently truncate a workflow we may replace.
  for (const d of input.context.documents) {
    if (fits()) break;
    if (d.id !== input.selectedDocumentId) {
      d.content = "";
      d.excerpt = true;
    }
  }
  for (const list of Object.values(
    input.context.collaboration || {},
  ) as any[][]) {
    while (!fits() && Array.isArray(list) && list.length > 5) list.pop();
  }
  while (!fits() && input.conversation.length > 1) input.conversation.shift();
  for (const key of [
    "products",
    "documents",
    "knowledge",
    "skills",
    "tools",
    "workflows",
  ]) {
    for (
      let i = (input.context[key]?.length ?? 0) - 1;
      i >= 0 && !fits();
      i--
    ) {
      const item = input.context[key][i];
      if (
        item.id === input.selectedProductId ||
        item.id === input.selectedDocumentId ||
        item.id === input.selectedWorkflowId
      )
        continue;
      input.context[key].splice(i, 1);
    }
  }
  const doc = input.context.documents.find(
    (d: any) => d.id === input.selectedDocumentId,
  );
  while (!fits() && doc?.content.length > 0) {
    doc.content = doc.content.slice(0, Math.floor(doc.content.length / 2));
    doc.excerpt = true;
  }
  const text = JSON.stringify(input);
  const tokens = checkAssistantBudget(text, instructions);
  return { text, tokens, context: input.context };
}
