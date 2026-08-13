/**
 * P3.3 隔离 fuzz：跨 brain/source 零泄漏（CI required）。
 * 权威：specs/三期/P3.3-multitenant.md §5
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  createBrain,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  openPglite,
  hybridQuery,
  readNode,
  listTree,
  authorize,
  issueToken,
  sha256Token,
  responseContainsSecret,
  listVisibleSharedSkills,
  loadBrainConfig,
  MemoryError,
  ErrorCodes,
  resolveNodeRelPath,
  registerAgent,
  applyAgentScope,
  assertSourceScope,
} from "../src/index.ts";

const T = { timeout: 120_000 };

const SECRET_A = "SECRET_ALPHA_7f3a9c2e";
const SECRET_B = "SECRET_BRAVO_1d8b4e6f";

let dir: string;
let repoRoot: string;
let tokenARaw: string;

async function writeAuthYml(repoRoot: string, tokenRaw: string, tokenId: string) {
  const hash = `sha256:${sha256Token(tokenRaw)}`;
  const ymlPath = join(repoRoot, "memory.yml");
  let yml = await readFile(ymlPath, "utf8");
  if (!yml.includes("\nauth:")) {
    yml += `
auth:
  users:
    - id: alice
      role: member
      brains:
        brain-a:
          role: owner
          sources: ["*"]
  tokens:
    - id: ${tokenId}
      user: alice
      hash: "${hash}"
      brain: brain-a
`;
  }
  await writeFile(ymlPath, yml, "utf8");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-fuzz-"));
  repoRoot = await initMemoryRepo(dir, { brain: "brain-a", source: "default", force: false });
  await createBrain(repoRoot, "brain-b", { source: "default" });

  const issued = issueToken("alice", "brain-a");
  tokenARaw = issued.raw;
  await writeAuthYml(repoRoot, issued.raw, issued.id);

  const pack = await loadPack("problem-tree");
  const cfg = await loadRepoConfig(repoRoot);
  const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);

  await captureNode(repoRoot, pack, queue, {
    brainId: "brain-a",
    sourceId: "default",
    schemaType: "note",
    title: "Alpha Note",
    body: `payload ${SECRET_A}`,
    createdBy: "fuzz",
  });
  await captureNode(repoRoot, pack, queue, {
    brainId: "brain-b",
    sourceId: "default",
    schemaType: "note",
    title: "Bravo Note",
    body: `payload ${SECRET_B}`,
    createdBy: "fuzz",
  });

  // shared skill without mount on brain-a
  await mkdir(join(repoRoot, "shared", "skills", "shared-tool"), { recursive: true });
  await writeFile(
    join(repoRoot, "shared", "skills", "shared-tool", "SKILL.md"),
    `---
name: shared-tool
title: Shared Tool
schema_type: skill
status: active
trigger: shared
procedure: p
boundary: b
verification: v
---
## Procedure
shared body
`,
    "utf8",
  );
}, T);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("P3.3 isolation fuzz", () => {
  test("P33-01 无 token 的非 trusted 调用 → E_AUTH", () => {
    expect(() =>
      authorize({ channel: "remote", brainId: "brain-a", token: null }, { users: [], tokens: [] }),
    ).toThrow(MemoryError);
    try {
      authorize({ channel: "remote", brainId: "brain-a" }, { users: [], tokens: [] });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(MemoryError);
      expect((e as MemoryError).code).toBe(ErrorCodes.AUTH);
    }
  });

  test("P33-05 CLI 本地无 token 仍可操作", async () => {
    const cfg = await loadRepoConfig(repoRoot);
    const ctx = authorize({ channel: "cli", brainId: "brain-a" }, cfg.auth);
    expect(ctx.trustedLocal).toBe(true);
    expect(ctx.role).toBe("owner");
  });

  test(
    "P33-02 A token 读 B path → 无内容泄漏",
    async () => {
      const cfg = await loadRepoConfig(repoRoot);
      expect(() =>
        authorize(
          {
            channel: "remote",
            token: tokenARaw,
            brainId: "brain-b",
            path: `brains/brain-b/sources/default/notes/x.md`,
          },
          cfg.auth,
        ),
      ).toThrow(MemoryError);

      // token 授权 brain-a：query 不得命中 B secret
      const conn = await openPglite(repoRoot);
      try {
        const hits = await hybridQuery(conn.db, {
          brainId: "brain-a",
          query: SECRET_B,
          skipCache: true,
        });
        expect(responseContainsSecret(hits, SECRET_B)).toBe(false);

        const hitsA = await hybridQuery(conn.db, {
          brainId: "brain-a",
          query: SECRET_A,
          skipCache: true,
        });
        expect(hitsA.length).toBeGreaterThan(0);
        expect(responseContainsSecret(hitsA, SECRET_A)).toBe(true);
      } finally {
        await conn.close();
      }

      // 直接读 B path 应失败
      try {
        await readNode(repoRoot, "brain-a", `brains/brain-b/sources/default/notes/x.md`);
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(MemoryError);
        const code = (e as MemoryError).code;
        expect(code === ErrorCodes.FORBIDDEN || code === ErrorCodes.NOT_FOUND || code === ErrorCodes.PATH_ESCAPE).toBe(
          true,
        );
      }
    },
    T,
  );

  test(
    "P33-03 fuzz 100 变异全通过",
    async () => {
      const cfg = await loadRepoConfig(repoRoot);
      const mutations: string[] = [];
      for (let i = 0; i < 100; i++) {
        const kinds = [
          `../brain-b/sources/default/x.md`,
          `brains/brain-b/sources/default/secret.md`,
          `/brains/brain-b/sources/default/x.md`,
          `brains%2fbrain-b%2fsources%2fdefault%2fx.md`,
          `brains/brain-a/../brain-b/sources/default/x.md`,
          `brains/brain-b/../../etc/passwd`,
          `C:/brains/brain-b/x.md`,
          `brains/brain-b/sources/default/${"../".repeat((i % 5) + 1)}secret.md`,
          decodeURIComponent("%2e%2e/brain-b/sources/default/x.md"),
          `brains/brain-b/sources/default/${SECRET_B}.md`,
        ];
        mutations.push(kinds[i % kinds.length]!);
      }

      for (const path of mutations) {
        // authorize 应拒绝跨 brain / 非法路径
        let rejected = false;
        try {
          authorize(
            {
              channel: "remote",
              token: tokenARaw,
              brainId: "brain-a",
              path,
            },
            cfg.auth,
          );
          // 若 authorize 放行，resolveNodeRelPath 也必须拒绝跨 brain
          try {
            resolveNodeRelPath(repoRoot, "brain-a", path);
          } catch (e) {
            rejected = e instanceof MemoryError;
            if (rejected) {
              const code = (e as MemoryError).code;
              const allowed: string[] = [
                ErrorCodes.FORBIDDEN,
                ErrorCodes.PATH_ESCAPE,
                ErrorCodes.NOT_FOUND,
                ErrorCodes.USAGE,
              ];
              expect(allowed.includes(code)).toBe(true);
            }
          }
          // 若两者都放行，读内容不得含 SECRET_B
          if (!rejected) {
            try {
              const { raw } = await readNode(repoRoot, "brain-a", path);
              expect(responseContainsSecret(raw, SECRET_B)).toBe(false);
            } catch (e) {
              expect(e).toBeInstanceOf(MemoryError);
            }
          }
        } catch (e) {
          expect(e).toBeInstanceOf(MemoryError);
          const code = (e as MemoryError).code;
          const allowed: string[] = [ErrorCodes.AUTH, ErrorCodes.FORBIDDEN, ErrorCodes.PATH_ESCAPE];
          expect(allowed.includes(code)).toBe(true);
        }
      }
    },
    T,
  );

  test(
    "P5.5 agent×source：未登记 source → E_FORBIDDEN",
    async () => {
      const cfg = await loadRepoConfig(repoRoot);
      const agent = await registerAgent(repoRoot, "brain-a", { id: "bot", sources: ["default"] });
      const auth = authorize(
        { channel: "cli", token: tokenARaw, brainId: "brain-a", sourceId: "default" },
        cfg.auth,
      );
      const scoped = applyAgentScope(auth, agent);
      expect(scoped.agentId).toBe("bot");
      expect(scoped.allowedSources).toEqual(["default"]);
      expect(() => assertSourceScope(scoped, "default")).not.toThrow();
      expect(() => assertSourceScope(scoped, "other")).toThrow(MemoryError);
      try {
        assertSourceScope(scoped, "other");
      } catch (e) {
        expect((e as MemoryError).code).toBe(ErrorCodes.FORBIDDEN);
      }
    },
    T,
  );

  test(
    "P33-04 shared skills 未 mount 不可见",
    async () => {
      const brain = await loadBrainConfig(repoRoot, "brain-a");
      expect(brain.mounts?.some((m) => m.type === "shared_skills") ?? false).toBe(false);
      const visible = await listVisibleSharedSkills(repoRoot, brain);
      expect(visible.length).toBe(0);

      // mount 后可见
      const ymlPath = join(repoRoot, "brains", "brain-a", "brain.yml");
      let yml = await readFile(ymlPath, "utf8");
      yml += `\nmounts:\n  - type: shared_skills\n    path: shared/skills\n`;
      await writeFile(ymlPath, yml, "utf8");
      const mounted = await loadBrainConfig(repoRoot, "brain-a");
      const after = await listVisibleSharedSkills(repoRoot, mounted);
      expect(after.some((s) => s.name === "shared-tool")).toBe(true);
    },
    T,
  );

  test(
    "list/tree/query 不泄漏 B",
    async () => {
      const tree = await listTree(repoRoot, "brain-a", "");
      expect(responseContainsSecret(tree, SECRET_B)).toBe(false);

      const conn = await openPglite(repoRoot);
      try {
        const hits = await hybridQuery(conn.db, {
          brainId: "brain-a",
          query: "payload",
          skipCache: true,
        });
        expect(responseContainsSecret(hits, SECRET_B)).toBe(false);
      } finally {
        await conn.close();
      }
    },
    T,
  );
});
