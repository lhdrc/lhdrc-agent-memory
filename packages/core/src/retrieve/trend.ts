import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseFrontmatter } from "../frontmatter.ts";
import { resolveBrainRoot } from "../repo/layout.ts";
import type { TrendConfig } from "../repo/config.ts";
import { DEFAULT_TREND_CONFIG } from "../repo/config.ts";

export interface TrendPoint {
  at: string;
  value: number;
  path: string;
  text: string;
}

export interface TrendResult {
  metric: string;
  points: TrendPoint[];
  regressing: boolean;
  drop: number;
  threshold: number;
  reason?: string;
}

export interface QueryTrendOptions {
  metric: string;
  threshold?: number;
  direction?: TrendConfig["direction"];
}

export function normalizeMetric(metric: string): string {
  return metric.trim().toLowerCase();
}

function sortKey(at: string, period?: unknown): string {
  if (period != null && String(period).trim()) return String(period).trim();
  return at;
}

function extractPoints(
  data: Record<string, unknown>,
  relPath: string,
  targetMetric: string,
): TrendPoint[] {
  const facts = data.facts;
  if (!Array.isArray(facts)) return [];
  const points: TrendPoint[] = [];
  for (const raw of facts) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    if (typeof f.metric !== "string") continue;
    if (normalizeMetric(f.metric) !== targetMetric) continue;
    if (f.value == null || !Number.isFinite(Number(f.value))) continue;
    const atRaw = f.at;
    const at = sortKey(String(atRaw ?? ""), f.period);
    if (!at) continue;
    points.push({
      at,
      value: Number(f.value),
      path: relPath.replace(/\\/g, "/"),
      text: String(f.text ?? ""),
    });
  }
  return points;
}

async function walkMd(dirAbs: string, baseRel: string, out: string[]): Promise<void> {
  const entries = await readdir(dirAbs, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const childAbs = join(dirAbs, e.name);
    const childRel = `${baseRel}/${e.name}`;
    if (e.isDirectory()) {
      await walkMd(childAbs, childRel, out);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(childRel);
    }
  }
}

async function collectMetricPoints(
  repoRoot: string,
  brainId: string,
  targetMetric: string,
): Promise<TrendPoint[]> {
  const brainRoot = resolveBrainRoot(repoRoot, brainId);
  const files: string[] = [];
  const sourceRoot = join(brainRoot, "sources");
  const sourceRel = `brains/${brainId}/sources`;
  if (existsSync(sourceRoot)) {
    await walkMd(sourceRoot, sourceRel, files);
  }
  const entityDir = join(brainRoot, "entities");
  if (existsSync(entityDir)) {
    for (const f of await readdir(entityDir)) {
      if (f.endsWith(".md")) files.push(`brains/${brainId}/entities/${f}`);
    }
  }

  const points: TrendPoint[] = [];
  for (const rel of files) {
    let raw: string;
    try {
      raw = await readFile(join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    const { data } = parseFrontmatter(raw);
    points.push(...extractPoints(data, rel, targetMetric));
  }
  points.sort((a, b) => a.at.localeCompare(b.at));
  return points;
}

function computeRegression(
  points: TrendPoint[],
  threshold: number,
  direction: TrendConfig["direction"],
): Pick<TrendResult, "regressing" | "drop" | "reason"> {
  if (points.length < 2) {
    return { regressing: false, drop: 0, reason: "insufficient" };
  }

  let newIdx = points.length - 1;
  let oldIdx = newIdx - 1;
  while (oldIdx >= 0 && points[oldIdx]!.value === 0) {
    newIdx = oldIdx;
    oldIdx = newIdx - 1;
  }
  if (oldIdx < 0 || newIdx <= oldIdx) {
    return { regressing: false, drop: 0, reason: "insufficient" };
  }

  const old = points[oldIdx]!;
  const newest = points[newIdx]!;
  let drop = (old.value - newest.value) / Math.abs(old.value);
  if (direction === "lower_is_better") drop = -drop;
  return { regressing: drop >= threshold, drop };
}

/** P9.5：扫 sources/** 与 entities/*.md 的 facts，检测 metric 趋势。 */
export async function queryTrend(
  repoRoot: string,
  brainId: string,
  opts: QueryTrendOptions,
  trendCfg: TrendConfig = DEFAULT_TREND_CONFIG,
): Promise<TrendResult> {
  const metric = normalizeMetric(opts.metric);
  const threshold = opts.threshold ?? trendCfg.threshold;
  const direction = opts.direction ?? trendCfg.direction;
  const points = await collectMetricPoints(repoRoot, brainId, metric);
  const { regressing, drop, reason } = computeRegression(points, threshold, direction);
  return {
    metric: opts.metric.trim(),
    points,
    regressing,
    drop,
    threshold,
    ...(reason ? { reason } : {}),
  };
}
