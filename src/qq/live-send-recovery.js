/** Give an Agent one chance to deliver a reply it wrote only as final text.
 * The gateway never sends that text itself; QQ actions still require MCP.
 */
export async function runLiveTurnWithSendRecovery(runTurn, request, { onRecovery = () => {} } = {}) {
  const first = await runTurn(request);
  const context = request.qqToolContext;
  // An explicit silent decision is not an accidentally unsent answer. Keep
  // this opt-out scoped to a successful live read; never swallow source JSON
  // or an error, and never send final text on the Agent's behalf.
  if (context?.liveMode && context.readCalled && !context.failed
    && String(first?.text || "").trim() === "NO_REPLY") return { ...first, text: "" };
  if (!context?.liveMode || !context.readCalled || context.failed || context.ended
    || context.actionCount !== 0 || !String(first?.text || "").trim()) return first;

  onRecovery();
  const second = await runTurn({
    ...request,
    imagePaths: [],
    prefetchQqMessages: false,
    // This is a short, tool-only follow-up. Reconnect the WorkBuddy SDK on the
    // same persistent thread instead of reusing a stream that just completed.
    refreshClientBeforeTurn: true,
    turnTimeoutMs: 120_000,
    prompt: [
      "【网关发送校验】上一轮你写了最终文字，但没有调用 QQ 发送工具，所以 QQ 中没有收到，也没有消息被标记为已处理。",
      "如果你原本想回复，请现在亲自调用本轮 qq_gateway 的相应发送工具；文字用 send_message。",
      "如果你决定不回复，可以直接结束或调用 end_conversation。不要再把要发送的正文只写在最终输出里。"
    ].join("\n")
  });
  return { ...second, compacted: Boolean(first.compacted || second.compacted) };
}
