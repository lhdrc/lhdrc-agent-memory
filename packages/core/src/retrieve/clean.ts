import { stripCodeBlocks } from "../graph/link-extraction.ts";

/**
 * P13.1 清洗：NFKC + lower + 去 markdown 噪音，B/C 分流
 * bm25: 重洗，去 code 内容；semantic: 轻洗保留句意
 */
export function cleanForIndex(text: string, mode: "bm25" | "semantic" = "bm25"): string {
  if (!text) return "";
  let t = text.normalize("NFKC");
  // strip code blocks: bm25 用空格替（已做），semantic 保留首行注释/函数名由上层决定，这里统一用空格替
  const { text: stripped } = stripCodeBlocks(t);
  t = stripped;

  // 去 markdown 图片/链接： ![alt](url) -> alt ; [text](url) -> text ; [[wikilink/path]] -> 取最后段； @slug 保留
  t = t.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  t = t.replace(/\[([^\]]*)\]\([^)]+\)/g, "$1");
  t = t.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const parts = String(inner).split("/");
    return parts[parts.length - 1] ?? inner;
  });
  // 去标题/引用/列表/表格线
  t = t.replace(/^[ \t]*#{1,6}[ \t]*/gm, "");
  t = t.replace(/^[ \t]*>[ \t]*/gm, "");
  t = t.replace(/^[ \t]*[-*][ \t]+/gm, "");
  t = t.replace(/\|/g, " ");
  t = t.replace(/---+/g, " ");
  // 去剩余 markdown 符号但保文字
  t = t.replace(/[`*_~]/g, " ");
  // NFKC 后空白归一
  t = t.replace(/\s+/g, " ").trim();
  // bm25 额外去 code 残留噪音（已由 stripCodeBlocks 空格替）
  if (mode === "bm25") {
    // 连续符号清理
    t = t.replace(/[^\p{L}\p{N}\s\-_.,!?，。！？、；：]/gu, " ");
    t = t.replace(/\s+/g, " ").trim();
  }
  return t;
}

/** 过滤跨词 bigram：简易词典法，保留词内 bigram，去跨词噪音如“试策/略调” */
export function filterCrossWordBigrams(bigrams: string, dict?: Set<string>): string {
  if (!bigrams) return bigrams;
  // 简易：若提供词典则过滤，否则保留全部（降噪在清洗阶段已通过空格隔断跨词）
  if (!dict || dict.size === 0) return bigrams;
  return bigrams
    .split(" ")
    .filter((g) => dict.has(g))
    .join(" ");
}
