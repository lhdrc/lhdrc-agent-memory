import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { FileMutationExecutor } from "../write/executor.ts";

function replaceSchemaPackLine(yml: string, packId: string): string {
  return yml.replace(/^schema_pack:.*$/m, `schema_pack: ${packId}`);
}

/** 更新 memory.yml 与 brain.yml 的 schema_pack 字段并提交。 */
export async function setSchemaPack(
  repoRoot: string,
  brainId: string,
  packId: string,
  executor: FileMutationExecutor,
): Promise<string[]> {
  return executor.execute(async () => {
    const memoryFile = join(repoRoot, "memory.yml");
    const brainFile = join(repoRoot, "brains", brainId, "brain.yml");
    const [memoryRaw, brainRaw] = await Promise.all([readFile(memoryFile, "utf8"), readFile(brainFile, "utf8")]);
    await Promise.all([
      writeFile(memoryFile, replaceSchemaPackLine(memoryRaw, packId), "utf8"),
      writeFile(brainFile, replaceSchemaPackLine(brainRaw, packId), "utf8"),
    ]);
    return ["memory.yml", `brains/${brainId}/brain.yml`];
  }, `schema use ${packId}`);
}
