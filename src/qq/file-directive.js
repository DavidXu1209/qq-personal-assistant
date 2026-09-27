const QQ_FILE_DIRECTIVE = /^\s*\[\[qq_file:(\/[^\r\n]*?)\]\]\s*$/gim;
const QQ_IMAGE_DIRECTIVE = /^\s*\[\[qq_image:(\/[^\r\n]*?)\]\]\s*$/gim;
const QQ_FACE_DIRECTIVE = /\[\[qq_face:([^\]\r\n]+?)\]\]/gim;
const QQ_STICKER_DIRECTIVE = /\[\[qq_sticker:((?:st_)?[a-f0-9]{12,64})\]\]/gim;
const QQ_STICKER_LABEL_DIRECTIVE = /^\s*\[\[qq_sticker_label:(st_[a-f0-9]{12,64})\|([^\]\r\n]+?)\]\]\s*$/gim;
const QQ_POKE_DIRECTIVE = /\[\[qq_poke:(sender|\d{5,14})\]\]/gim;
const QQ_SILENT_DIRECTIVE = /^\s*\[\[qq_silent\]\]\s*$/gim;

export const QQ_FACE_ALIASES = Object.freeze({
  "惊讶": 0,
  "流泪": 5,
  "害羞": 6,
  "大哭": 9,
  "发怒": 11,
  "调皮": 12,
  "呲牙": 13,
  "微笑": 14,
  "难过": 15,
  "偷笑": 20,
  "可爱": 21,
  "白眼": 22,
  "疑问": 32,
  "再见": 39,
  "拥抱": 49,
  "玫瑰": 63,
  "爱心": 66,
  "赞": 76,
  "胜利": 79,
  "鼓掌": 99,
  "抱拳": 118,
  "ok": 124
});

export function parseQqDeliveryDirectives(value, {
  allowFiles = false,
  allowImages = allowFiles,
  allowFaces = true,
  allowStickers = true,
  allowPokes = false,
  allowSilent = false,
  pokeSenderId = null,
  allowedPokeUserIds = [],
  maxFiles = 5,
  maxImages = 5,
  maxFaces = 5,
  maxStickers = 1,
  maxStickerLabels = 10,
  maxPokes = 1
} = {}) {
  const files = [];
  const images = [];
  const faces = [];
  const stickers = [];
  const stickerLabels = [];
  const pokes = [];
  let silent = false;
  const allowedPokes = new Set((allowedPokeUserIds || []).map(String));
  if (pokeSenderId != null) allowedPokes.add(String(pokeSenderId));
  let text = String(value || "");
  text = text.replace(QQ_FILE_DIRECTIVE, (_match, rawPath) => {
    if (allowFiles && files.length < maxFiles) files.push({ sourcePath: rawPath.trim() });
    return "";
  });
  text = text.replace(QQ_IMAGE_DIRECTIVE, (_match, rawPath) => {
    if (allowImages && images.length < maxImages) images.push({ sourcePath: rawPath.trim() });
    return "";
  });
  text = text.replace(QQ_FACE_DIRECTIVE, (_match, rawFace) => {
    const face = normalizeFace(rawFace);
    if (allowFaces && face && faces.length < maxFaces) faces.push({ ...face, delivered: false });
    return "";
  });
  text = text.replace(QQ_STICKER_LABEL_DIRECTIVE, (_match, id, usage) => {
    const normalizedUsage = String(usage || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (normalizedUsage && stickerLabels.length < maxStickerLabels) stickerLabels.push({ id, usage: normalizedUsage });
    return "";
  });
  text = text.replace(QQ_STICKER_DIRECTIVE, (_match, id) => {
    const normalizedId = id.startsWith("st_") ? id : `st_${id}`;
    if (allowStickers && stickers.length < maxStickers) stickers.push({ id: normalizedId, delivered: false });
    return "";
  });
  text = text.replace(QQ_POKE_DIRECTIVE, (_match, target) => {
    const userId = target.toLowerCase() === "sender" ? String(pokeSenderId || "") : String(target);
    if (allowPokes && /^\d{5,14}$/.test(userId) && allowedPokes.has(userId) && pokes.length < maxPokes) {
      pokes.push({ userId, delivered: false });
    }
    return "";
  });
  text = text.replace(QQ_SILENT_DIRECTIVE, () => {
    if (allowSilent) silent = true;
    return "";
  });
  return {
    text: text.replace(/\n{3,}/g, "\n\n").trim(),
    files,
    images,
    faces,
    stickers,
    stickerLabels,
    pokes,
    silent
  };
}

export function parseQqFileDirectives(value, { allowFiles = false, maxFiles = 5 } = {}) {
  const parsed = parseQqDeliveryDirectives(value, {
    allowFiles,
    allowImages: false,
    allowFaces: false,
    allowStickers: false,
    maxFiles
  });
  return { text: parsed.text, files: parsed.files };
}

function normalizeFace(value) {
  const label = String(value || "").trim();
  const lower = label.toLowerCase();
  const id = /^\d{1,5}$/.test(lower) ? Number(lower) : QQ_FACE_ALIASES[lower];
  if (!Number.isInteger(id) || id < 0 || id > 65535) return null;
  const knownName = Object.entries(QQ_FACE_ALIASES).find(([, candidate]) => candidate === id)?.[0];
  return { id, name: knownName || label || String(id) };
}
