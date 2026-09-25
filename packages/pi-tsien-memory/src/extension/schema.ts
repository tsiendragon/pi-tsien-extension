export const Type = {
  Object(properties: Record<string, Record<string, unknown>>): Record<string, unknown> {
    const required = Object.entries(properties).filter(([, value]) => value.optional !== true).map(([key]) => key);
    const normalized = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
      const copy = { ...value };
      delete copy.optional;
      return [key, copy];
    }));
    return { type: "object", properties: normalized, required, additionalProperties: false };
  },
  String(options: Record<string, unknown> = {}): Record<string, unknown> { return { type: "string", ...options }; },
  Boolean(options: Record<string, unknown> = {}): Record<string, unknown> { return { type: "boolean", ...options }; },
  Number(options: Record<string, unknown> = {}): Record<string, unknown> { return { type: "number", ...options }; },
  Array(item: Record<string, unknown>): Record<string, unknown> { return { type: "array", items: item }; },
  Literal(value: string): Record<string, unknown> { return { const: value }; },
  Union(values: Record<string, unknown>[]): Record<string, unknown> { return { anyOf: values }; },
  Optional(value: Record<string, unknown>): Record<string, unknown> { return { ...value, optional: true }; },
};

export function textResult(text: string, details?: unknown): { content: [{ type: "text"; text: string }]; details?: unknown } {
  return details === undefined ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], details };
}
