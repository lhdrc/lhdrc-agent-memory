import { describe, test, expect } from "bun:test";
import { chunkText } from "../src/index/chunksplit.ts";

// P14.3 TDD —先写失败用例

describe("P143 chunk split — P143-01 边界回溯", () => {
  test("P143-01a 超长段落在换行处断开，不在句中腰斩", () => {
    const para = "第一句内容。\n第二段内容很长\n".repeat(200);
    const text = para + "尾巴";
    const chunks = chunkText(text, 800);
    // 每个 chunk 除了最后一块，末尾应落在 换行或句末附近，而非任意字符中腰斩
    for (let i = 0; i < chunks.length - 1; i++) {
      const c = chunks[i]!;
      // chunk 应以换行或句末标点结尾（回溯找到边界），或至少长度<=800
      const endsAtBoundary = /[\n。！？.!?]$/.test(c.trimEnd().slice(-1)) || c.endsWith("\n") || /[。！？]$/.test(c.trimEnd().slice(-1));
      // 更宽松：检查不在句子中间——即不应出现被硬切的中英文混杂（用长度判断：若纯英文无标点则允许硬切，但本例有边界应优先边界）
      expect(endsAtBoundary).toBe(true);
      expect(c.length).toBeLessThanOrEqual(800);
    }
  });

  test("P143-01b 中文句末优先于硬切", () => {
    // 800 字符内全是 中文句子以 。 结尾，若硬切会在句中，随机构建 2000 字符
    const sentence = "这是一个完整的中文句子。";
    const text = sentence.repeat(200); // 11*200=2200
    const chunks = chunkText(text, 800);
    // 每个非尾块应以 。 结尾（中文句末）
    for (let i = 0; i < chunks.length - 1; i++) {
      const trimmed = chunks[i]!.trimEnd();
      expect(trimmed.endsWith("。")).toBe(true);
    }
  });

  test("P143-01c 英文句末 .!? 仅当后接空白或结尾时才算边界，防切 URL 域名点", () => {
    // 构造包含 URL 且超长的文本
    const url = "https://example.com/path?x=1";
    const filler = "Hello world. ".repeat(100) + url + " " + "Another sentence. ".repeat(100);
    const text = filler.repeat(3); // 确保超长
    const chunks = chunkText(text, 800);
    // 至少存在一个 chunk 切点落在英文句末 ". " 之后，而非 URL 内部的点
    // 验证 URL 未被切裂（完整出现在某块中）
    const joined = chunks.join("|||");
    // URL 点后无空格，若切点错误，会把 URL 拆到两块的边界处（即一块以 example. 结尾）
    // 检查没有任何块以 "example." 结尾（那说明在域名点误切）
    for (const c of chunks) {
      expect(c.trimEnd().endsWith("example.")).toBe(false);
    }
    // 且 URL 应完整存在于至少一块中
    expect(chunks.some((c) => c.includes(url))).toBe(true);
  });

  test("P143-01d 回溯距离 ≤ overlap（100），过远则硬切", () => {
    // 构造：前 700 字符为无边界的 'a'，中间有一个换行在距离 idealEnd 超过 100 远的位置，应被忽略而硬切
    const noBoundary = "a".repeat(700);
    const farNewline = "\n";
    const after = "b".repeat(700);
    // start=0, maxLen=800, overlap=100, idealEnd=800
    // 换行在 700 位置，距离 idealEnd=100，恰好在边界；再远一个：把换行放在 650 处距离150>100，应不回溯
    const textFar = "a".repeat(650) + farNewline + "a".repeat(150) + "c".repeat(1000);
    const chunksFar = chunkText(textFar, 800);
    // 若回溯距离>overlap应硬切，则首块长度应为800（硬切）而非650
    expect(chunksFar[0]!.length).toBe(800);
    // 反例：换行在 750 处距离50≤100，应回溯到换行
    const textNear = "a".repeat(750) + farNewline + "b".repeat(1000);
    const chunksNear = chunkText(textNear, 800);
    expect(chunksNear[0]!.length).toBe(751); // 包含换行符
  });
});

describe("P143-02 normalize 与围栏", () => {
  test("P143-02a 去 \\r", () => {
    const text = "a\r\nb\rc\nd";
    const chunks = chunkText(text, 800);
    expect(chunks.join("")).not.toContain("\r");
    expect(chunks.join("")).toContain("a\nb\nc\nd");
  });

  test("P143-02b URL 断行修复", () => {
    const text = "visit https://example.com/very\nlong\npath here and more text " + "x".repeat(1000);
    const chunks = chunkText(text, 800);
    // normalize 后 URL 的断行应被修复，块中应出现完整 URL 片段而非带换行的
    expect(chunks.some((c) => c.includes("https://example.com/verylongpath"))).toBe(true);
    // 不应残留 URL 中间的换行切裂
    expect(chunks.some((c) => c.includes("https://example.com/very\nlong"))).toBe(false);
  });

  test("P143-02c CJK 软换行合并：商\\n保通 → 商保通", () => {
    const text = "商\n保通";
    const chunks = chunkText(text, 800);
    expect(chunks[0]).toBe("商保通");
  });

  test("P143-02d CJK 跨空行不合并", () => {
    const text = "商\n\n保通";
    const chunks = chunkText(text, 800);
    expect(chunks[0]).toBe("商\n\n保通");
  });

  test("P143-02e CJK 列表项开头不合并", () => {
    const text = "商\n- 保通";
    const chunks = chunkText(text, 800);
    expect(chunks[0]).toBe("商\n- 保通");
    const text2 = "测试\n* 列表项";
    expect(chunkText(text2, 800)[0]).toBe("测试\n* 列表项");
  });

  test("P143-02f ``` 围栏内无切点", () => {
    const intro = "intro ".repeat(120); // ~720
    const fenceInner = "code line inside fence\n".repeat(80); // ~1840
    const fenced = "```\n" + fenceInner + "```\n";
    const outro = "outro ".repeat(400);
    const text = intro + fenced + outro;
    const chunks = chunkText(text, 800);
    // 按实际切片位置校验切点不在围栏内
    function isInsideFence(pos: number, full: string): boolean {
      const upTo = full.slice(0, pos);
      const fenceCount = (upTo.match(/```/g) || []).length;
      return fenceCount % 2 === 1;
    }
    // 通过在原文本中顺序定位每个 chunk 的起点，得到真实 cutPos
    let searchFrom = 0;
    for (let i = 0; i < chunks.length - 1; i++) {
      const c = chunks[i]!;
      const startIdx = text.indexOf(c.slice(0, 20), searchFrom);
      // 回退：如果含重叠导致起点的 20 字符在多处出现，改用逐步推进校验
      const cutPos = startIdx !== -1 ? startIdx + c.length : searchFrom + c.length;
      expect(isInsideFence(cutPos, text)).toBe(false);
      // 下一块起点应为 cutPos - overlap 附近，更新 searchFrom 为下一起点近似
      searchFrom = cutPos - 100;
      if (searchFrom < 0) searchFrom = 0;
    }
    // 围栏不应被腰斩：至少有一个 chunk 完整包含 fenceInner 的大部分
    expect(chunks.some((c) => c.includes("code line inside fence"))).toBe(true);
    // 且不应出现某块在 fence 打开后却未包含闭合 ``` 就被切断的情况通过切点不在围栏内已保证
  });
});

describe("P143-03 overlap 与碎尾合并", () => {
  test("P143-03a 相邻块有 overlap=100", () => {
    const text = "x".repeat(2000); // 无边界，硬切
    const chunks = chunkText(text, 800);
    expect(chunks.length).toBeGreaterThan(1);
    // 首块 800，次块起点 700，检查重叠
    expect(chunks[0]!.length).toBe(800);
    const overlapSlice = chunks[0]!.slice(-100);
    expect(chunks[1]!.slice(0, 100)).toBe(overlapSlice);
    // 所有相邻块都有重叠
    for (let i = 0; i < chunks.length - 1; i++) {
      const a = chunks[i]!;
      const b = chunks[i + 1]!;
      // b 的前缀应等于 a 的后缀（至少 overlap 长度的重叠存在于原文本的连续性）
      // 由于硬切时 overlap 精确 100，可直接校验
      expect(b.slice(0, 100)).toBe(a.slice(-100));
    }
  });

  test("P143-03b 尾巴 < minChars(200) 被合并，无孤块", () => {
    const text = "y".repeat(950);
    const chunks = chunkText(text, 800);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.length).toBeGreaterThanOrEqual(200);
    }
    // 900: nextStart=700, tail 200 (>=200) 不合并，应有2块，最后一块200
    const text900 = "z".repeat(900);
    const chunks900 = chunkText(text900, 800);
    expect(chunks900.length).toBe(2);
    expect(chunks900[1]!.length).toBeGreaterThanOrEqual(200);
    // 950 -> tail 250 >=200 不合并，应有2块
    const ch950 = chunkText("a".repeat(950), 800);
    expect(ch950.length).toBe(2);
    // 850: nextStart=700, tail 150 <200 应合并为1块
    const ch850 = chunkText("a".repeat(850), 800);
    expect(ch850.length).toBe(1);
    expect(ch850[0]!.length).toBe(850);
    // 更长多块场景：所有尾块均 >=200
    const long = "b".repeat(5000);
    const chLong = chunkText(long, 800);
    for (let i = 1; i < chLong.length; i++) expect(chLong[i]!.length).toBeGreaterThanOrEqual(200);
  });

  test("P143-03c 首块不足 minChars 除外", () => {
    const text = "short";
    const chunks = chunkText(text, 800);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe("short");
  });

  test("默认参数 maxChars=800 overlap=100 minChars=200", () => {
    // 验证未传参时行为与显式 800 一致，且 overlap 默认 100
    const text = "q".repeat(2000);
    const def = chunkText(text);
    const explicit = chunkText(text, 800);
    expect(def).toEqual(explicit);
    expect(def[0]!.length).toBe(800);
    expect(def[1]!.slice(0, 100)).toBe(def[0]!.slice(-100));
  });
});
