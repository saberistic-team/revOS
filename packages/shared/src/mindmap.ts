import { z } from "zod";
import { createHash } from "node:crypto";
export const mapNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  summary: z.string(),
  theme: z.string(),
  evidence: z.enum([
    "researched",
    "inferred",
    "customer_confirmed",
    "unverified",
  ]),
  sourceIds: z.array(z.string()),
});
export const mindmapSchema = z.object({
  title: z.string(),
  summary: z.string(),
  nodes: z.array(mapNodeSchema),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      label: z.string(),
      inferred: z.boolean(),
      sourceIds: z.array(z.string()),
    }),
  ),
});
export type Mindmap = z.infer<typeof mindmapSchema>;
export function knowledgeFingerprint(
  docs: {
    id: string;
    revision: number;
    content: string;
    title: string;
    evidence: string;
  }[],
) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...docs]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((d) => [d.id, d.revision, d.title, d.evidence, d.content]),
      ),
    )
    .digest("hex");
}
export function validateMindmap(value: unknown, sourceIds: string[]): Mindmap {
  const graph = mindmapSchema.parse(value),
    allowed = new Set(sourceIds),
    ids = new Set(graph.nodes.map((n) => n.id));
  if (
    ids.size !== graph.nodes.length ||
    graph.nodes.length > 45 ||
    graph.edges.length > 70
  )
    throw Error("Invalid or oversized map");
  for (const item of [...graph.nodes, ...graph.edges])
    if (!item.sourceIds.length || item.sourceIds.some((id) => !allowed.has(id)))
      throw Error("Map contains missing or unknown sources");
  for (const edge of graph.edges)
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to)
      throw Error("Map contains an invalid connection");
  if (sourceIds.length && !graph.nodes.length)
    throw Error("Map has no concepts");
  return graph;
}
