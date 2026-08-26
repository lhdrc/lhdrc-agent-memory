import { newLedgerEvent, writeLedgerLine } from "../events/ledger.ts";
import { appendMemoryDiff, memoryDiffRel } from "../distill/memory-diff.ts";

/** P11.7：L0 新建同一写事务内记 memory_diff create + ledger node_created。 */
export async function recordL0Create(
  repoRoot: string,
  brainId: string,
  path: string,
  by: string,
): Promise<string[]> {
  const evt = newLedgerEvent({
    type: "node_created",
    by,
    from: path,
    payload: { path },
  });
  const ledgerRel = await writeLedgerLine(repoRoot, brainId, evt);
  const diff = await appendMemoryDiff(repoRoot, brainId, {
    op: "create",
    paths_written: [path],
    paths_readonly_refs: [],
    decision: { path },
    revert: { action: "none" },
  });
  return [ledgerRel, memoryDiffRel(brainId, diff.at)];
}
