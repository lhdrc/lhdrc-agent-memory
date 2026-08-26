import { readFile } from "node:fs/promises";

export function parseJsonl(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t));
  }
  return rows;
}

export async function readJsonl(path: string): Promise<unknown[]> {
  return parseJsonl(await readFile(path, "utf8"));
}

export function flattenGold(value: unknown): string[] {
  if (typeof value === "string") {
    const t = value.trim();
    return t ? [t] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(flattenGold);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenGold);
  return [];
}
