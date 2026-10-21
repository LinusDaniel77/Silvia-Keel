// The SDK's structured-output helper takes zod v4 schemas; zod 3.25 ships v4 under "zod/v4".
import { z } from "zod/v4";

const Hit = z.object({
  tactic_id: z.string(),
  confidence: z.number(),
  evidence: z.array(z.string()),
});

/**
 * Claude's read of one conversation. Principle 6 is structural here: there is deliberately no
 * field for the other person's insecurities, weaknesses or pressure points, so the model has
 * nowhere to put them. See test/first-test.test.ts.
 */
export const CopilotReadSchema = z.object({
  summary: z.string(),
  my_goal: z.string(),
  their_goal: z.string(),
  my_leverage: z.array(z.string()),
  what_they_care_about: z.array(z.string()),
  how_they_likely_feel: z.string(),
  alternative_readings: z.array(
    z.object({ reading: z.string(), question_that_settles_it: z.string() }),
  ),
  tactics_used_by_them: z.array(Hit),
  tactics_used_by_me: z.array(Hit),
  honest_pushback: z.string(),
  suggested_next_message: z.string(),
});
export type CopilotRead = z.infer<typeof CopilotReadSchema>;
