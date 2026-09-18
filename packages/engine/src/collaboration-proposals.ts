import { z } from "zod";
import { pool } from "../../database/src";
import { personInput, questionInput } from "../../shared/src/participation";
import {
  productSchema,
  campaignSchema,
  requirementSchema,
} from "../../shared/src/product-platform";
import { createParticipant, createQuestion } from "./participation";
import {
  createProduct,
  createCampaign,
  createRequirement,
} from "./product-platform";

export const collaborationKinds = [
  "participant",
  "participant_question",
  "product_record",
  "campaign",
  "requirement",
];
export async function validateCollaborationProposal(
  org: string,
  kind: string,
  raw: any,
) {
  const schemas: Record<string, z.ZodType> = {
    participant: personInput,
    participant_question: questionInput,
    product_record: productSchema,
    campaign: campaignSchema,
    requirement: requirementSchema.extend({ campaignId: z.uuid() }),
  };
  const schema = schemas[kind];
  if (!schema) throw Error("Unsupported collaboration proposal");
  const body: any = schema.parse(raw);
  // An assistant may propose evidence, but cannot confirm an inferred contact.
  if (kind === "participant") {
    body.source = "inferred";
    body.primaryContact = false;
  }
  for (const [table, ids] of [
    [
      "organization_person",
      [
        body.assignedPersonId,
        body.ownerPersonId,
        ...(body.stakeholderIds || []),
      ],
    ],
    ["platform_product", [body.productId]],
    ["platform_campaign", [body.campaignId]],
  ] as [string, (string | undefined)[]][]) {
    for (const id of ids.filter(Boolean)) {
      if (
        !(
          await pool.query(
            `SELECT id FROM ${table} WHERE id=$1 AND organization_id=$2`,
            [id, org],
          )
        ).rowCount
      )
        throw Error(
          "A selected person, product or campaign is outside this organization",
        );
    }
  }
  if (
    kind === "participant_question" &&
    !(
      await pool.query(
        "SELECT id FROM organization_person WHERE id=$1 AND organization_id=$2 AND state='active'",
        [body.assignedPersonId, org],
      )
    ).rowCount
  )
    throw Error(
      "Confirm the participant in People before assigning a question",
    );
  if (
    body.runId &&
    !(
      await pool.query(
        "SELECT r.id FROM run r JOIN task t ON t.id=r.task_id WHERE r.id=$1 AND coalesce(r.customer_organization_id,t.organization_id)=$2",
        [body.runId, org],
      )
    ).rowCount
  )
    throw Error("The selected run is outside this organization");
  return body;
}
export async function applyCollaborationProposal(
  org: string,
  kind: string,
  raw: any,
  targetId: string,
  changeId: string,
) {
  const body = await validateCollaborationProposal(org, kind, raw);
  switch (kind) {
    case "participant":
      return createParticipant(org, body, { id: targetId });
    case "participant_question":
      return createQuestion(org, {
        ...body,
        sourceKey: "proposal:" + changeId,
      });
    case "product_record":
      return createProduct(org, body, { id: targetId });
    case "campaign":
      return createCampaign(org, body, { id: targetId });
    case "requirement":
      return createRequirement(org, body.campaignId, body, { id: targetId });
    default:
      throw Error("Unsupported collaboration proposal");
  }
}
