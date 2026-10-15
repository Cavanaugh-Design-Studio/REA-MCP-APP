import {
  bufferedJsonParts,
  jsonParts,
} from "../../domain/jsonSerialization.js";

/** Admit the original representation before allocating a full string or a redacted copy. */
const serializeWithinBudget = (
  value: unknown,
  budget: number,
): string | null => {
  const parts: string[] = [];
  let bytes = 0;
  for (const part of bufferedJsonParts(jsonParts(value))) {
    bytes += Buffer.byteLength(part);
    if (bytes > budget) return null;
    parts.push(part);
  }
  return parts.join("");
};

/** Redact explicitly selected string values before JSON escaping; preserve canonical local records. */
export const modelContext = (
  value: unknown,
  budget: number,
  sensitiveValues: readonly string[],
): string | null => {
  const admitted = serializeWithinBudget(value, budget);
  if (admitted === null || sensitiveValues.length === 0) return admitted;
  const copy: unknown = JSON.parse(admitted);
  const queue: unknown[] = [copy];
  while (queue.length > 0) {
    const current = queue.pop();
    if (typeof current !== "object" || current === null) continue;
    for (const key of Object.keys(current)) {
      const child: unknown = Reflect.get(current, key);
      if (typeof child === "string") {
        let redacted = child;
        for (const sensitive of sensitiveValues)
          redacted = redacted.replaceAll(sensitive, "[REDACTED]");
        Reflect.set(current, key, redacted);
      } else queue.push(child);
    }
  }
  return serializeWithinBudget(copy, budget);
};
