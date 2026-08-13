import { join } from "node:path";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { parseFrontmatter, serializeFrontmatter } from "../frontmatter.ts";
import type { FileMutationExecutor } from "./executor.ts";
import type { AuthContext } from "../auth/types.ts";
import { newLedgerEvent, writeLedgerLine } from "../events/ledger.ts";

function brainIdFromRel(relPath: string): string {
  const parts = relPath.replace(/\\/g, "/").split("/");
  if (parts[0] === "brains" && parts[1]) return parts[1];
  return "default";
}

/** D17 L3 软归档：改 status=archived，不删文件；记账 node_archived。 */
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
  const brainId = brainIdFromRel(relPath);
  await queue.execute(async () => {
    await writeFile(abs, serializeFrontmatter(data, body), "utf8");
    const evt = newLedgerEvent({
      type: "node_archived",
      by,
      from: relPath,
      payload: { path: relPath },
    });
    const ledgerRel = await writeLedgerLine(repoRoot, brainId, evt);
    return [relPath, ledgerRel];
  }, `forget ${relPath}`);
}

export function assertCanPurge(auth: AuthContext): void {
  if (auth.trustedLocal && auth.role === "owner") return;
  if (auth.role === "owner") return;
  throw new MemoryError(ErrorCodes.FORBIDDEN, "forget --purge 需要 owner");
}

/** D17 L3 硬删：物理删除文件 + node_purged；mode≠off 时独立 force commit。 */
export async function purgeNode(
  repoRoot: string,
  relPath: string,
  queue: FileMutationExecutor,
  by: string,
): Promise<void> {
  const abs = join(repoRoot, relPath);
  if (!existsSync(abs)) {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `节点不存在: ${relPath}`);
  }
  const brainId = brainIdFromRel(relPath);
  await queue.execute(
    async () => {
      await unlink(abs);
      const evt = newLedgerEvent({
        type: "node_purged",
        by,
        from: relPath,
        payload: { path: relPath },
      });
      const ledgerRel = await writeLedgerLine(repoRoot, brainId, evt);
      return [relPath, ledgerRel];
    },
    `purge ${relPath}`,
    { forceCommit: true, kind: "purge" },
  );
}
