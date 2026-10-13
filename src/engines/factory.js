import { CodexClient } from "../codex/client.js";
import { GeminiClient, GEMINI_DEFAULT_MODEL, mapGeminiEffort } from "../gemini/client.js";
import { WorkBuddyClient } from "../workbuddy/client.js";

const CODEX_MODEL_PATTERN = /^(gpt-|o[0-9])/i;

export function resolveEngineKind(env = process.env, platform = process.platform) {
  const requested = String(env.CODEX_REMOTE_CONTACT_ENGINE || "").trim().toLowerCase();
  if (requested === "codex" || requested === "gemini" || requested === "workbuddy") return requested;
  if (requested) return "workbuddy";
  return platform === "win32" ? "codex" : "workbuddy";
}

export function resolveGeminiModel(configured, env = process.env) {
  const explicit = String(env.GEMINI_MODEL || env.CODEX_REMOTE_CONTACT_GEMINI_MODEL || "").trim().replace(/^models\//, "");
  if (explicit) return explicit;
  const fromSettings = String(configured || "").trim().replace(/^models\//, "");
  if (/^gemini-/i.test(fromSettings)) return fromSettings;
  return GEMINI_DEFAULT_MODEL;
}

export function resolveEngineProfile({ env = process.env, platform = process.platform, settings = {} } = {}) {
  const kind = resolveEngineKind(env, platform);
  const configured = String(env.CODEX_REMOTE_CONTACT_CODEX_MODEL || settings.ai?.model || "").trim() || null;
  const requestedEffort = env.CODEX_REMOTE_CONTACT_REASONING_EFFORT || settings.ai?.reasoningEffort || "low";
  const workbuddyDefault = String(env.CODEX_REMOTE_CONTACT_WB_MODEL || "auto").trim() || "auto";
  const model = kind === "workbuddy"
    ? (configured && !CODEX_MODEL_PATTERN.test(configured) ? configured : workbuddyDefault)
    : kind === "gemini"
      ? resolveGeminiModel(configured, env)
      : (configured || "gpt-5.6-luna");
  return {
    kind,
    provider: kind === "codex" ? "codex-app-server" : kind === "gemini" ? "gemini-api" : "workbuddy-agent-sdk",
    model,
    effort: kind === "gemini" ? mapGeminiEffort(requestedEffort) : requestedEffort,
    contextTokenOptions: contextTokenOptionsFor(kind),
    migrateConversations: kind === "workbuddy",
    fallbackModels(currentModel = model, currentEffort = requestedEffort) {
      if (kind === "workbuddy") return fallbackWorkBuddyModels(currentModel, currentEffort);
      if (kind === "gemini") return fallbackGeminiModels(currentModel, currentEffort);
      return fallbackCodexModels(currentModel, currentEffort);
    },
    resolveContextTokenLimit(configuredLimit) {
      if (kind === "workbuddy") return normalizeWorkBuddyContextLimit(configuredLimit || 200_000);
      return configuredLimit || 200_000;
    }
  };
}

export function createEngineClient(profile, {
  executable,
  executableArgs,
  cwd,
  personalCwd,
  personalMode = false,
  timeoutMs,
  systemPrompt = "",
  onTurnEvent = () => {},
  threadsDir,
  env = process.env
} = {}) {
  if (profile.kind === "codex") {
    return new CodexClient({
      executable,
      executableArgs,
      cwd: personalMode ? personalCwd : cwd,
      model: profile.model,
      effort: profile.effort,
      timeoutMs
    });
  }
  if (profile.kind === "gemini") {
    return new GeminiClient({
      model: profile.model,
      effort: profile.effort,
      systemPrompt,
      timeoutMs,
      threadsDir,
      cwd,
      env
    });
  }
  return new WorkBuddyClient({
    cwd,
    model: profile.model,
    effort: profile.effort,
    systemPrompt,
    timeoutMs,
    onTurnEvent
  });
}

export function normalizeWorkBuddyContextLimit(value) {
  if (value === "auto") return "auto";
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "auto";
  return Math.min(1_000_000, Math.max(100_000, Math.floor(numeric)));
}

function contextTokenOptionsFor(kind) {
  if (kind === "workbuddy") {
    return [
      { value: "auto", label: "自动 · 跟随模型", description: "由 WorkBuddy 按当前模型的上下文窗口自动压缩" },
      { value: 100_000, label: "最短 · 100K", description: "WorkBuddy CLI 允许的最小压缩阈值" },
      { value: 200_000, label: "轻量 · 200K", description: "较早压缩，适合日常对话" },
      { value: 400_000, label: "平衡 · 400K", description: "保留较多近期细节" },
      { value: 600_000, label: "较长 · 600K", description: "较长任务使用，单轮处理可能更慢" },
      { value: 800_000, label: "长 · 800K", description: "长任务使用，可能增加耗时与用量" },
      { value: 1_000_000, label: "最长 · 1M", description: "WorkBuddy CLI 允许的最大压缩阈值" }
    ];
  }
  if (kind === "gemini") {
    return [
      { value: 32_000, label: "省量 · 32K", description: "更早在本地丢弃最早轮次，减少 Gemini 输入" },
      { value: 64_000, label: "轻量 · 64K", description: "适合通知和日常对话" },
      { value: 200_000, label: "平衡 · 200K", description: "保留更多近期细节，当前默认" },
      { value: 1_048_576, label: "最长 · 1M", description: "接近 Gemini Flash 的输入窗口；超出后只在本地丢弃最早轮次" }
    ];
  }
  return [
    { value: 32_000, label: "省量 · 32K", description: "更早压缩；压缩后的新增上下文按 32K 计量，不是总输入硬上限" },
    { value: 64_000, label: "轻量 · 64K", description: "适合通知和日常对话；压缩后的新增上下文按 64K 计量" },
    { value: 100_000, label: "精简 · 100K", description: "更早压缩，适合日常短对话" },
    { value: 200_000, label: "平衡 · 200K", description: "保留更多近期细节，当前默认" },
    { value: 400_000, label: "充足 · 400K", description: "更长历史，单轮处理可能更慢" }
  ];
}

function fallbackCodexModels(currentModel, currentEffort) {
  const entries = [
    ["gpt-6-astra", "GPT-6 Astra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-sol", "GPT-5.6 Sol", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-terra", "GPT-5.6 Terra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-luna", "GPT-5.6 Luna", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.5", "GPT-5.5", ["low", "medium", "high", "xhigh"]]
  ];
  if (!entries.some(([model]) => model === currentModel)) entries.unshift([currentModel, currentModel, [currentEffort]]);
  return entries.map(([model, displayName, efforts]) => ({
    model,
    displayName,
    description: "",
    isDefault: model === currentModel,
    defaultReasoningEffort: model === currentModel ? currentEffort : "low",
    supportedReasoningEfforts: [...new Set([...efforts, ...(model === currentModel ? [currentEffort] : [])])]
      .filter(Boolean)
      .map((reasoningEffort) => ({ reasoningEffort, description: "" }))
  }));
}

function fallbackWorkBuddyModels(currentModel, currentEffort) {
  const models = [
    "auto", "hy4-preview-f", "hy3", "hy3-x", "deepseek-v4.1-flash",
    "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5v-turbo",
    "minimax-m3", "kimi-k3-1", "kimi-k2.8-preview", "kimi-k2.7", "kimi-k2.6",
    "deepseek-v4-pro", "hy4-preview"
  ];
  if (currentModel && !models.includes(currentModel)) models.unshift(currentModel);
  const efforts = ["auto", "minimal", "low", "medium", "high", "xhigh", "max"];
  return models.map((model) => ({
    model,
    displayName: model,
    description: "WorkBuddy 当前账号模型目录的启动兜底；连接完成后会自动刷新",
    isDefault: model === "auto",
    defaultReasoningEffort: efforts.includes(currentEffort) ? currentEffort : "auto",
    reasoningCapabilitySource: "workbuddy-cli-global",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort === "auto" ? "不固定档位，由当前模型决定" : "WorkBuddy CLI 公开档位；模型不支持时可能自动忽略"
    }))
  }));
}

function fallbackGeminiModels(currentModel, currentEffort) {
  const models = [GEMINI_DEFAULT_MODEL, "gemini-3.6-flash"];
  if (currentModel && !models.includes(currentModel)) models.unshift(currentModel);
  const effort = mapGeminiEffort(currentEffort);
  const efforts = [
    ["low", "更快，适合聊天、摘要和事项提取"],
    ["medium", "平衡推理"],
    ["high", "更深推理，首字更慢、用量更高"]
  ];
  return models.map((model) => ({
    model,
    displayName: model,
    description: "Gemini API 模型。连接成功后会按账号可见目录刷新",
    isDefault: model === (currentModel || GEMINI_DEFAULT_MODEL),
    defaultReasoningEffort: effort,
    reasoningCapabilitySource: "gemini-api",
    supportedReasoningEfforts: efforts.map(([reasoningEffort, description]) => ({ reasoningEffort, description }))
  }));
}
