/** Local, deterministic lookup. No model call and no invented sticker IDs. */
export function searchReactions(stickers, faces, { query = "", offset = 0, limit = 8 } = {}) {
  if (typeof query !== "string" || query.length > 80 || !Number.isInteger(offset) || offset < 0
    || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("query 最多 80 字；offset 须为非负整数；limit 须为 1–20。");
  }
  const needle = query.trim().toLocaleLowerCase();
  const terms = needle.split(/[\s、，,|/]+/u).filter(Boolean);
  const score = (text) => {
    const haystack = String(text).toLocaleLowerCase();
    if (!needle) return 1;
    if (haystack.includes(needle)) return 100 + needle.length;
    return terms.reduce((total, term) => total + (haystack.includes(term) ? 10 + term.length : 0), 0);
  };
  const ranked = (items, text) => items.map((item, index) => ({ item, index, score: score(text(item)) }))
    .filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.item);
  const seen = new Set();
  const valid = (stickers || []).filter((item) => {
    if (!/^st_[a-f0-9]{12,64}$/u.test(String(item?.id || "")) || !String(item?.usage || "").trim() || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).map(({ id, usage }) => ({ id, usage: String(usage).trim() }));
  const matchingStickers = ranked(valid, (item) => item.usage);
  const matchingFaces = ranked(faces || [], (item) => item);
  const hasMore = Math.max(matchingStickers.length, matchingFaces.length) > offset + limit;
  return {
    faces: matchingFaces.slice(offset, offset + limit),
    stickers: matchingStickers.slice(offset, offset + limit),
    totalStickers: matchingStickers.length, totalFaces: matchingFaces.length,
    nextOffset: hasMore ? offset + limit : null
  };
}
