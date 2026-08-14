/**
 * P7.3：每个 brain 至多一个打开中的滑动窗口指针。
 */
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, mkdirp } from "../util/fs.ts";
import { inboxSessionsRoot } from "./session.ts";

export function openPointerPath(repoRoot: string, brainId: string): string {
  return join(inboxSessionsRoot(repoRoot), brainId, ".open");
}

export async function readOpenSessionId(repoRoot: string, brainId: string): Promise<string | undefined> {
  const abs = openPointerPath(repoRoot, brainId);
  if (!existsSync(abs)) return undefined;
  const id = (await readFile(abs, "utf8")).trim();
  return id || undefined;
}

export async function writeOpenSessionId(repoRoot: string, brainId: string, sessionId: string): Promise<void> {
  const abs = openPointerPath(repoRoot, brainId);
  await mkdirp(join(inboxSessionsRoot(repoRoot), brainId));
  await atomicWriteFile(abs, `${sessionId}\n`);
}

export async function clearOpenSessionId(repoRoot: string, brainId: string): Promise<void> {
  const abs = openPointerPath(repoRoot, brainId);
  if (existsSync(abs)) await unlink(abs);
}

export async function clearOpenIfMatch(repoRoot: string, brainId: string, sessionId: string): Promise<void> {
  const cur = await readOpenSessionId(repoRoot, brainId);
  if (cur === sessionId) await clearOpenSessionId(repoRoot, brainId);
}
