import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanForIndex } from "../src/retrieve/clean.ts";
import { tokenizeMixed } from "../src/retrieve/tokenize.ts";
import { bigrams } from "../src/retrieve/ngrams.ts";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  openPglite,
  bm25Query,
} from "../src/index.ts";

const T = { timeout: 120_000 };

// helpers for P141 integration
let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}
async function capture(title: string, body: string, schemaType = "note") {
  const queue = await makeQueue();
  return captureNode(repoRoot, pack, queue, {
    brainId: "default",
    sourceId: "default",
    schemaType,
    title,
    body,
    createdBy: "cli:test",
  });
}

describe("P14.1 tokenizeMixed 单元", () => {
  test("P141-06 对称性：同一串摄入/检索分词输出一致", () => {
    const raw = "重试 retry P13.1 v2 Retry-Strategy";
    const cleaned = cleanForIndex(raw, "bm25");
    const a = tokenizeMixed(cleaned);
    const b = tokenizeMixed(cleanForIndex(raw, "bm25"));
    expect(a).toEqual(b);
    // 再次调用应稳定
    const c = tokenizeMixed(cleaned);
    expect(a.cjkBigrams).toBe(c.cjkBigrams);
    expect(a.enWords).toBe(c.enWords);
  });

  test("P141-06c cleanForIndex 补 toLowerCase", () => {
    const cleaned = cleanForIndex("Retry RETRY Ｒｅｔｒｙ", "bm25");
    expect(cleaned).toBe(cleaned.toLowerCase());
    expect(cleaned).toContain("retry");
    // 全角应已 NFKC 归一为半角并 lower
    expect(cleaned).not.toMatch(/[A-Z]/);
  });

  test("P141 单元 - 中文流仅汉字二元，英文不被打碎", () => {
    const cleaned = cleanForIndex("重试策略 retry strategy", "bm25");
    const { cjkBigrams, enWords } = tokenizeMixed(cleaned);
    // 中文 "重试策略" -> bigrams: 重试 试策 策略
    const expectedCjk = bigrams("重试策略");
    expect(cjkBigrams).toBe(expectedCjk);
    // 英文词不应被打成二元，应为单词
    expect(enWords.split(" ")).toContain("retry");
    expect(enWords.split(" ")).toContain("strategy");
    // 中文二元中不应含英文碎片 "re"
    expect(cjkBigrams.split(" ")).not.toContain("re");
  });

  test("P141 单元 - 连字符/下划线作分隔，双存整形+拆分", () => {
    const cleaned = cleanForIndex("Retry-Strategy test_123", "bm25");
    const { enWords } = tokenizeMixed(cleaned);
    const parts = enWords.split(" ");
    // 拆分后应含 retry strategy
    expect(parts).toContain("retry");
    expect(parts).toContain("strategy");
    // 整形应保留 retry-strategy（连字符在 clean 中保留）
    expect(parts).toContain("retry-strategy");
    // 下划线在 clean 阶段被视作 md 噪声空格化，拆分为 test + 123
    expect(parts).toContain("test");
    expect(parts).toContain("123");
    // 清洗后下划线消失，整形 test_123 不再保留（符合当前 clean 实现）
  });

  test("P141 单元 - 数字归英文流，字母数字混排整形+拆分双存", () => {
    const cleaned = cleanForIndex("P13.1 v2", "bm25");
    const { cjkBigrams, enWords } = tokenizeMixed(cleaned);
    // 中文流不应含数字
    expect(cjkBigrams).not.toMatch(/\d/);
    const parts = enWords.split(" ");
    // P13.1 整形
    expect(parts).toContain("p13.1");
    // 拆分部分应含 p13, 1 或 p,13,1 等
    expect(parts).toContain("p13");
    expect(parts).toContain("1");
    // v2 双存
    expect(parts).toContain("v2");
    expect(parts).toContain("v");
    expect(parts).toContain("2");
  });

  test("P141 单元 - 英文抽词中文按 Han 抽（含 ' 被清洗为空格）", () => {
    const cleaned = cleanForIndex("don't 重试", "bm25");
    const { enWords, cjkBigrams } = tokenizeMixed(cleaned);
    // clean 阶段 `'` 被视作非保留符号空格化，don't -> don t
    expect(cleaned).toBe("don t 重试");
    expect(enWords.split(" ")).toContain("don");
    expect(enWords.split(" ")).toContain("t");
    expect(cjkBigrams).toBe(bigrams("重试"));
  });

  test("P141 单元 - 数字归英文流独立", () => {
    const cleaned = cleanForIndex("超时 2s 5次", "bm25");
    const { enWords, cjkBigrams } = tokenizeMixed(cleaned);
    expect(enWords.split(" ")).toContain("2");
    expect(enWords.split(" ")).toContain("5");
    // 中文二元仅汉字
    expect(cjkBigrams).toBe(bigrams("超时次"));
  });
});

describe("P14.1 集成：bm25Query english 双路", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dfmem-p141-"));
    repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    pack = await loadPack("problem-tree");
  });

  test("P141-01 retrying 查 retries 命中（english 词干）及反向", async () => {
    const rel1 = await capture("retry doc", "we have many retries in system");
    const rel2 = await capture("retrying doc", "the service is retrying the request");
    const conn = await openPglite(repoRoot);
    try {
      const hitsA = await bm25Query(conn.db, { brainId: "default", query: "retrying", limit: 10 });
      expect(hitsA.some((h) => h.path === rel1)).toBe(true);
      const hitsB = await bm25Query(conn.db, { brainId: "default", query: "retries", limit: 10 });
      expect(hitsB.some((h) => h.path === rel2)).toBe(true);
    } finally {
      await conn.close();
    }
  }, T);

  test("P141-02 重试 retry 混合查询中英双召回", async () => {
    const relZh = await capture("重试策略", "重试改为固定3次");
    const relEn = await capture("retry strategy", "retry strategy fixed to 3 times");
    const conn = await openPglite(repoRoot);
    try {
      const hits = await bm25Query(conn.db, { brainId: "default", query: "重试 retry", limit: 10 });
      expect(hits.some((h) => h.path === relZh)).toBe(true);
      expect(hits.some((h) => h.path === relEn)).toBe(true);
    } finally {
      await conn.close();
    }
  }, T);

  test("P141-03 Retry/RETRY/全角大小写一致", async () => {
    const rel = await capture("retry doc", "Retry strategy documented");
    const conn = await openPglite(repoRoot);
    try {
      const hitsLower = await bm25Query(conn.db, { brainId: "default", query: "retry", limit: 10 });
      const hitsUpper = await bm25Query(conn.db, { brainId: "default", query: "RETRY", limit: 10 });
      const hitsFull = await bm25Query(conn.db, { brainId: "default", query: "ＲＥＴＲＹ", limit: 10 });
      const hasLower = hitsLower.some((h) => h.path === rel);
      const hasUpper = hitsUpper.some((h) => h.path === rel);
      const hasFull = hitsFull.some((h) => h.path === rel);
      expect(hasLower).toBe(true);
      expect(hasUpper).toBe(true);
      expect(hasFull).toBe(true);
    } finally {
      await conn.close();
    }
  }, T);

  test("P141-06 同一串摄入/检索分词输出一致（DB 物化一致）", async () => {
    const title = "Retry-Strategy P13.1";
    const body = "重试策略 v2 版本";
    const rel = await capture(title, body);
    const conn = await openPglite(repoRoot);
    try {
      const row = await conn.db.query<{ title_ngrams: string; body_ngrams: string; en_title: string; en_body: string; body_text: string }>(
        `SELECT title_ngrams, body_ngrams, en_title, en_body, body_text FROM pages WHERE path = $1`,
        [rel],
      );
      expect(row.rows.length).toBe(1);
      const r = row.rows[0]!;
      // 摄入侧分词基于 cleanForIndex(title/body_text)
      const cleanTitle = cleanForIndex(title, "bm25");
      const expectedTitle = tokenizeMixed(cleanTitle);
      expect(r.title_ngrams).toBe(expectedTitle.cjkBigrams);
      expect(r.en_title).toBe(expectedTitle.enWords);
      // body_text 是 buildMarkdownBody 后的存储正文（带 ## 摘要/正文），需用它来比对
      const cleanBodyStored = cleanForIndex(r.body_text, "bm25");
      const expBodyStored = tokenizeMixed(cleanBodyStored);
      expect(r.body_ngrams).toBe(expBodyStored.cjkBigrams);
      expect(r.en_body).toBe(expBodyStored.enWords);
      // 查询侧同一串的 tokenize 应一致
      const queryTokens = tokenizeMixed(cleanForIndex(title, "bm25"));
      expect(queryTokens.cjkBigrams).toBe(expectedTitle.cjkBigrams);
      expect(queryTokens.enWords).toBe(expectedTitle.enWords);
    } finally {
      await conn.close();
    }
  }, T);
});
