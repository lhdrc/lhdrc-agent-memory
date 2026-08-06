import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMemoryRepo, loadPack, WriteValidator } from "../src/index.ts";
import type { CreateNodeRequest } from "../src/write/types.ts";

let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-fmt-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

function req(overrides: Partial<CreateNodeRequest> = {}): CreateNodeRequest {
  return {
    brainId: "default",
    sourceId: "default",
    schemaType: "decision",
    title: "重试",
    body: "body",
    createdBy: "cli:test",
    ...overrides,
  };
}

describe("WRITE_FORMAT 校验（D14）", () => {
  test("缺 title → E_VALIDATION field=title", async () => {
    const r = await new WriteValidator(repoRoot, pack).validate(req({ title: "  " }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("E_VALIDATION");
      expect(r.errors.some((e) => e.field === "title")).toBe(true);
    }
  });

  test("schema_type 不在 pack → E_VALIDATION field=schema_type", async () => {
    const r = await new WriteValidator(repoRoot, pack).validate(req({ schemaType: "foobar" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("E_VALIDATION");
      expect(r.errors.some((e) => e.field === "schema_type")).toBe(true);
    }
  });

  test("source 非法 slug → E_VALIDATION", async () => {
    const r = await new WriteValidator(repoRoot, pack).validate(req({ sourceId: "Bad Source" }));
    expect(r.ok).toBe(false);
  });

  test("path 越出 source 根 → E_PATH_ESCAPE", async () => {
    const r = await new WriteValidator(repoRoot, pack).validate(
      req({ relativePath: "issues/general/decisions/../../../../../etc/x.md" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("E_PATH_ESCAPE");
  });

  test("body 超长 → E_VALIDATION", async () => {
    const r = await new WriteValidator(repoRoot, pack, { maxBodyChars: 10 }).validate(req({ body: "x".repeat(20) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "body")).toBe(true);
  });

  test("status 非法 → E_VALIDATION", async () => {
    const r = await new WriteValidator(repoRoot, pack).validate(req({ status: "deleted" as never }));
    expect(r.ok).toBe(false);
  });

  test("合法请求 → ok 且生成预期路径", async () => {
    const r = await new WriteValidator(repoRoot, pack).validate(
      req({ title: "支付网关超时", templateVars: { issue: "pay" } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized.path).toBe(
        "brains/default/sources/default/issues/pay/decisions/1-支付网关超时.md",
      );
      expect(r.normalized.frontmatter.title).toBe("支付网关超时");
    }
  });
});
