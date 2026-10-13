import { readFileSync } from "node:fs";

/** Optional text applied on top of the shared persona. Empty means use that prompt unchanged. */
export function resolveGeminiPersonaOverride(env = process.env, { readFile = readFileSync } = {}) {
  const modeRaw = String(env.GEMINI_PERSONA_MODE || env.CODEX_REMOTE_CONTACT_GEMINI_PERSONA_MODE || "").trim().toLowerCase();
  const mode = modeRaw || "append";
  if (mode !== "append" && mode !== "replace") {
    throw new Error("GEMINI_PERSONA_MODE must be append or replace");
  }
  const inline = String(env.GEMINI_PERSONA || env.CODEX_REMOTE_CONTACT_GEMINI_PERSONA || "").trim();
  const filePath = String(env.GEMINI_PERSONA_FILE || env.CODEX_REMOTE_CONTACT_GEMINI_PERSONA_FILE || "").trim();
  let fileText = "";
  if (filePath) {
    let raw;
    try {
      raw = readFile(filePath, "utf8");
    } catch (error) {
      throw new Error(`GEMINI_PERSONA_FILE cannot be read (${filePath}): ${error.message}`);
    }
    fileText = String(raw || "").trim();
    if (!fileText) throw new Error(`GEMINI_PERSONA_FILE is empty (${filePath})`);
  }
  const text = [inline, fileText].filter(Boolean).join("\n\n");
  if (modeRaw === "replace" && !text) {
    throw new Error("GEMINI_PERSONA_MODE=replace requires GEMINI_PERSONA or GEMINI_PERSONA_FILE");
  }
  return { mode: text ? mode : "append", text };
}

/** No override returns the shared prompt unchanged. Append keeps it as a prefix; replace uses only the override. */
export function composeGeminiSystemPrompt(base, override = {}) {
  const shared = String(base || "").trim();
  const extra = String(override.text || "").trim();
  if (!extra) return shared;
  if (override.mode === "replace") return extra;
  return shared ? `${shared}\n\n${extra}` : extra;
}
