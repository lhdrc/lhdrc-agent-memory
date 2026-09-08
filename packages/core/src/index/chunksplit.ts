/**
 * P14.3 简单 chunk 切分 — 纯新模块，不接线 sync.ts
 * 默认参数：maxChars=800, overlap=100, minChars=200
 * 签名保持与旧 chunkText(text, maxLen=800) 兼容，第三参数可选覆盖 overlap/minChars
 */
export const DEFAULT_MAX_CHARS = 800;
export const DEFAULT_OVERLAP = 100;
export const DEFAULT_MIN_CHARS = 200;
/** P14.3：切分版本，随 embedding-meta 落盘；变更即触发 mismatch → rebuild（存量不管）。 */
export const CHUNKER_VERSION = "p143-v1";

function normalize(text: string): string {
  let s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // URL 断行修复：https://xxx 后紧跟换行
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/(https?:\/\/[^\s\n]*)\n([^\s\n])/g, "$1$2");
    if (next === s) break;
    s = next;
  }
  // CJK 软换行合并：单换行在两端均为 CJK 时去掉换行；跨空行(\n\n)与列表项开头不合并
  // 列表项开头字符 '-', '*', '+', 数字等后续跟空格的不是 CJK，故不会匹配
  s = s.replace(
    /([\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\u3130-\u318F\uAC00-\uD7AF])\n(?=[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\u3130-\u318F\uAC00-\uD7AF])/g,
    "$1",
  );
  return s;
}

type Fence = { open: number; close: number };

function buildFences(text: string): Fence[] {
  const indices: number[] = [];
  let idx = 0;
  while (true) {
    const p = text.indexOf("```", idx);
    if (p === -1) break;
    indices.push(p);
    idx = p + 3;
  }
  const fences: Fence[] = [];
  for (let i = 0; i < indices.length; i += 2) {
    const open = indices[i]!;
    const closeIdx = indices[i + 1];
    if (closeIdx !== undefined) {
      fences.push({ open, close: closeIdx + 3 });
    } else {
      fences.push({ open, close: text.length });
    }
  }
  return fences;
}

function isInFence(pos: number, fences: Fence[]): boolean {
  for (const f of fences) {
    if (pos >= f.open && pos < f.close) return true;
  }
  return false;
}

function fenceContaining(pos: number, fences: Fence[]): Fence | null {
  for (const f of fences) {
    if (pos >= f.open && pos < f.close) return f;
  }
  return null;
}

function findCut(
  text: string,
  start: number,
  idealEnd: number,
  overlap: number,
  fences: Fence[],
): number | null {
  const searchStart = Math.max(start + 1, idealEnd - overlap);
  let bestNewline = -1;
  let bestCn = -1;
  let bestEn = -1;
  // scan from idealEnd-1 down to searchStart, nearest to idealEnd wins within priority
  for (let i = idealEnd - 1; i >= searchStart; i--) {
    // skip candidates inside fence
    if (isInFence(i + 1, fences) || isInFence(i, fences)) continue;
    const ch = text[i]!;
    if (ch === "\n") {
      if (bestNewline === -1) bestNewline = i + 1;
      // do not break; still need to see if even nearer newline exists - but we are scanning from nearest, so first found is nearest
      // we could break on first newline because priority is highest and we already have nearest
      // However to keep logic simple, break immediately when we find newline at earliest distance? Since priority is newline > cn > en, and we scan nearest first, first newline is optimal.
      break;
    } else if (ch === "。" || ch === "！" || ch === "？" || ch === "，") {
      if (bestCn === -1) bestCn = i + 1;
    } else if (ch === "." || ch === "!" || ch === "?") {
      const nxt = text[i + 1];
      if (nxt === undefined || /\s/.test(nxt)) {
        if (bestEn === -1) bestEn = i + 1;
      }
    }
  }
  if (bestNewline !== -1) return bestNewline;
  if (bestCn !== -1) return bestCn;
  if (bestEn !== -1) return bestEn;
  return null;
}

export function chunkText(
  text: string,
  maxLen = DEFAULT_MAX_CHARS,
  opts?: { overlap?: number; minChars?: number },
): string[] {
  const overlap = opts?.overlap ?? DEFAULT_OVERLAP;
  const minChars = opts?.minChars ?? DEFAULT_MIN_CHARS;
  const maxChars = maxLen;

  const normalized = normalize(text);
  if (normalized.length === 0) return [];
  if (normalized.length <= maxChars) return [normalized];

  const fences = buildFences(normalized);

  const chunks: string[] = [];
  const starts: number[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    const isLast = end >= normalized.length;

    if (!isLast) {
      if (isInFence(end, fences)) {
        const f = fenceContaining(end, fences);
        if (f) {
          if (f.open > start) {
            end = f.open;
          } else {
            // start inside fence — extend to fence close
            end = f.close;
            if (end <= start) end = Math.min(start + maxChars, normalized.length);
          }
        }
      } else {
        const cut = findCut(normalized, start, end, overlap, fences);
        if (cut !== null && cut > start && cut < end) {
          end = cut;
        }
      }

      // defence against zero progress after fence/cut adjustment
      if (end <= start) {
        end = Math.min(start + maxChars, normalized.length);
      }

      // 碎尾合并预判：下一块起始后剩余 < minChars，则把当前块扩展至末尾
      if (end < normalized.length) {
        const nextStart = end - overlap;
        if (nextStart > start) {
          const remaining = normalized.length - nextStart;
          if (remaining > 0 && remaining < minChars) {
            end = normalized.length;
          }
        } else if (nextStart <= start) {
          // overlap 导致不前进，说明 end 太小，放弃 overlap 一次
          // 保持 end 不变，下一次 start 将被强制推进
        }
      }
    }

    if (end <= start) end = Math.min(start + maxChars, normalized.length);
    const chunk = normalized.slice(start, end);
    chunks.push(chunk);
    starts.push(start);
    if (end >= normalized.length) break;
    const nextStart = end - overlap;
    // 强制推进，避免重复/停滞（回退过头场景）
    if (nextStart <= start) {
      start = end;
    } else {
      start = nextStart;
    }
    // safety: if overlap would cause infinite loop near end
    if (start >= normalized.length) break;
  }

  // 兜底：若尾块 < minChars 且块数>1，合并回上一块（按原文 slice 重建）
  if (chunks.length > 1) {
    const lastLen = chunks[chunks.length - 1]!.length;
    if (lastLen < minChars && lastLen > 0) {
      const lastStart = starts[starts.length - 1]!;
      const prevStart = starts[starts.length - 2]!;
      // 合并为从 prevStart 到末尾的一块
      const merged = normalized.slice(prevStart, normalized.length);
      chunks.splice(chunks.length - 2, 2, merged);
    }
  }

  return chunks;
}
