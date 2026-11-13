/**
 * Tool arguments arrive as arbitrary JSON chosen by a model. These helpers turn the common
 * mistakes (a string where a list was expected, a number as a string) into either a usable
 * value or an error message the model can act on, instead of a stack trace.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

/** Accepts a list, or a single item where a list was expected. */
export function optionalList(value: unknown, name: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string" || isRecord(value)) return [value];
  throw new Error(`${name} must be an array`);
}

export function optionalStringList(value: unknown, name: string): string[] {
  return optionalList(value, name).map((item, idx) => {
    if (typeof item !== "string") {
      throw new Error(`${name}[${idx}] must be a string`);
    }
    return item;
  });
}
