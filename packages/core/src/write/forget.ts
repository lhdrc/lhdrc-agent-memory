import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { parseFrontmatter, serializeFrontmatter } from "../frontmatter.ts";
import type { FileMutationExecutor } from "./executor.ts";

/** D17 L3 软归档：改 status=archived，不删文件。 */
export async function forgetNode(
  repoRoot: string,
  relPath: string,
  queue: FileMutationExecutor,
  by: string,
): Promise<void> {
  const abs = join(repoRoot, relPath);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `节点不存在: ${relPath}`);
  }
  const { data, body } = parseFrontmatter(raw);
  data.status = "archived";
  data.archived_at = new Date().toISOString();
  data.archived_by = by;
  await queue.execute(async () => {
    await writeFile(abs, serializeFrontmatter(data, body), "utf8");
    return [relPath];
  }, `forget ${relPath}`);
}
