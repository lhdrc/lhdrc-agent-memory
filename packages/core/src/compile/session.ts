import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { packageRootFrom } from "../util/here.ts";
import { createEntityRegistry, EntityRegistryImpl } from "../entity/registry.ts";
import type { Entity } from "../entity/types.ts";
import { createLLMProvider, isCompileEnabled } from "../llm/factory.ts";
import type { LLMProvider } from "../llm/types.ts";
import { wouldExceedCap } from "../cost/logger.ts";
import { loadRepoConfig, type RepoConfig } from "../repo/config.ts";
import type { SchemaPack } from "../schema/loadPack.ts";
import type { FileMutationExecutor } from "../write/executor.ts";
import { captureWrite, buildMarkdownBody, type CaptureOptions } from "../write/capture.ts";
import { recordL0Create } from "../write/l0-audit.ts";
import { checkDedupe } from "../write/dedupe.ts";
import { todayUtc, sanitizeFactSupersedes } from "../write/validator.ts";
import type { Fact, Link } from "../write/types.ts";
import {
  archiveSession,
  clearFailed,
  loadExtracted,
  loadSession,
  markDone,
  markFailed,
  writeExtracted,
  type ExtractedCheckpoint,
  type ExtractedCheckpointItem,
  type ExtractedCheckpointEntity,
  type Turn,
} from "../inbox/session.ts";
import { linkifyBody } from "./linkify.ts";
import { prefetchExistingMemories } from "./prefetch.ts";
import { maybeLazyDistillAfterCompile } from "../distill/refine.ts";
import {
  checkSourceTurns,
  formatCompileUserPrompt,
  JSON_REPAIR_SUFFIX,
  numberedTurnCount,
  parseCompleteExtractJson,
  prefetchQueryText,
  stripTurnsContext,
  truncateTurns,
  normalizeProposedEntities,
  type ProposedEntity,
} from "./parse.ts";

const PROMPT_PATH = join(packageRootFrom(import.meta.url), "resources/session-extract-v1.md");
const ALLOWED_TYPES = new Set(["decision", "lesson", "note"]);

export type CompileDroppedReason = "duplicate" | "noise" | "empty";

export type CompileResult = {
  session_id?: string;
  kept: Array<{ type: string; title: string; path?: string; links?: Array<{ to: string }> }>;
  dropped: Array<{ reason: CompileDroppedReason; excerpt: string }>;
  unresolved: string[];
  errors: Array<{ message: string; code?: string }>;
  skipped_reason?: string;
  truncated?: boolean;
  distill?: { written: number; lazy_omitted?: number; crystallized?: string[]; error?: string };
  entities_created?: string[];
};

export type CompileSessionOpts = {
  repoRoot: string;
  brainId: string;
  sourceId: string;
  createdBy: string;
  pack: SchemaPack;
  queue: FileMutationExecutor;
  turns?: Turn[];
  sessionId?: string;
  dryRun?: boolean;
  noExtract?: boolean;
  llm?: LLMProvider;
  captureWriteFn?: typeof captureWrite;
};

let promptCache: string | undefined;

export async function loadSessionExtractPrompt(): Promise<string> {
  promptCache ??= await readFile(PROMPT_PATH, "utf8");
  return promptCache;
}

function excerptOf(s: string, n = 80): string {
  return s.replace(/\s+/g, " ").trim().slice(0, n);
}

function bodyCore(body: string): string {
  const m = body.match(/##\s*正文\s*\n([\s\S]*)/);
  if (m) return m[1]!.trim();
  return body.trim();
}

function normalizeDedupeText(title: string, body: string): string {
  return `${title.trim()}\n${bodyCore(body)}`.replace(/\s+/g, " ").trim().toLowerCase();
}

function itemLooksForbidden(raw: Record<string, unknown>, title: string, body: string): boolean {
  if ("path" in raw) return true;
  const blob = `${title}\n${body}`;
  if (blob.includes("[[")) return true;
  if (/^---\s*\n[\s\S]*?\n---/.test(body.trim())) return true;
  return false;
}

async function exactDuplicate(
  repoRoot: string,
  brainId: string,
  title: string,
  body: string,
  extra: string[],
): Promise<boolean> {
  const needle = normalizeDedupeText(title, body);
  if (extra.some((t) => t === needle)) return true;
  const { readdir, readFile: rf } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { parseFrontmatter } = await import("../frontmatter.ts");
  const sources = join(repoRoot, "brains", brainId, "sources");
  if (!existsSync(sources)) return false;

  async function walk(dir: string): Promise<boolean> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (await walk(abs)) return true;
      } else if (e.isFile() && e.name.endsWith(".md") && !e.name.includes(".overview.")) {
        const raw = await rf(abs, "utf8");
        const parsed = parseFrontmatter(raw);
        const t = normalizeDedupeText(String(parsed.data.title ?? ""), parsed.body);
        if (t === needle) return true;
      }
    }
    return false;
  }
  return walk(sources);
}

function deriveNoteTitle(text: string): string {
  const line = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "会话笔记";
  return line.slice(0, 200);
}

function toFacts(type: string, createdBy: string, facts: unknown): Fact[] | undefined {
  if (!Array.isArray(facts)) return undefined;
  const at = todayUtc();
  const out: Fact[] = [];
  for (const f of facts) {
    if (!f || typeof f !== "object") continue;
    const raw = f as Record<string, unknown>;
    const text = String(raw.text ?? "").trim();
    if (!text || text.length > 2000) continue;
    const attributed = String(raw.attributed_to ?? createdBy);
    const fact: Fact = { text, event_type: type, attributed_to: attributed, at };
    const supersedes = sanitizeFactSupersedes(raw.supersedes);
    if (supersedes) fact.supersedes = supersedes;
    if (typeof raw.period === "string" && raw.period.trim()) fact.period = raw.period.trim();
    out.push(fact);
  }
  return out.length ? out : undefined;
}

function asLinkifyEntities(existing: Entity[], proposed: ProposedEntity[]): Entity[] {
  const bySlug = new Map(existing.map((e) => [e.slug, { ...e, aliases: [...(e.aliases ?? [])] }]));
  for (const p of proposed) {
    const hit = bySlug.get(p.slug);
    if (hit) {
      hit.aliases = [...new Set([...hit.aliases, ...p.aliases])];
    } else {
      bySlug.set(p.slug, {
        slug: p.slug,
        title: p.title,
        aliases: [...p.aliases],
        externalIds: [],
        status: "active",
        createdAt: "",
        updatedAt: "",
      });
    }
  }
  return [...bySlug.values()];
}

async function failDisabled(
  opts: CompileSessionOpts,
  sessionId: string | undefined,
  dryRun: boolean,
  message: string,
  skipped: string,
): Promise<never> {
  if (!dryRun && sessionId) {
    await markFailed(opts.repoRoot, opts.brainId, sessionId, { code: ErrorCodes.DISABLED, message });
  }
  throw new MemoryError(ErrorCodes.DISABLED, message, { skipped_reason: skipped });
}

export async function compileSession(opts: CompileSessionOpts): Promise<CompileResult> {
  const dryRun = Boolean(opts.dryRun);
  const hasTurns = opts.turns !== undefined;
  const hasId = Boolean(opts.sessionId);
  if (hasTurns === hasId) {
    throw new MemoryError(ErrorCodes.USAGE, "compileSession 需要 turns（新场）或 sessionId（retry），不能两者都给或都缺");
  }

  const cfg = await loadRepoConfig(opts.repoRoot);
  const stripped = hasTurns ? stripTurnsContext(opts.turns!) : [];
  const truncatedPrep = hasTurns ? truncateTurns(stripped, cfg.compile.max_input_chars) : { turns: stripped, truncated: false };

  let sessionId = opts.sessionId;
  let turns: Turn[] = truncatedPrep.turns;
  let truncated = truncatedPrep.truncated;

  if (!dryRun && hasTurns) {
    const archived = await archiveSession({
      repoRoot: opts.repoRoot,
      brainId: opts.brainId,
      sourceId: opts.sourceId,
      createdBy: opts.createdBy,
      turns: opts.turns!,
      toolMaxChars: cfg.compile.tool_max_chars,
    });
    sessionId = archived.sessionId;
    const loaded = await loadSession(opts.repoRoot, opts.brainId, sessionId);
    turns = stripTurnsContext(loaded.turns);
    const t2 = truncateTurns(turns, cfg.compile.max_input_chars);
    turns = t2.turns;
    truncated = t2.truncated;
  }

  if (!dryRun && sessionId && !hasTurns) {
    const loaded = await loadSession(opts.repoRoot, opts.brainId, sessionId);
    if (loaded.meta.status === "done") {
      return {
        session_id: sessionId,
        kept: (loaded.meta.kept_paths ?? []).map((path) => ({ type: "note", title: path, path })),
        dropped: [],
        unresolved: [],
        errors: [],
      };
    }
    turns = stripTurnsContext(loaded.turns);
    const t2 = truncateTurns(turns, cfg.compile.max_input_chars);
    turns = t2.turns;
    truncated = t2.truncated;
  }

  const result: CompileResult = {
    session_id: dryRun ? undefined : sessionId,
    kept: [],
    dropped: [],
    unresolved: [],
    errors: [],
    truncated: truncated || undefined,
  };

  let checkpoint = sessionId && !dryRun ? await loadExtracted(opts.repoRoot, opts.brainId, sessionId) : null;

  if (!checkpoint) {
    let itemsRaw: unknown[] = [];
    let entitiesRaw: unknown[] = [];
    if (opts.noExtract) {
      const body = turns
        .filter((t) => t.role === "user" || t.role === "assistant")
        .map((t) => t.text)
        .join("\n")
        .trim();
      itemsRaw = [{ type: "note", title: deriveNoteTitle(body), body: body || " " }];
    } else {
      const injected = Boolean(opts.llm);
      if (!injected && !isCompileEnabled(cfg.llm)) {
        const reason = cfg.llm.kill_switch.compile ? "kill_switch" : "provider_off";
        await failDisabled(
          opts,
          sessionId,
          dryRun,
          cfg.llm.kill_switch.compile
            ? "llm.kill_switch.compile=true"
            : "llm.provider=off：会话摄入需要配置 llm.provider=openai 与 API key（或测试 mock）",
          reason,
        );
      }
      if (!injected && (await wouldExceedCap(opts.repoRoot, cfg.cost))) {
        await failDisabled(opts, sessionId, dryRun, "daily token cap exceeded", "cost_cap");
      }

      const llm =
        opts.llm ??
        createLLMProvider(cfg.llm, { repoRoot: opts.repoRoot, cost: cfg.cost });
      const system = await loadSessionExtractPrompt();
      const existing = await prefetchExistingMemories({
        repoRoot: opts.repoRoot,
        brainId: opts.brainId,
        query: prefetchQueryText(turns),
        topn: cfg.compile.prefetch_topn,
      });
      const prompt = formatCompileUserPrompt({ turns, existing });
      try {
        const extracted = await completeItemsWithRepair(llm, system, prompt);
        itemsRaw = extracted.items;
        entitiesRaw = extracted.entities;
      } catch (e) {
        const err = e instanceof MemoryError ? e : new MemoryError(ErrorCodes.LLM, e instanceof Error ? e.message : String(e));
        if (!dryRun && sessionId) {
          await markFailed(opts.repoRoot, opts.brainId, sessionId, { code: err.code, message: err.message });
        }
        throw err;
      }
    }

    const proposed = normalizeProposedEntities(entitiesRaw);
    result.unresolved.push(...proposed.unresolvedTitles);
    const existingEntities = await loadEntities(opts.repoRoot, opts.brainId, opts.queue);
    const linkifyEntities = asLinkifyEntities(existingEntities, proposed.accepted);
    const existingSlugs = new Set(existingEntities.map((e) => e.slug));
    result.entities_created = proposed.accepted.filter((e) => !existingSlugs.has(e.slug)).map((e) => e.slug);

    if (itemsRaw.length === 0 && proposed.accepted.length === 0) {
      result.dropped.push({ reason: "empty", excerpt: "" });
      if (!dryRun && sessionId) {
        await writeExtracted(opts.repoRoot, opts.brainId, sessionId, { items: [], truncated });
        await markDone(opts.repoRoot, opts.brainId, sessionId, []);
      }
      return result;
    }

    if (itemsRaw.length === 0) {
      result.dropped.push({ reason: "empty", excerpt: "" });
    }

    const seenExact: string[] = [];
    const checkpointItems: ExtractedCheckpointItem[] = [];

    for (const rawItem of itemsRaw) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        result.errors.push({ message: "item 不是对象", code: ErrorCodes.VALIDATION });
        continue;
      }
      const raw = rawItem as Record<string, unknown>;
      const type = String(raw.type ?? "").trim();
      const title = String(raw.title ?? "").trim();
      const body = String(raw.body ?? "").trim();
      if (itemLooksForbidden(raw, title, body)) {
        result.errors.push({ message: `item 含 path/wikilink/frontmatter: ${excerptOf(title)}`, code: ErrorCodes.VALIDATION });
        continue;
      }
      if (!ALLOWED_TYPES.has(type) || !title || title.length > 200 || !body) {
        result.errors.push({ message: `item type/title/body 不合法: ${excerptOf(title || type)}`, code: ErrorCodes.VALIDATION });
        continue;
      }
      const srcTurns = checkSourceTurns(raw.source_turns, numberedTurnCount(turns));
      if (!srcTurns.ok) {
        result.errors.push({ message: `item source_turns 不合法: ${excerptOf(title)}`, code: ErrorCodes.VALIDATION });
        continue;
      }

      const mentions = Array.isArray(raw.mentions) ? raw.mentions.map((m) => String(m).trim()).filter(Boolean) : [];
      const linked = linkifyBody(body, linkifyEntities);
      for (const name of mentions) {
        const hit = linkifyEntities.find(
          (e) =>
            e.status !== "merged" &&
            (e.slug === name || e.title === name || (e.aliases ?? []).includes(name)),
        );
        if (!hit) result.unresolved.push(name);
      }

      const exact = await exactDuplicate(opts.repoRoot, opts.brainId, title, linked.body, seenExact);
      if (exact) {
        result.dropped.push({ reason: "duplicate", excerpt: excerptOf(title) });
        continue;
      }

      const dedupeCfg: RepoConfig = {
        ...cfg,
        write: { dedupe_cosine: cfg.compile.dedupe_cosine, dedupe_window: cfg.compile.dedupe_window },
      };
      const cosine = await checkDedupe(
        opts.repoRoot,
        opts.brainId,
        "",
        [title, buildMarkdownBody(linked.body)].join("\n"),
        dedupeCfg,
      );
      if (cosine.duplicate) {
        result.dropped.push({ reason: "duplicate", excerpt: excerptOf(title) });
        continue;
      }

      seenExact.push(normalizeDedupeText(title, linked.body));
      checkpointItems.push({
        type,
        title,
        body,
        facts: Array.isArray(raw.facts) ? (raw.facts as ExtractedCheckpointItem["facts"]) : undefined,
        mentions,
        status: "pending",
        path: undefined,
      });
      result.kept.push({
        type,
        title,
        links: linked.links.map((l) => ({ to: l.to })),
      });
    }

    const checkpointEntities: ExtractedCheckpointEntity[] = proposed.accepted.map((e) => ({
      slug: e.slug,
      title: e.title,
      aliases: e.aliases.length ? e.aliases : undefined,
      status: "pending",
    }));
    checkpoint = { items: checkpointItems, entities: checkpointEntities, truncated };
    if (!dryRun && sessionId) {
      await writeExtracted(opts.repoRoot, opts.brainId, sessionId, checkpoint);
    }
  } else if (sessionId && checkpoint) {
    for (const it of checkpoint.items) {
      if (it.status === "written" && it.path) {
        result.kept.push({ type: it.type, title: it.title, path: it.path });
      } else {
        result.kept.push({ type: it.type, title: it.title });
      }
    }
  }

  if (dryRun) {
    return result;
  }
  if (!sessionId || !checkpoint) {
    return result;
  }

  const writeFn = opts.captureWriteFn ?? captureWrite;
  const linksByTitle = new Map(result.kept.map((k) => [k.title, k.links]));
  const createdSlugs: string[] = [];

  await opts.queue.execute(async () => {
    const written: string[] = [];
    const reg = new EntityRegistryImpl(opts.repoRoot, opts.brainId, opts.queue);
    for (const ent of checkpoint!.entities ?? []) {
      if (ent.status === "written") continue;
      try {
        const listed = await reg.list({ includeMerged: true });
        const hit = listed.find((e) => e.slug === ent.slug);
        if (hit && hit.status !== "merged") {
          const patched = await reg.appendAliasesUnlocked(ent.slug, ent.aliases ?? []);
          if (patched?.path) written.push(patched.path);
          for (const s of patched?.skipped ?? []) result.unresolved.push(s);
        } else if (!hit) {
          const created = await reg.writeCreateUnlocked({
            slug: ent.slug,
            title: ent.title,
            aliases: ent.aliases,
            createdBy: opts.createdBy,
          });
          written.push(created.path);
          createdSlugs.push(ent.slug);
        }
        ent.status = "written";
      } catch (e) {
        const msg = e instanceof MemoryError && e.code === ErrorCodes.CONFLICT;
        if (msg) {
          try {
            const patched = await reg.appendAliasesUnlocked(ent.slug, ent.aliases ?? []);
            if (patched?.path) written.push(patched.path);
            for (const s of patched?.skipped ?? []) result.unresolved.push(s);
            ent.status = "written";
            continue;
          } catch {
            /* fall through */
          }
        }
        result.unresolved.push(ent.title);
        ent.status = "written";
      }
    }
    await writeExtracted(opts.repoRoot, opts.brainId, sessionId!, checkpoint!);

    const entities = await loadEntities(opts.repoRoot, opts.brainId, opts.queue);
    for (const item of checkpoint!.items) {
      if (item.status === "written" && item.path) {
        written.push(item.path);
        continue;
      }
      const lf = linkifyBody(item.body, entities);
      const links: Link[] = lf.links.map((l) => ({ to: l.to, type: l.type, source: "mention" }));
      linksByTitle.set(item.title, lf.links.map((l) => ({ to: l.to })));
      try {
        const path = await writeFn(opts.repoRoot, opts.pack, {
          brainId: opts.brainId,
          sourceId: opts.sourceId,
          schemaType: item.type,
          title: item.title,
          body: lf.body,
          facts: toFacts(item.type, opts.createdBy, item.facts),
          links,
          createdBy: opts.createdBy,
          disambiguate: true,
        } satisfies CaptureOptions);
        item.status = "written";
        item.path = path;
        written.push(path);
        written.push(...(await recordL0Create(opts.repoRoot, opts.brainId, path, opts.createdBy)));
        await writeExtracted(opts.repoRoot, opts.brainId, sessionId!, checkpoint!);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = e instanceof MemoryError ? e.code : ErrorCodes.INTERNAL;
        result.errors.push({ message: msg, code });
      }
    }
    return written;
  }, `compile session ${sessionId}`);

  if (createdSlugs.length) result.entities_created = createdSlugs;
  else if (!result.entities_created?.length) result.entities_created = undefined;

  const keptPaths = checkpoint.items.filter((it) => it.status === "written" && it.path).map((it) => it.path!);
  result.kept = checkpoint.items
    .filter((it) => it.status === "written")
    .map((it) => ({
      type: it.type,
      title: it.title,
      path: it.path,
      links: linksByTitle.get(it.title),
    }));

  const allWritten = checkpoint.items.length === 0 || checkpoint.items.every((it) => it.status === "written");
  if (allWritten) {
    await markDone(opts.repoRoot, opts.brainId, sessionId, keptPaths);
  } else {
    await markFailed(
      opts.repoRoot,
      opts.brainId,
      sessionId,
      { code: ErrorCodes.INTERNAL, message: "部分条目写入失败" },
      keptPaths,
    );
  }

  if (keptPaths.length > 0) {
    try {
      const distill = await maybeLazyDistillAfterCompile(opts.repoRoot, {
        brainId: opts.brainId,
        queue: opts.queue,
        // B 档 bridge：注入的 llm 一并用于懒蒸馏（refineSource 在 opts.llm
        // 存在时跳过 provider 门控）；kill_switch.distill 仍优先。
        llm: opts.llm && !cfg.llm.kill_switch.distill ? opts.llm : undefined,
      });
      if (distill) {
        result.distill = {
          written: distill.written,
          lazy_omitted: distill.lazy_omitted,
          crystallized: distill.crystallized,
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.distill = { written: 0, error: msg };
    }
  }

  return result;
}

/** retry：有 extracted 则只补写；纯 LLM 失败则清 failed 再跑 Extractor。 */
export async function retrySession(opts: Omit<CompileSessionOpts, "turns"> & { sessionId: string }): Promise<CompileResult> {
  const loaded = await loadSession(opts.repoRoot, opts.brainId, opts.sessionId);
  const extracted = await loadExtracted(opts.repoRoot, opts.brainId, opts.sessionId);
  if (!extracted && loaded.meta.status === "failed") {
    await clearFailed(opts.repoRoot, opts.brainId, opts.sessionId);
  }
  return compileSession({ ...opts, sessionId: opts.sessionId, turns: undefined });
}

async function completeItemsWithRepair(
  llm: LLMProvider,
  system: string,
  prompt: string,
): Promise<{ items: unknown[]; entities: unknown[] }> {
  const first = await llm.complete({ purpose: "compile", system, prompt });
  try {
    return parseCompleteExtractJson(first.text);
  } catch {
    const repaired = await llm.complete({
      purpose: "compile",
      system,
      prompt: `${prompt}\n\n${JSON_REPAIR_SUFFIX}`,
    });
    return parseCompleteExtractJson(repaired.text);
  }
}

async function loadEntities(repoRoot: string, brainId: string, queue: FileMutationExecutor): Promise<Entity[]> {
  const reg = createEntityRegistry(repoRoot, brainId, queue);
  return reg.list({ includeMerged: false });
}
