import { parse, stringify } from "yaml";

export interface ParsedMd {
  data: Record<string, unknown>;
  body: string;
  raw: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string): ParsedMd {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { data: {}, body: raw, raw };
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed = parse(match[1] ?? "");
    data = (parsed ?? {}) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { data, body: match[2] ?? "", raw };
}

export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const head = stringify(data).trimEnd();
  return `---\n${head}\n---\n\n${body}`;
}

export function hasValidFrontmatter(raw: string): boolean {
  return FRONTMATTER_RE.test(raw);
}
