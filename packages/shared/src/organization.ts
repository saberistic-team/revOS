import { z } from "zod";
export const organizationIdentitySchema = z.object({
  name: z.string().nullable(),
  domain: z.string().nullable(),
  confidence: z.enum(["high", "low"]),
  reason: z.string(),
});
export const organizationChoiceSchema = z.union([
  z.object({ organizationId: z.uuid() }),
  z.object({
    name: z.string().trim().min(1).max(200),
    domain: z.string().max(250).nullable(),
  }),
]);
export function normalizeName(name: string) {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
export function normalizeDomain(
  input: string | null | undefined,
): string | null {
  if (!input) return null;
  try {
    const url = new URL(input.includes("://") ? input : "https://" + input);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      !host.includes(".") ||
      host === "localhost" ||
      /^\d+(\.\d+){3}$/.test(host)
    )
      return null;
    return host;
  } catch {
    return null;
  }
}
export function matchOrganization(
  identity: { name: string | null; domain: string | null; confidence: string },
  directory: {
    id: string;
    name: string;
    domain: string | null;
    aliases: string[];
  }[],
) {
  const domain = normalizeDomain(identity.domain),
    name = normalizeName(identity.name || "");
  const byDomain = domain ? directory.filter((o) => o.domain === domain) : [];
  const byName = name
    ? directory.filter((o) =>
        [o.name, ...o.aliases].some((n) => normalizeName(n) === name),
      )
    : [];
  if (
    byDomain.length === 1 &&
    (!byName.length || byName.some((o) => o.id === byDomain[0].id))
  )
    return { match: byDomain[0].id, ambiguous: false };
  if (
    !byDomain.length &&
    byName.length === 1 &&
    (!domain || !byName[0].domain || domain === byName[0].domain)
  )
    return { match: byName[0].id, ambiguous: false };
  return { match: null, ambiguous: !!(byDomain.length || byName.length) };
}
