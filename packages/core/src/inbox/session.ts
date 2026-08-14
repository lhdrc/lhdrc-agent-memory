import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { atomicWriteFile, mkdirp } from "../util/fs.ts";
import { assertUnderPrefix } from "../repo/layout.ts";
import { clearOpenIfMatch } from "./open.ts";

/** P6.2：inbox 是原文工作队列，不是 D1 记忆真相；丢 inbox 只丢未 compile 的原文。 */

export type TurnRole = "user" | "assistant" | "system" | "tool";

export type Turn = {
  role: TurnRole;
  text: string;
  at?: string;
};

export type InboxStatus = "pending" | "done" | "failed";

export type InboxMeta = {
  session_id: string;
  brain_id: string;
  source_id: string;
  created_at: string;
  status: InboxStatus;
  created_by: string;
  compiled_at?: string;
  kept_paths?: string[];
  /** P7.3 滑动窗口：打开中可 append */
  open?: boolean;
};

export type InboxFailed = {
  skipped: true;
  error: { code: string; message: string };
};

export type ExtractedCheckpointItem = {
  type: string;
  title: string;
  body: string;
  facts?: Array<{ text: string; attributed_to?: string }>;
  mentions?: string[];
  status: "pending" | "written";
  path?: string;
};

export type ExtractedCheckpointEntity = {
  slug: string;
  title: string;
  aliases?: string[];
  status: "pending" | "written";
};

export type ExtractedCheckpoint = {
  items: ExtractedCheckpointItem[];
  entities?: ExtractedCheckpointEntity[];
  truncated?: boolean;
};

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function inboxSessionsRoot(repoRoot: string): string {
  return join(repoRoot, ".dfmemory", "inbox", "sessions");
}

export function generateSessionId(now = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

export function assertSafeSessionId(sessionId: string): void {
  if (!sessionId || sessionId.includes("..") || sessionId.includes("/") || sessionId.includes("\\") || !SESSION_ID_RE.test(sessionId)) {
    throw new MemoryError(ErrorCodes.PATH_ESCAPE, `非法 sessionId: ${sessionId}`);
  }
}

export function sessionInboxDir(repoRoot: string, brainId: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  if (!brainId || brainId.includes("..") || brainId.includes("/") || brainId.includes("\\")) {
    throw new MemoryError(ErrorCodes.PATH_ESCAPE, `非法 brainId: ${brainId}`);
  }
  const root = inboxSessionsRoot(repoRoot);
  const brainDir = join(root, brainId);
  const dir = join(brainDir, sessionId);
  assertUnderPrefix(dir, brainDir);
  return dir;
}

function truncateToolText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

export async function archiveSession(opts: {
  repoRoot: string;
  brainId: string;
  sourceId: string;
  createdBy: string;
  turns: Turn[];
  sessionId?: string;
  toolMaxChars?: number;
}): Promise<{ sessionId: string; dir: string }> {
  const sessionId = opts.sessionId ?? generateSessionId();
  const dir = sessionInboxDir(opts.repoRoot, opts.brainId, sessionId);
  if (existsSync(dir)) {
    throw new MemoryError(ErrorCodes.CONFLICT, `inbox session 已存在: ${sessionId}`);
  }
  const maxTool = opts.toolMaxChars ?? 2000;
  const turns: Turn[] = opts.turns.map((t) => ({
    role: t.role,
    text: t.role === "tool" ? truncateToolText(t.text, maxTool) : t.text,
    ...(t.at ? { at: t.at } : {}),
  }));
  const meta: InboxMeta = {
    session_id: sessionId,
    brain_id: opts.brainId,
    source_id: opts.sourceId,
    created_at: new Date().toISOString(),
    status: "pending",
    created_by: opts.createdBy,
  };

  const tmp = `${dir}.tmp`;
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  await mkdirp(tmp);
  try {
    const lines = turns.map((t) => JSON.stringify(t)).join("\n") + (turns.length ? "\n" : "");
    await writeFile(join(tmp, "messages.jsonl"), lines, "utf8");
    await writeFile(join(tmp, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    await rename(tmp, dir);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return { sessionId, dir };
}

async function readTurns(dir: string): Promise<Turn[]> {
  const raw = await readFile(join(dir, "messages.jsonl"), "utf8");
  const turns: Turn[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    turns.push(JSON.parse(line) as Turn);
  }
  return turns;
}

export async function loadSession(
  repoRoot: string,
  brainId: string,
  sessionId: string,
): Promise<{ meta: InboxMeta; turns: Turn[]; dir: string }> {
  const dir = sessionInboxDir(repoRoot, brainId, sessionId);
  const metaAbs = join(dir, "meta.json");
  if (!existsSync(metaAbs)) {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `inbox session 不存在: ${sessionId}`);
  }
  const meta = JSON.parse(await readFile(metaAbs, "utf8")) as InboxMeta;
  const turns = await readTurns(dir);
  return { meta, turns, dir };
}

export async function writeExtracted(
  repoRoot: string,
  brainId: string,
  sessionId: string,
  checkpoint: ExtractedCheckpoint,
): Promise<void> {
  const dir = sessionInboxDir(repoRoot, brainId, sessionId);
  await atomicWriteFile(join(dir, "extracted.json"), `${JSON.stringify(checkpoint, null, 2)}\n`);
}

export async function loadExtracted(
  repoRoot: string,
  brainId: string,
  sessionId: string,
): Promise<ExtractedCheckpoint | null> {
  const abs = join(sessionInboxDir(repoRoot, brainId, sessionId), "extracted.json");
  if (!existsSync(abs)) return null;
  return JSON.parse(await readFile(abs, "utf8")) as ExtractedCheckpoint;
}

export async function markDone(
  repoRoot: string,
  brainId: string,
  sessionId: string,
  keptPaths: string[],
): Promise<void> {
  const { meta, dir } = await loadSession(repoRoot, brainId, sessionId);
  meta.status = "done";
  meta.compiled_at = new Date().toISOString();
  meta.kept_paths = keptPaths;
  meta.open = false;
  await atomicWriteFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  const failed = join(dir, "failed.json");
  if (existsSync(failed)) await unlink(failed);
  await clearOpenIfMatch(repoRoot, brainId, sessionId);
}

export async function markFailed(
  repoRoot: string,
  brainId: string,
  sessionId: string,
  error: { code: string; message: string },
  keptPaths?: string[],
): Promise<void> {
  const { meta, dir } = await loadSession(repoRoot, brainId, sessionId);
  meta.status = "failed";
  meta.compiled_at = new Date().toISOString();
  meta.open = false;
  if (keptPaths) meta.kept_paths = keptPaths;
  await atomicWriteFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  const failed: InboxFailed = { skipped: true, error };
  await atomicWriteFile(join(dir, "failed.json"), `${JSON.stringify(failed, null, 2)}\n`);
  await clearOpenIfMatch(repoRoot, brainId, sessionId);
}

export async function clearFailed(
  repoRoot: string,
  brainId: string,
  sessionId: string,
): Promise<void> {
  const { meta, dir } = await loadSession(repoRoot, brainId, sessionId);
  meta.status = "pending";
  delete meta.compiled_at;
  await atomicWriteFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  const failed = join(dir, "failed.json");
  if (existsSync(failed)) await unlink(failed);
}

export async function listInbox(repoRoot: string, brainId: string, status?: InboxStatus): Promise<InboxMeta[]> {
  const brainDir = join(inboxSessionsRoot(repoRoot), brainId);
  if (!existsSync(brainDir)) return [];
  const entries = await readdir(brainDir, { withFileTypes: true });
  const out: InboxMeta[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.endsWith(".tmp")) continue;
    const metaAbs = join(brainDir, e.name, "meta.json");
    if (!existsSync(metaAbs)) continue;
    try {
      const meta = JSON.parse(await readFile(metaAbs, "utf8")) as InboxMeta;
      if (status && meta.status !== status) continue;
      out.push(meta);
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return out;
}

export function countUserAssistant(turns: Turn[]): { turns: number; chars: number } {
  let n = 0;
  let chars = 0;
  for (const t of turns) {
    if (t.role !== "user" && t.role !== "assistant") continue;
    n++;
    chars += t.text.length;
  }
  return { turns: n, chars };
}

export async function appendTurnsToSession(opts: {
  repoRoot: string;
  brainId: string;
  sessionId: string;
  turns: Turn[];
  toolMaxChars?: number;
}): Promise<Turn[]> {
  const { meta, turns, dir } = await loadSession(opts.repoRoot, opts.brainId, opts.sessionId);
  if (meta.status !== "pending") {
    throw new MemoryError(ErrorCodes.CONFLICT, `inbox session 不可 append（status=${meta.status}）: ${opts.sessionId}`);
  }
  const maxTool = opts.toolMaxChars ?? 2000;
  const mapped: Turn[] = opts.turns.map((t) => ({
    role: t.role,
    text: t.role === "tool" ? (t.text.length > maxTool ? t.text.slice(0, maxTool) : t.text) : t.text,
    ...(t.at ? { at: t.at } : {}),
  }));
  if (mapped.length > 0) {
    const extra = mapped.map((t) => JSON.stringify(t)).join("\n") + "\n";
    await appendFile(join(dir, "messages.jsonl"), extra, "utf8");
  }
  meta.open = true;
  await atomicWriteFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return [...turns, ...mapped];
}

export async function patchSessionOpen(
  repoRoot: string,
  brainId: string,
  sessionId: string,
  open: boolean,
): Promise<void> {
  const { meta, dir } = await loadSession(repoRoot, brainId, sessionId);
  meta.open = open;
  await atomicWriteFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}
