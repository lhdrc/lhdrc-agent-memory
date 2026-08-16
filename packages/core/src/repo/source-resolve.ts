import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isSlug } from "../util/slug.ts";
import { loadBrainConfig, resolveSourceId, type BrainConfig } from "./brain.ts";

const SOURCE_PREFIX_RE = /^brains\/[^/]+\/sources\/([^/]+)\//;
const ENV_SOURCE = "DF_MEMORY_SOURCE";

export interface ResolveSourceIdFullInput {
  repoRoot: string;
  brainId: string;
  flag?: string | null;
  cwd?: string;
  path?: string;
  /** optional preloaded brain; else loadBrainConfig */
  brain?: BrainConfig;
}

function parseDotfileSource(content: string): string | null {
  for (const line of content.split("\n")) {
    const m = /^source_id:\s*(.+)$/.exec(line);
    if (m) {
      const id = m[1]!.trim();
      return isSlug(id) ? id : null;
    }
  }
  return null;
}

function toRepoRelativePosix(repoRoot: string, absPath: string): string | null {
  const root = resolve(repoRoot);
  const resolved = resolve(absPath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return null;
  }
  return relative(root, resolved).replace(/\\/g, "/");
}

function sourceFromPathPrefix(repoRoot: string, absPath: string): string | null {
  const rel = toRepoRelativePosix(repoRoot, absPath);
  if (!rel) return null;
  const normalized = rel.endsWith("/") ? rel : `${rel}/`;
  const m = SOURCE_PREFIX_RE.exec(normalized);
  if (!m) return null;
  const id = m[1]!;
  return isSlug(id) ? id : null;
}

async function readDotfileAt(dir: string): Promise<string | null> {
  const markerPath = join(dir, ".dfmemory-source");
  if (!existsSync(markerPath)) return null;
  try {
    const raw = await readFile(markerPath, "utf8");
    return parseDotfileSource(raw);
  } catch {
    return null;
  }
}

async function walkDotfileSource(repoRoot: string, startAbs: string): Promise<string | null> {
  const root = resolve(repoRoot);
  let dir = resolve(startAbs);
  if (!existsSync(dir) || !dir.startsWith(root)) {
    return null;
  }
  while (true) {
    const id = await readDotfileAt(dir);
    if (id) return id;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir || !parent.startsWith(root)) break;
    dir = parent;
  }
  return null;
}

function resolveWalkStart(p: string): string {
  const abs = resolve(p);
  try {
    if (statSync(abs).isFile()) return dirname(abs);
  } catch {
    /* use abs as-is */
  }
  return abs;
}

function resolveStartDir(cwd: string | undefined, path: string | undefined): string[] {
  const starts: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | undefined) => {
    if (!p) return;
    const dir = resolveWalkStart(p);
    if (seen.has(dir)) return;
    seen.add(dir);
    starts.push(dir);
  };
  add(cwd ?? process.cwd());
  add(path);
  return starts;
}

function soleNonDefaultSource(brain: BrainConfig): string | null {
  const keys = Object.keys(brain.sources ?? {}).filter((k) => k !== "default");
  if (keys.length !== 1) return null;
  const id = keys[0]!;
  return isSlug(id) ? id : null;
}

export async function resolveSourceIdFull(input: ResolveSourceIdFullInput): Promise<string> {
  const flag = input.flag?.trim();
  if (flag && isSlug(flag)) {
    return flag;
  }

  const env = process.env[ENV_SOURCE]?.trim();
  if (env && isSlug(env)) {
    return env;
  }

  for (const start of resolveStartDir(input.cwd, input.path)) {
    const fromDotfile = await walkDotfileSource(input.repoRoot, start);
    if (fromDotfile) return fromDotfile;
  }

  for (const start of resolveStartDir(input.cwd, input.path)) {
    const fromPrefix = sourceFromPathPrefix(input.repoRoot, start);
    if (fromPrefix) return fromPrefix;
  }

  const brain = input.brain ?? (await loadBrainConfig(input.repoRoot, input.brainId));
  const fromDefault = resolveSourceId(brain);
  if (fromDefault && fromDefault !== "default") {
    return fromDefault;
  }

  const sole = soleNonDefaultSource(brain);
  if (sole) return sole;

  return fromDefault ?? "default";
}
