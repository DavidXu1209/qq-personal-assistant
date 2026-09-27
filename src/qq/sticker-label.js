export function buildStickerLabelPrompt(requests = []) {
  const lines = [
    "这是 QQ 原生表情包入库前的内部视觉标注任务，不要回复群聊内容，也不要执行任何工具或外部操作。",
    "请逐张查看随本轮附加的真实表情图像，结合画面本身和可选的原消息文字，为每张表情写一个简短、可复用的中文使用场景。",
    "标签应描述适合在什么语气或情境下发送，例如：适合震惊、没想到时使用。不要猜人物身份，不要照抄文件名。",
    requests.length > 1
      ? `只输出 ${requests.length} 行中文描述，严格按图片顺序每张一行；不要编号或添加任何其他内容。`
      : "只输出一句中文描述，不要添加前缀、解释或任何其他内容。",
    "",
    "图片提示（顺序与附加图片一致）："
  ];
  for (const [index, request] of requests.entries()) {
    lines.push(
      `图片 ${index + 1}${request.qqSummary ? `；QQ 摘要：${clean(request.qqSummary)}` : ""}${request.sourceText ? `；原消息文字：${clean(request.sourceText)}` : ""}`
    );
  }
  return lines.join("\n");
}

export function parseStickerLabelResult(value, requests = []) {
  const expected = requests.filter((request) => String(request?.id || "").trim());
  if (!expected.length) return [];
  const descriptions = extractDescriptions(value);
  if (descriptions.length < expected.length) {
    throw new Error(`AI 表情标注缺少有效描述（需要 ${expected.length}，得到 ${descriptions.length}），候选表情尚未入库`);
  }
  return expected.map((request, index) => ({
    id: String(request.id).trim(),
    usage: descriptions[index]
  }));
}

function clean(value) {
  return String(value || "").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim();
}

function extractDescriptions(value) {
  const text = String(value || "").trim();
  if (!text) return [];

  // Older model replies may still contain JSON despite the plain-text prompt.
  // Recover the description only; IDs always come from the trusted candidate list.
  const embedded = [];
  const jsonDescription = /"(?:usage|scene|description)"\s*:\s*"((?:\\.|[^"\\])*)"/giu;
  for (const match of text.matchAll(jsonDescription)) {
    let decoded = match[1];
    try {
      decoded = JSON.parse(`"${decoded}"`);
    } catch {
      // Keep the raw captured text when a model emitted imperfect JSON escapes.
    }
    const description = normalizeDescription(decoded);
    if (description && !embedded.includes(description)) embedded.push(description);
  }
  if (embedded.length) return embedded;

  return text
    .replace(/```(?:json|text)?/giu, "\n")
    .split(/\r?\n/)
    .map(normalizeDescription)
    .filter(Boolean);
}

function normalizeDescription(value) {
  let description = clean(value)
    .replace(/^\s*(?:[-*•]+|\d+[.)、：:]|图片\s*\d+\s*[：:])\s*/u, "")
    .replace(/^\s*(?:描述|使用场景|场景)\s*[：:]\s*/u, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
    .trim();
  if (!isUsableStickerDescription(description)) return "";
  if (/^(?:以下|结果|说明|注|备注|工具|structuredoutput)/iu.test(description)) return "";
  description = description.slice(0, 40).trim();
  return description.length >= 2 ? description : "";
}

export function isUsableStickerDescription(value) {
  const description = clean(value);
  if (!description || !/[\u3400-\u9fff]/u.test(description)) return false;
  const recognitionFailure = [
    /(?:无法|不能|未能|难以|看不清|看不到|辨认不出|识别不出|判断不了).{0,16}(?:图片|图像|画面|表情|场景|内容)/u,
    /(?:图片|图像|画面).{0,20}(?:分辨率过低|过于模糊|太模糊|光线昏暗|不可见|未加载|不存在|缺失)/u,
    /(?:没有|缺少|未提供).{0,12}(?:图片|图像|画面|视觉信息)/u,
    /(?:无法据此|信息不足以).{0,24}(?:描述|判断|写出|生成|标注)/u
  ];
  return !recognitionFailure.some((pattern) => pattern.test(description));
}
