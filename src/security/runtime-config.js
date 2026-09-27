export function validateRuntimeConfig({ ownerId, botId, host, authDisabled, apiToken, oneBotToken }) {
  for (const [label, value] of [["OWNER QQ", ownerId], ["bot QQ", botId]]) {
    if (!/^[1-9][0-9]{4,11}$/.test(String(value || ""))) throw new Error("Configure a valid " + label + " ID in config/qq-only.env");
  }
  if (ownerId === botId) throw new Error("OWNER and bot must be different QQ accounts");
  if (authDisabled && !["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Unauthenticated Hub access is only allowed on loopback");
  if (!authDisabled && !apiToken) throw new Error("Hub authentication token is missing");
  if (!oneBotToken) throw new Error("OneBot authentication token is missing");
}
