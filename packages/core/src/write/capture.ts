import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { serializeFrontmatter } from "../frontmatter.ts";
import { createEntityRegistry } from "../entity/registry.ts";
import { linkifyBody } from "../compile/linkify.ts";
import type { SchemaPack } from "../schema/loadPack.ts";
import { mkdirp } from "../util/fs.ts";
import type { FileMutationExecutor } from "./executor.ts";
import { directGitExecutor } from "./executor.ts";
import { WriteValidator } from "./validator.ts";
import { applyIronLaw } from "./iron-law.ts";
import { recordL0Create } from "./l0-audit.ts";
import type { CreateNodeRequest, Fact, Link } from "./types.ts";

export interface CaptureOptions {
  brainId: string;
  sourceId: string;
  schemaType: string;
  title: string;
  body: string;
  issue?: string;
  tags?: string[];
  aliases?: string[];
  facts?: Fact[];
  links?: Link[];
  createdBy: string;
  /** 相对 source 根；缺省由 pack 模板生成 */
  relativePath?: string;
  /** 会话编译撞 path 时追加 -2、-3（P6.3）；人手 capture 默认关闭 */
  disambiguate?: boolean;
  /** P9.7 Iron Law；缺省用 directGitExecutor（compile 在 queue 内直写） */
  queue?: FileMutationExecutor;
  /** P13.3：可选 provenance，不进 content-hash */
  provenance?: { session_id: string; turns: number[]; history_ref: string };
}

/** WRITE_FORMAT §3：正文形状 = 摘要 + 正文；若 body 已含 ## 摘要 则不重复包裹。 */
export function buildMarkdownBody(body: string): string {
  if (/^##\s*摘要/m.test(body)) return body;
  const firstPara = body.split(/\n\s*\n/)[0]?.trim() ?? "";
  return `## 摘要\n\n${firstPara}\n\n## 正文\n${body}`;
}

export async function validateCaptureRequest(
  repoRoot: string,
  pack: SchemaPack,
  opts: CaptureOptions,
): Promise<CreateNodeRequest> {
  return {
    brainId: opts.brainId,
    sourceId: opts.sourceId,
    schemaType: opts.schemaType,
    title: opts.title,
    body: opts.body,
    relativePath: opts.relativePath,
    templateVars: { issue: opts.issue ?? "general" },
    tags: opts.tags,
    aliases: opts.aliases,
    facts: opts.facts,
    links: opts.links,
    createdBy: opts.createdBy,
  };
}

function sourceRelativeFromRepoRel(repoRel: string, brainId: string, sourceId: string): string {
  const prefix = `brains/${brainId}/sources/${sourceId}/`;
  const posix = repoRel.replace(/\\/g, "/");
  if (posix.startsWith(prefix)) return posix.slice(prefix.length);
  return posix;
}

function withNameSuffix(relFromSource: string, n: number): string {
  if (n <= 1) return relFromSource;
  return relFromSource.replace(/(\.md)$/i, `-${n}$1`);
}

function conflictPath(message: string): string | undefined {
  const m = message.match(/:\s*(\S+\.md)\s*$/);
  return m?.[1]?.replace(/\\/g, "/");
}

/**
 * 校验 + 写一颗 md（不持锁、不 enrich / layers.auto）。
 * 会话路径在 queue.execute 内多次调用；人手 captureNode 再包一层 execute。
 */
export async function captureWrite(
  repoRoot: string,
  pack: SchemaPack,
  opts: CaptureOptions,
): Promise<string> {
  const base = await validateCaptureRequest(repoRoot, pack, opts);
  const validator = new WriteValidator(repoRoot, pack);
  let relativePath = opts.relativePath;
  let attempt = 0;

  while (attempt < 32) {
    const req: CreateNodeRequest = { ...base, relativePath };
    const result = await validator.validate(req);
    if (!result.ok) {
      if (result.code === "E_CONFLICT" && opts.disambiguate) {
        attempt++;
        const existing = conflictPath(result.errors[0]?.message ?? "") ?? "";
        const fromSource = existing
          ? sourceRelativeFromRepoRel(existing, opts.brainId, opts.sourceId)
          : relativePath;
        if (!fromSource) {
          throw new MemoryError(result.code, result.errors.map((e) => `${e.field}: ${e.message}`).join("; "), {
            errors: result.errors,
          });
        }
        const baseName = fromSource.replace(/-\d+(\.md)$/i, "$1");
        relativePath = withNameSuffix(baseName, attempt + 1);
        continue;
      }
      throw new MemoryError(result.code, result.errors.map((e) => `${e.field}: ${e.message}`).join("; "), {
        errors: result.errors,
      });
    }

    const n = result.normalized;
    const entities = await createEntityRegistry(repoRoot, opts.brainId).list({ includeMerged: false });
    const linked = linkifyBody(n.body, entities);
    const existingLinks = Array.isArray(n.frontmatter.links) ? [...(n.frontmatter.links as Link[])] : [];
    const seen = new Set(existingLinks.map((l) => `${l.to}|${l.type}`));
    for (const l of linked.links) {
      const key = `${l.to}|${l.type}`;
      if (seen.has(key)) continue;
      existingLinks.push({ to: l.to, type: l.type, source: "mention" });
      seen.add(key);
    }
    n.frontmatter.links = existingLinks;
    if (opts.provenance) {
      n.frontmatter.provenance = opts.provenance;
    }
    const body = buildMarkdownBody(linked.body);
    const abs = join(repoRoot, n.path);
    if (existsSync(abs)) {
      if (opts.disambiguate) {
        attempt++;
        const fromSource = sourceRelativeFromRepoRel(n.path, opts.brainId, opts.sourceId);
        relativePath = withNameSuffix(fromSource.replace(/-\d+(\.md)$/i, "$1"), attempt + 1);
        continue;
      }
      throw new MemoryError(ErrorCodes.CONFLICT, `路径已存在（TOCTOU 复查）: ${n.path}`);
    }
    await mkdirp(dirname(abs));
    await writeFile(abs, serializeFrontmatter(n.frontmatter, body), "utf8");
    try {
      const ironQueue = opts.queue ?? directGitExecutor(repoRoot);
      await applyIronLaw(repoRoot, n.path, ironQueue, { brainId: opts.brainId });
    } catch {
      /* P9.7 fail-open */
    }
    return n.path;
  }

  throw new MemoryError(ErrorCodes.CONFLICT, `无法消解路径冲突: ${opts.title}`);
}

/** 校验并写入新节点（经写队列，ADD-only）。返回仓内相对路径。 */
export async function captureNode(
  repoRoot: string,
  pack: SchemaPack,
  queue: FileMutationExecutor,
  opts: CaptureOptions,
): Promise<string> {
  let written = "";
  await queue.execute(
    async () => {
      written = await captureWrite(repoRoot, pack, { ...opts, queue });
      const extra = await recordL0Create(repoRoot, opts.brainId, written, opts.createdBy);
      return [written, ...extra];
    },
    `capture ${opts.schemaType} ${opts.title}`,
  );

  try {
    const { maybeAutoAbstract } = await import("../layers/refresh.ts");
    await maybeAutoAbstract(repoRoot, opts.brainId, written, queue);
  } catch {
    /* 富化失败不回滚已写 md（D1） */
  }

  return written;
}
