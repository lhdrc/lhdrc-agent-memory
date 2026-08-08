import { describe, expect, test } from "bun:test";
import { extractEntityRefs, stripCodeBlocks } from "../src/graph/link-extraction.ts";

describe("P3.1 extractEntityRefs", () => {
  test("P31-02 代码块内 wikilink 不建边", () => {
    const body = ["前言 [[alice]]", "```", "code [[bob]]", "```", "结尾 @carol"].join("\n");
    const links = extractEntityRefs(body);
    const tos = links.map((l) => l.to);
    expect(tos).toContain("alice");
    expect(tos).toContain("carol");
    expect(tos).not.toContain("bob");
  });

  test("四 pass：markdown / qualified / wikilink / mention", () => {
    // 各 pass 分行并拉大间距，避免动词窗口串扰
    const body = [
      "见 [文档](sources/a/doc.md)",
      "",
      "",
      "路径 [[default/issues/x]]",
      "",
      "",
      "提到 [[alice]]",
      "",
      "",
      "联系 @bob",
    ].join("\n");
    const links = extractEntityRefs(body);
    expect(links.some((l) => l.to === "sources/a/doc.md" && l.source === "markdown")).toBe(true);
    expect(links.some((l) => l.to === "default/issues/x" && l.source === "wikilink")).toBe(true);
    expect(links.some((l) => l.to === "alice" && l.source === "wikilink")).toBe(true);
    expect(links.some((l) => l.to === "bob" && l.source === "mention")).toBe(true);
  });

  test("动词窗口推断 decided", () => {
    const body = "团队决定 [[retry-policy]] 为固定三次";
    const links = extractEntityRefs(body);
    expect(links[0]?.type).toBe("decided");
  });

  test("frontmatter links 合并去重", () => {
    const body = "提到 [[alice]]";
    const links = extractEntityRefs(body, [
      { to: "alice", type: "mentions" },
      { to: "pay", type: "references" },
    ]);
    expect(links.filter((l) => l.to === "alice").length).toBe(1);
    expect(links.some((l) => l.to === "pay" && l.source === "frontmatter")).toBe(true);
  });

  test("stripCodeBlocks 保留长度", () => {
    const raw = "a```\nx\n```b";
    const { text } = stripCodeBlocks(raw);
    expect(text.length).toBe(raw.length);
    expect(text.startsWith("a")).toBe(true);
    expect(text.endsWith("b")).toBe(true);
  });
});
