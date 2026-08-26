import { join, dirname } from "node:path";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { parseFrontmatter, serializeFrontmatter } from "../frontmatter.ts";
import type { SchemaPack } from "../schema/loadPack.ts";
import { mkdirp } from "../util/fs.ts";
import type { FileMutationExecutor } from "./executor.ts";
import { WriteValidator } from "./validator.ts";
import { recordL0Create } from "./l0-audit.ts";

export interface ImportOptions {
  brainId: string;
  sourceId: string;
  createdBy: string;
}

/** 导入单个 .md：需有合法 frontmatter 且含 schema_type。ADD-only。返回仓内相对路径。 */
export async function importNode(
  repoRoot: string,
  pack: SchemaPack,
  queue: FileMutationExecutor,
  filePath: string,
  opts: ImportOptions,
): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `导入文件不存在: ${filePath}`);
  }
  const { data, body } = parseFrontmatter(raw);
  const schemaType = data.schema_type as string | undefined;
  if (!schemaType || !pack.schema_types.includes(schemaType)) {
    throw new MemoryError(ErrorCodes.VALIDATION, `文件缺少合法 schema_type: ${filePath}`, { field: "schema_type" });
  }
  const title = ((data.title as string) ?? "").trim();
  const fmSource = data.source as string | undefined;
  const sourceId = opts.sourceId ?? fmSource ?? "default";
  const fmPath = data.path as string | undefined;

  let relativePath: string | undefined;
  if (fmPath) {
    const p = String(fmPath).replace(/\\/g, "/");
    const prefix = `sources/${sourceId}/`;
    relativePath = p.startsWith(prefix) ? p.slice(prefix.length) : p;
  }

  const req = {
    brainId: opts.brainId,
    sourceId,
    schemaType,
    title,
    relativePath,
    body,
    tags: Array.isArray(data.tags) ? (data.tags as string[]) : undefined,
    aliases: Array.isArray(data.aliases) ? (data.aliases as string[]) : undefined,
    facts: Array.isArray(data.facts) ? (data.facts as Array<{ text: string; event_type: string; attributed_to: string; at: string }>) : undefined,
    createdBy: opts.createdBy,
  };

  const validator = new WriteValidator(repoRoot, pack);
  const result = await validator.validate(req);
  if (!result.ok) {
    throw new MemoryError(result.code, `import ${filePath}: ${result.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`, {
      errors: result.errors,
    });
  }
  const n = result.normalized;

  await queue.execute(async () => {
    const abs = join(repoRoot, n.path);
    if (existsSync(abs)) {
      throw new MemoryError(ErrorCodes.CONFLICT, `路径已存在（ADD-only）: ${n.path}`);
    }
    await mkdirp(dirname(abs));
    await writeFile(abs, serializeFrontmatter(n.frontmatter, n.body), "utf8");
    const extra = await recordL0Create(repoRoot, opts.brainId, n.path, opts.createdBy);
    return [n.path, ...extra];
  }, `import ${n.pathFromBrain}`);
  return n.path;
}

export interface ImportedFile {
  sourcePath: string;
  destRel: string;
}

export async function importPath(
  repoRoot: string,
  pack: SchemaPack,
  queue: FileMutationExecutor,
  input: string,
  opts: ImportOptions,
): Promise<ImportedFile[]> {
  const s = await stat(input);
  if (s.isDirectory()) {
    const out: ImportedFile[] = [];
    const stack = [input];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      const entries = await readdir(dir);
      for (const e of entries) {
        const p = join(dir, e);
        const st = await stat(p);
        if (st.isDirectory()) stack.push(p);
        else if (e.endsWith(".md")) {
          out.push({ sourcePath: p, destRel: await importNode(repoRoot, pack, queue, p, opts) });
        }
      }
    }
    out.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    return out;
  }
  const destRel = await importNode(repoRoot, pack, queue, input, opts);
  return [{ sourcePath: input, destRel }];
}
