import { dirname, join } from "node:path";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseFrontmatter, serializeFrontmatter } from "../frontmatter.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { resolveNodeRelPath } from "../node/paths.ts";
import type { FileMutationExecutor } from "../write/executor.ts";
import { mkdirp } from "../util/fs.ts";
import {
  DIR_OVERVIEW_NAME,
  heuristicAbstract,
  heuristicOverview,
  isDerivedLayerFile,
  overviewSidecarRel,
} from "./generate.ts";

export interface RefreshLayersOptions {
  repoRoot: string;
  brainId: string;
  queue: FileMutationExecutor;
  /** 仓内相对或 brain 相对路径；缺省刷新整个 brain */
  path?: string;
  dirs?: boolean;
  /** capture auto：只写 L0 abstract */
  abstractOnly?: boolean;
}

export interface LayerUpdate {
  path: string;
  abstract?: boolean;
  overview?: boolean;
}

export interface RefreshLayersResult {
  updated: LayerUpdate[];
}

interface NodeMeta {
  rel: string;
  title: string;
}

function posixDir(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

async function walkMdFiles(dirAbs: string, baseRel: string, out: string[]): Promise<void> {
  if (!existsSync(dirAbs)) return;
  const entries = await readdir(dirAbs, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== DIR_OVERVIEW_NAME) continue;
    const childAbs = join(dirAbs, e.name);
    const childRel = `${baseRel}/${e.name}`.replace(/\\/g, "/");
    if (e.isDirectory()) {
      await walkMdFiles(childAbs, childRel, out);
    } else if (e.isFile() && e.name.endsWith(".md") && !isDerivedLayerFile(childRel)) {
      out.push(childRel);
    }
  }
}

async function collectTargets(
  repoRoot: string,
  brainId: string,
  path?: string,
): Promise<string[]> {
  if (path) {
    const rel = path.startsWith("brains/")
      ? resolveNodeRelPath(repoRoot, brainId, path)
      : resolveNodeRelPath(repoRoot, brainId, path);
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) return [];
    const st = await stat(abs);
    if (st.isFile()) {
      return isDerivedLayerFile(rel) ? [] : [rel];
    }
    const out: string[] = [];
    await walkMdFiles(abs, rel, out);
    return out;
  }
  const brainRel = `brains/${brainId}`;
  const out: string[] = [];
  await walkMdFiles(join(repoRoot, brainRel), brainRel, out);
  return out;
}

async function patchNodeLayers(
  repoRoot: string,
  rel: string,
  queue: FileMutationExecutor,
  opts: { abstract: string; overview?: string; sidecarRel?: string; sidecarBody?: string },
): Promise<void> {
  const written: string[] = [];
  await queue.execute(async () => {
    const abs = join(repoRoot, rel);
    const raw = await readFile(abs, "utf8");
    const { data, body } = parseFrontmatter(raw);
    const next: Record<string, unknown> = { ...data, abstract: opts.abstract };
    if (opts.overview != null) next.overview = opts.overview;
    if (opts.sidecarRel) next.overview_sidecar = opts.sidecarRel;
    await writeFile(abs, serializeFrontmatter(next, body), "utf8");
    written.push(rel);
    if (opts.sidecarRel && opts.sidecarBody != null) {
      const sideAbs = join(repoRoot, opts.sidecarRel);
      await mkdirp(dirname(sideAbs));
      await writeFile(sideAbs, opts.sidecarBody, "utf8");
      written.push(opts.sidecarRel);
    }
    return written;
  }, `layers ${rel}`);
}

async function writeDirOverview(
  repoRoot: string,
  dirRel: string,
  children: NodeMeta[],
  queue: FileMutationExecutor,
): Promise<string> {
  const outRel = `${dirRel}/${DIR_OVERVIEW_NAME}`.replace(/\\/g, "/");
  const dirName = dirRel.split("/").pop() ?? dirRel;
  const lines = children.map((c) => `- ${c.title}`);
  const body = `# ${dirName}\n\n${lines.join("\n")}\n`;
  const fm = {
    title: `overview: ${dirName}`,
    schema_type: "note",
    status: "active",
    created_by: "layers:refresh",
    created_at: new Date().toISOString(),
  };
  await queue.execute(async () => {
    const abs = join(repoRoot, outRel);
    await mkdirp(dirname(abs));
    await writeFile(abs, serializeFrontmatter(fm, body), "utf8");
    return [outRel];
  }, `layers dir ${outRel}`);
  return outRel;
}

/**
 * P5.2：为节点写入 L0 abstract / L1 overview；可选目录 `_overview.md`。
 * 失败不回滚已有 md（调用方按文件事务逐个 execute）。
 */
export async function refreshLayers(opts: RefreshLayersOptions): Promise<RefreshLayersResult> {
  const cfg = await loadRepoConfig(opts.repoRoot);
  const maxChars = cfg.layers.overview_max_chars;
  const targets = await collectTargets(opts.repoRoot, opts.brainId, opts.path);
  const updated: LayerUpdate[] = [];
  const metas: NodeMeta[] = [];

  for (const rel of targets) {
    const abs = join(opts.repoRoot, rel);
    const raw = await readFile(abs, "utf8");
    const { data, body } = parseFrontmatter(raw);
    const title = String(data.title ?? rel.split("/").pop() ?? rel);
    metas.push({ rel, title });

    const abstract = heuristicAbstract(body);
    const overview = heuristicOverview(body, maxChars);
    const fullBody = body.replace(/\r\n/g, "\n").trim();
    const needSidecar = !opts.abstractOnly && fullBody.length > maxChars;
    const sidecarRel = needSidecar ? overviewSidecarRel(rel) : undefined;

    await patchNodeLayers(opts.repoRoot, rel, opts.queue, {
      abstract,
      overview: opts.abstractOnly ? undefined : overview,
      sidecarRel,
      sidecarBody: needSidecar ? fullBody : undefined,
    });

    updated.push({
      path: rel,
      abstract: true,
      overview: opts.abstractOnly ? undefined : true,
    });
  }

  if (opts.dirs && cfg.layers.dir_aggregate) {
    const byDir = new Map<string, NodeMeta[]>();
    for (const m of metas) {
      const d = posixDir(m.rel);
      if (!d) continue;
      const list = byDir.get(d) ?? [];
      list.push(m);
      byDir.set(d, list);
    }
    for (const [dirRel, children] of byDir) {
      if (children.length < 2) continue;
      const outRel = await writeDirOverview(opts.repoRoot, dirRel, children, opts.queue);
      updated.push({ path: outRel, overview: true });
    }
  }

  return { updated };
}

/** capture `layers.auto`：只写 L0 abstract。 */
export async function maybeAutoAbstract(
  repoRoot: string,
  brainId: string,
  path: string,
  queue: FileMutationExecutor,
): Promise<LayerUpdate | undefined> {
  const cfg = await loadRepoConfig(repoRoot);
  if (!cfg.layers.auto) return undefined;
  const result = await refreshLayers({
    repoRoot,
    brainId,
    queue,
    path,
    abstractOnly: true,
  });
  return result.updated[0];
}

export function resolveBrainFileOrDir(repoRoot: string, brainId: string, input: string): string {
  return resolveNodeRelPath(repoRoot, brainId, input);
}
