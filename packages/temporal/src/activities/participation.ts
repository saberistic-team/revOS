import { ApplicationFailure } from "@temporalio/activity";
import { pool } from "../../../database/src";
import {
  deliverOutbox,
  publishAcceptedAnswer,
  reviewedParticipationResult,
} from "../../../engine/src/participation";
import type { ParticipationActivities } from "../../../shared/src/participation";
export function createParticipationActivities(): ParticipationActivities {
  return {
    async participationStatus(id) {
      const row = (
        await pool.query(
          "SELECT state,latest_answer_id FROM participation_question WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!row) throw ApplicationFailure.nonRetryable("Question not found");
      return { state: row.state, answerId: row.latest_answer_id };
    },
    publishParticipationAnswer: publishAcceptedAnswer,
    participationReviewedResult: reviewedParticipationResult,
    deliverParticipationEmail: deliverOutbox,
  };
}
