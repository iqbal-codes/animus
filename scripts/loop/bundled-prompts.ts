// Bundled canonical prompt resources for standalone and installed distributions
import assessMergeQueuePrompt from "../prompts/assess-merge-queue.md" with { type: "text" };
import discoveriesPrompt from "../prompts/discoveries.md" with { type: "text" };
import holdoutVerifierPrompt from "../prompts/holdout-verifier.md" with { type: "text" };
import holdoutWriterPrompt from "../prompts/holdout-writer.md" with { type: "text" };
import investigatePrompt from "../prompts/investigate.md" with { type: "text" };
import loopCheckAppPrompt from "../prompts/loop-check-app.md" with { type: "text" };
import loopPickPrompt from "../prompts/loop-pick.md" with { type: "text" };
import loopReflectPrompt from "../prompts/loop-reflect.md" with { type: "text" };
import loopReviewPrompt from "../prompts/loop-review.md" with { type: "text" };
import loopWorkPrompt from "../prompts/loop-work.md" with { type: "text" };
import managePrompt from "../prompts/manage.md" with { type: "text" };
import planPrompt from "../prompts/plan.md" with { type: "text" };
import simplifyPrompt from "../prompts/simplify.md" with { type: "text" };
import sliceBacklogPrompt from "../prompts/slice-backlog.md" with { type: "text" };

export const BUNDLED_PROMPTS: Record<string, string> = {
  "assess-merge-queue": assessMergeQueuePrompt,
  discoveries: discoveriesPrompt,
  "holdout-verifier": holdoutVerifierPrompt,
  "holdout-writer": holdoutWriterPrompt,
  investigate: investigatePrompt,
  "loop-check-app": loopCheckAppPrompt,
  "loop-pick": loopPickPrompt,
  "loop-reflect": loopReflectPrompt,
  "loop-review": loopReviewPrompt,
  "loop-work": loopWorkPrompt,
  manage: managePrompt,
  plan: planPrompt,
  simplify: simplifyPrompt,
  "slice-backlog": sliceBacklogPrompt,
};
