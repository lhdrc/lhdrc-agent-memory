/**
 * P3.1 零 LLM 抽链：stripCodeBlocks → 四 pass + 动词推断 + frontmatter 合并。
 * 权威：specs/三期/P3.1-graph-signals.md §4
 */

export type LinkSource = "wikilink" | "markdown" | "mention" | "verb" | "path" | "frontmatter";

export interface ExtractedLink {
  to: string;
  type: string;
  source: LinkSource;
}

export interface ExtractOptions {
  /** 正文动词窗口推断（可覆盖） */
  verbPatterns?: Array<{ re: RegExp; type: string }>;
}

const DEFAULT_VERBS: Array<{ re: RegExp; type: string }> = [
  { re: /决定|decided/i, type: "decided" },
  { re: /产出|produced/i, type: "produced_by" },
  { re: /负责|works\s+on/i, type: "works_on" },
  { re: /属于/i, type: "belongs_to" },
];

interface MaskRange {
  start: number;
  end: number;
}

/** 用空格替换代码块/行内代码，保留偏移；返回 masked 文本与占用区间。 */
export function stripCodeBlocks(text: string): { text: string; masked: MaskRange[] } {
  const masked: MaskRange[] = [];
  let out = text;

  const pushMask = (start: number, end: number) => {
    masked.push({ start, end });
  };

  // fenced ``` ... ```
  out = out.replace(/```[\s\S]*?```/g, (m, offset: number) => {
    pushMask(offset, offset + m.length);
    return " ".repeat(m.length);
  });
  // inline `...`
  out = out.replace(/`[^`\n]+`/g, (m, offset: number) => {
    pushMask(offset, offset + m.length);
    return " ".repeat(m.length);
  });

  return { text: out, masked };
}

function overlaps(masked: MaskRange[], start: number, end: number): boolean {
  return masked.some((r) => start < r.end && end > r.start);
}

function markRange(claimed: MaskRange[], start: number, end: number): void {
  claimed.push({ start, end });
}

/** 在 match 附近窗口用动词正则推断 type；无命中则用 fallback。 */
export function inferLinkType(
  body: string,
  matchStart: number,
  matchEnd: number,
  fallback: string,
  verbs: Array<{ re: RegExp; type: string }> = DEFAULT_VERBS,
): string {
  const windowStart = Math.max(0, matchStart - 40);
  const windowEnd = Math.min(body.length, matchEnd + 40);
  const window = body.slice(windowStart, windowEnd);
  for (const v of verbs) {
    if (v.re.test(window)) return v.type;
  }
  return fallback;
}

function dedupeKey(l: ExtractedLink): string {
  return `${l.to}\0${l.type}`;
}

/**
 * 从正文 + frontmatter.links 抽取 typed links。
 * Pass1 markdown / Pass2 qualified wikilink / Pass3 wikilink / Pass4 @mention
 */
export function extractEntityRefs(
  body: string,
  frontmatterLinks?: Array<{ to?: unknown; type?: unknown; source?: unknown }> | null,
  opts?: ExtractOptions,
): ExtractedLink[] {
  const verbs = opts?.verbPatterns ?? DEFAULT_VERBS;
  const { text, masked } = stripCodeBlocks(body);
  const claimed: MaskRange[] = [...masked];
  const found: ExtractedLink[] = [];

  const tryAdd = (to: string, type: string, source: LinkSource, start: number, end: number) => {
    const ref = to.trim();
    if (!ref) return;
    if (overlaps(claimed, start, end)) return;
    markRange(claimed, start, end);
    found.push({ to: ref, type, source });
  };

  // Pass 1: markdown [text](path) — 排除 images ![
  {
    const re = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const target = m[2]!;
      if (/^(https?:|mailto:|#)/i.test(target)) continue;
      const start = m.index;
      const end = start + m[0].length;
      const type = inferLinkType(text, start, end, "references", verbs);
      tryAdd(target, type, "markdown", start, end);
    }
  }

  // Pass 2: qualified wikilink [[source/path]] or [[a/b/c]]
  {
    const re = /\[\[([^\]]+\/[^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const type = inferLinkType(text, start, end, "references", verbs);
      tryAdd(m[1]!, type, "wikilink", start, end);
    }
  }

  // Pass 3: simple wikilink [[title]]
  {
    const re = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const type = inferLinkType(text, start, end, "mentions", verbs);
      tryAdd(m[1]!, type, "wikilink", start, end);
    }
  }

  // Pass 4: @slug mention
  {
    const re = /@([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const type = inferLinkType(text, start, end, "mentions", verbs);
      tryAdd(m[1]!, type, "mention", start, end);
    }
  }

  // Merge frontmatter links
  if (Array.isArray(frontmatterLinks)) {
    for (const raw of frontmatterLinks) {
      const to = typeof raw?.to === "string" ? raw.to.trim() : "";
      if (!to) continue;
      const type = typeof raw?.type === "string" && raw.type ? raw.type : "references";
      found.push({ to, type, source: "frontmatter" });
    }
  }

  // 同 (from implied, to, type) 去重；保留首次（正文 pass 优先于 frontmatter 重复）
  const seen = new Set<string>();
  const out: ExtractedLink[] = [];
  for (const l of found) {
    const k = dedupeKey(l);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}
