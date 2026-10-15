/** OpenAPI-ish subset accepted by the Gemini REST `responseSchema` field. */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object" };
  const union = Array.isArray(schema.type) ? schema.type.map((item) => String(item)) : null;
  const nullable = Boolean(schema.nullable) || Boolean(union?.includes("null"));
  const type = union ? union.find((item) => item !== "null") : schema.type;
  const out = {};
  if (type) out.type = String(type);
  if (nullable) out.nullable = true;
  if (schema.description) out.description = String(schema.description);
  if (Array.isArray(schema.enum) && schema.enum.length) out.enum = schema.enum.map((item) => item);
  if (schema.format) out.format = String(schema.format);
  if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required.map(String);
  if (schema.properties && typeof schema.properties === "object") {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  return out;
}
