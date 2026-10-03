import { runAutoSubscriptionTurn } from "../security/subscription-policy.js";
import { runLiveTurnWithSendRecovery } from "./live-send-recovery.js";

/** Shared model-round protocol; target workers retain their durable queues/cutoffs. */
export async function runConversationTurn({ codex, request, autoSubscription = null, onRecovery = () => {} }) {
  if (autoSubscription) {
    return runAutoSubscriptionTurn({ ...autoSubscription, prompt: request.prompt,
      runTurn: (prompt) => codex.runTurn({ ...request, prompt }) });
  }
  return { result: await runLiveTurnWithSendRecovery((turn) => codex.runTurn(turn), request, { onRecovery }) };
}
