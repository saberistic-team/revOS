import { ToolRegistry } from "../../../packages/engine/src";
// Demo integration adapter. No live records or network calls.
export function registerDemoTools(registry: ToolRegistry) {
  registry.register(
    "property.search",
    async (_input, configuration) => {
      if (!configuration.syntheticResults)
        throw new Error("Demo property tool requires syntheticResults");
      return configuration.syntheticResults;
    },
    { retrySafe: true },
  );
}
