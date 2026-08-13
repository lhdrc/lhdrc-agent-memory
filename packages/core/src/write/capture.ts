import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { serializeFrontmatter } from "../frontmatter.ts";
import type { SchemaPack } from "../schema/loadPack.ts";
import { mkdirp } from "../util/fs.ts";
import type { FileMutationExecutor } from "./executor.ts";
import { WriteValidator } from "./validator.ts";
import type { CreateNodeRequest, Fact } from "./types.ts";

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
  createdBy: string;
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
    templateVars: { issue: opts.issue ?? "general" },
    tags: opts.tags,
    aliases: opts.aliases,
    facts: opts.facts,
    createdBy: opts.createdBy,
  };
}

/** 校验并写入新节点（经写队列，ADD-only）。返回仓内相对路径。 */
export async function captureNode(
  repoRoot: string,
  pack: SchemaPack,
  queue: FileMutationExecutor,
  opts: CaptureOptions,
): Promise<string> {
  const req = await validateCaptureRequest(repoRoot, pack, opts);
  const validator = new WriteValidator(repoRoot, pack);
  const result = await validator.validate(req);
  if (!result.ok) {
    throw new MemoryError(result.code, result.errors.map((e) => `${e.field}: ${e.message}`).join("; "), {
      errors: result.errors,
    });
  }
  const n = result.normalized;
  const body = buildMarkdownBody(n.body);
  const relFromSource = n.pathFromBrain.split("/").slice(2).join("/");

  await queue.execute(
    async () => {
      const abs = join(repoRoot, n.path);
      if (existsSync(abs)) {
        throw new MemoryError(ErrorCodes.CONFLICT, `路径已存在（TOCTOU 复查）: ${n.path}`);
      }
      await mkdirp(dirname(abs));
      await writeFile(abs, serializeFrontmatter(n.frontmatter, body), "utf8");
      return [n.path];
    },
    `capture ${n.schemaType} ${relFromSource}`,
  );

  try {
    const { maybeAutoAbstract } = await import("../layers/refresh.ts");
    await maybeAutoAbstract(repoRoot, opts.brainId, n.path, queue);
  } catch {
    /* 富化失败不回滚已写 md（D1） */
  }

  return n.path;
}
