import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
export const personInput = z.object({
  name: text(160),
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  role: z.string().trim().max(160).default(""),
  expertise: z.array(text(100)).max(30).default([]),
  primaryContact: z.boolean().default(false),
  source: z.enum(["operator", "customer", "inferred"]).default("operator"),
  evidence: z.string().max(3000).default(""),
});
export const questionInput = z.object({
  title: text(300),
  detail: z.string().max(12000).default(""),
  why: z.string().max(3000).default(""),
  priority: z.enum(["urgent", "high", "normal", "low"]).default("normal"),
  assignedPersonId: z.uuid(),
  dueAt: z.iso.datetime().nullable().optional(),
  campaignId: z.uuid().nullable().optional(),
  productId: z.uuid().nullable().optional(),
  runId: z.uuid().nullable().optional(),
  sourceKey: z.string().max(250).optional(),
});
export const answerInput = z.object({
  content: text(50000),
  questionRevision: z.number().int().positive(),
  evidence: z
    .array(
      z.object({
        label: text(200),
        url: z
          .url()
          .max(2000)
          .refine((u) => /^https?:\/\//i.test(u), "Use an HTTP or HTTPS link"),
      }),
    )
    .max(20)
    .default([]),
});
export const reviewInput = z
  .object({
    action: z.enum(["accept", "clarify", "reassign", "handoff", "reject"]),
    answerId: z.uuid().optional(),
    expectedRevision: z.number().int().positive(),
    comment: z.string().trim().max(10000).default(""),
    personId: z.uuid().optional(),
    reviewer: text(160).default("Operator"),
  })
  .superRefine((v, ctx) => {
    if (
      ["clarify", "reassign", "handoff", "reject"].includes(v.action) &&
      !v.comment
    )
      ctx.addIssue({
        code: "custom",
        path: ["comment"],
        message: "Explain the requested follow-up",
      });
    if (v.action === "reassign" && !v.personId)
      ctx.addIssue({
        code: "custom",
        path: ["personId"],
        message: "Choose a participant",
      });
    if (["accept", "clarify"].includes(v.action) && !v.answerId)
      ctx.addIssue({
        code: "custom",
        path: ["answerId"],
        message: "Choose the answer being reviewed",
      });
  });
export type PersonInput = z.infer<typeof personInput>;
export type QuestionInput = z.infer<typeof questionInput>;
export type AnswerInput = z.infer<typeof answerInput>;
export type ReviewInput = z.infer<typeof reviewInput>;
export interface CustomerSession {
  id: string;
  organizationId: string;
  personId: string;
  name: string;
  primaryContact: boolean;
  csrf: string;
}
export interface ParticipationActivities {
  participationStatus(
    questionId: string,
  ): Promise<{ state: string; answerId: string | null }>;
  participationReviewedResult(input: {
    questionId: string;
    organizationId: string;
  }): Promise<ReviewedParticipationAnswer | null>;
  publishParticipationAnswer(questionId: string): Promise<void>;
  deliverParticipationEmail(outboxId: string): Promise<void>;
}
export const stakeholderSkill = {
  name: "Identify key players",
  slug: "identify-key-players",
  description:
    "Identify the people needed to understand, review, and approve an organization initiative.",
  instructions:
    "Read the organization knowledge and initiative goals. Propose a stakeholder map with name, role, expertise, evidence, confidence, responsibilities, and missing roles. Distinguish confirmed people from inferred contacts. Never invent an email address. Ask the primary contact to verify the map and nominate missing people. Use participation.people to inspect existing people and participation.propose-person to propose missing verified contacts. Use participation.ask only with an existing organization person, explaining why their answer matters and its priority. Do not invite or send email without an explicit operator action. Only reviewed answers are customer-confirmed knowledge.",
  inputSchema: {
    type: "object",
    properties: { objective: { type: "string" } },
    required: ["objective"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      stakeholders: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            role: { type: "string" },
            evidence: { type: "string" },
            confidence: { type: "string" },
            questions: { type: "array", items: { type: "string" } },
          },
          required: ["name", "role", "evidence", "confidence", "questions"],
          additionalProperties: false,
        },
      },
      missingRoles: { type: "array", items: { type: "string" } },
    },
    required: ["stakeholders", "missingRoles"],
    additionalProperties: false,
  },
};
export interface ReviewedParticipationAnswer {
  state: "accepted" | "rejected";
  questionId: string;
  questionRevision: number;
  answer: {
    id: string;
    content: string;
    evidence: { label: string; url: string }[];
    personId: string;
    respondentName: string;
    submittedAt: string;
    questionRevision: number;
  } | null;
  review: { action: string; comment: string; reviewer: string } | null;
}
export const collectStakeholderInputSkill = {
  name: "Collect stakeholder input",
  slug: "collect-stakeholder-input",
  description:
    "Ask a named organization participant a focused question and wait durably for a reviewed answer.",
  instructions:
    "Use participation.people to inspect confirmed participants and their roles. Choose the person best placed to answer the current gap. Use participation.ask to assign a concise question, why it matters, and its priority. The engine pauses this reasoning session until the customer responds and a reviewer accepts or rejects the answer. Never invent the response. After resume, cite the named respondent and answer revision, distinguish rejected or uncertain information, and incorporate accepted findings. Do not send invitations; the operator confirms and sends them from People.",
  inputSchema: {
    type: "object",
    properties: { objective: { type: "string" } },
    required: ["objective"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      answerIds: { type: "array", items: { type: "string" } },
      unresolved: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "answerIds", "unresolved"],
    additionalProperties: false,
  },
};
