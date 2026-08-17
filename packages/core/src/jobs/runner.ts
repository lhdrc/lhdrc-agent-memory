/**
 * P9.8：JobRunner 在 core。权威 .dfmemory/jobs/{brainId}/{task_id}.json。
 * CLI 与插件共用；禁止第二套队列。
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ErrorCodes, MemoryError } from "../errors.ts";
import { compileSession, type CompileResult } from "../compile/session.ts";
import { loadPack } from "../schema/loadPack.ts";
import { loadRepoConfig } from "../repo/config.ts";
import type { FactExtractMeta, LLMProvider } from "../llm/types.ts";
import type { FileMutationExecutor } from "../write/executor.ts";
import { captureNode, type CaptureOptions } from "../write/capture.ts";
import { enrichAfterWrite } from "../write/enrich.ts";
import type { SchemaPack } from "../schema/loadPack.ts";

export const DEFAULT_JOB_TIMEOUT_MS = 120_000;
export const JOB_TIMEOUT_MS = DEFAULT_JOB_TIMEOUT_MS;
const MAX_KEEP = 50;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type MemoryJobKind = "compile" | "end_session" | "remember" | "capture";
export type MemoryJobStatus = "pending" | "running" | "done" | "failed";

export type MemoryJob = {
  task_id: string;
  kind: MemoryJobKind;
  status: MemoryJobStatus;
  brain_id: string;
  session_id: string;
  accepted_at: string;
  started_at?: string;
  finished_at?: string;
  result?: {
    kept: number;
    dropped: number;
    errors: unknown[];
    distill?: { written?: number; skipped_reason?: string };
  };
  /** wait:true 用的完整工具体 */
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  /** 内部运行参数；在 job 文件写入后再挂载，不落盘。 */
  timeoutMs?: number;
};

import type { Turn } from "../inbox/session.ts";

export type RunCompileOpts = {
  repoRoot: string;
  brainId: string;
  sourceId: string;
  createdBy: string;
  queue: FileMutationExecutor;
  sessionId: string;
  llm?: LLMProvider;
  /** 覆盖仓内 compile.job_timeout_ms（测试/调用方注入）。 */
  timeoutMs?: number;
  turns?: Turn[];
  dryRun?: boolean;
  noExtract?: boolean;
};

export type JobAbortToken = { aborted: boolean };

function timeoutError(timeoutMs: number): MemoryError {
  return new MemoryError(ErrorCodes.TIMEOUT, `job exceeded ${timeoutMs}ms`);
}

function assertNotAborted(token: JobAbortToken, timeoutMs: number): void {
  if (token.aborted) throw timeoutError(timeoutMs);
}

/**
 * 超时后不再让 LLM 结果流入 compileSession 的写盘阶段：
 * - 调用前已 aborted → 直接 E_TIMEOUT；
 * - 调用中发生 aborted → 等到原调用返回后立即 E_TIMEOUT。
 * compileSession 收到 MemoryError(TIMEOUT) 后会把 inbox 标 failed，不写 L0。
 */
function withJobAbort(llm: LLMProvider | undefined, token: JobAbortToken, timeoutMs: number): LLMProvider | undefined {
  if (!llm) return llm;
  const guarded = async <T>(p: Promise<T>): Promise<T> => {
    const out = await p;
    assertNotAborted(token, timeoutMs);
    return out;
  };
  const check = () => assertNotAborted(token, timeoutMs);
  return {
    id: llm.id,
    complete: async (req) => {
      check();
      return guarded(llm.complete(req));
    },
    judgeDistill: async (existing, candidate) => {
      check();
      return guarded(llm.judgeDistill(existing, candidate));
    },
    generateAbstract: async (content) => {
      check();
      return guarded(llm.generateAbstract(content));
    },
    generateOverview: async (children) => {
      check();
      return guarded(llm.generateOverview(children));
    },
    refineExperience: async (ctx) => {
      check();
      return guarded(llm.refineExperience(ctx));
    },
    ...(llm.embed ? { embed: async (texts: string[]) => { check(); return guarded(llm.embed!(texts)); } } : {}),
    ...(llm.extractFacts
      ? { extractFacts: async (body: string, meta: FactExtractMeta) => { check(); return guarded(llm.extractFacts!(body, meta)); } }
      : {}),
  };
}

/** 超时后禁止再开启新的 WriteQueue.execute（已有 mutation 无法安全中断）。 */
function withJobAbortQueue(
  queue: FileMutationExecutor,
  token: JobAbortToken,
  timeoutMs: number,
): FileMutationExecutor {
  return {
    async execute(mutation, message, opts) {
      assertNotAborted(token, timeoutMs);
      return queue.execute(mutation, message, opts);
    },
  };
}

function jobsDir(repoRoot: string, brainId: string): string {
  return join(repoRoot, ".dfmemory", "jobs", brainId);
}

function jobPath(repoRoot: string, brainId: string, taskId: string): string {
  return join(jobsDir(repoRoot, brainId), `${taskId}.json`);
}

export async function readJob(
  repoRoot: string,
  brainId: string,
  taskId: string,
): Promise<MemoryJob | null> {
  const p = jobPath(repoRoot, brainId, taskId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf8")) as MemoryJob;
  } catch {
    return null;
  }
}

async function writeJob(repoRoot: string, brainId: string, job: MemoryJob): Promise<void> {
  const dir = jobsDir(repoRoot, brainId);
  await mkdir(dir, { recursive: true });
  await writeFile(jobPath(repoRoot, brainId, job.task_id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

async function pruneJobs(repoRoot: string, brainId: string): Promise<void> {
  const dir = jobsDir(repoRoot, brainId);
  if (!existsSync(dir)) return;
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  const rows: Array<{ name: string; job: MemoryJob; mtime: number }> = [];
  for (const name of names) {
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const job = JSON.parse(raw) as MemoryJob;
      rows.push({ name, job, mtime: Date.parse(job.finished_at ?? job.accepted_at) || 0 });
    } catch {
      /* skip */
    }
  }
  const now = Date.now();
  const finished = rows
    .filter((r) => r.job.status === "done" || r.job.status === "failed")
    .sort((a, b) => b.mtime - a.mtime);
  const drop = new Set<string>();
  finished.forEach((r, i) => {
    if (i >= MAX_KEEP || (r.mtime > 0 && now - r.mtime > MAX_AGE_MS)) drop.add(r.name);
  });
  for (const name of drop) {
    await unlink(join(dir, name)).catch(() => {});
  }
}

export async function recoverCrashedJobs(repoRoot: string, brainId: string): Promise<void> {
  const dir = jobsDir(repoRoot, brainId);
  if (!existsSync(dir)) return;
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    const p = join(dir, name);
    try {
      const job = JSON.parse(await readFile(p, "utf8")) as MemoryJob;
      if (job.status !== "running") continue;
      job.status = "failed";
      job.finished_at = new Date().toISOString();
      job.error = { code: "E_JOB", message: "job left running after process restart" };
      await writeFile(p, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    } catch {
      /* skip */
    }
  }
}

function resultFromCompile(r: CompileResult): NonNullable<MemoryJob["result"]> {
  const out: NonNullable<MemoryJob["result"]> = {
    kept: r.kept.length,
    dropped: r.dropped.length,
    errors: r.errors,
  };
  if (r.distill) {
    out.distill = { written: r.distill.written };
    if (r.distill.skipped_reason) out.distill.skipped_reason = r.distill.skipped_reason;
  }
  return out;
}

export class JobRunner {
  private chain: Promise<void> = Promise.resolve();
  private readonly repoRoot: string;
  private readonly brainId: string;

  constructor(repoRoot: string, brainId: string) {
    this.repoRoot = repoRoot;
    this.brainId = brainId;
  }

  enqueue(job: MemoryJob, run: (token: JobAbortToken) => Promise<CompileResult>, timeoutMs = job.timeoutMs ?? JOB_TIMEOUT_MS): string {
    const taskId = job.task_id;
    this.chain = this.chain.then(() => this.execute(job, run, timeoutMs)).catch(() => {});
    return taskId;
  }

  async wait(taskId: string, timeoutMs = JOB_TIMEOUT_MS): Promise<MemoryJob> {
      const job = await this.waitFile(taskId, timeoutMs);
      if (job.status === "pending" || job.status === "running") {
        return {
          ...job,
          status: "failed",
          finished_at: new Date().toISOString(),
          error: { code: "E_TIMEOUT", message: `job exceeded ${timeoutMs}ms` },
        };
      }
      return job;
    }

    /** 旧实现仅保留对照；executor 是唯一 job writer，wait 只读。 */
    private async legacyWaitUnused(taskId: string, timeoutMs = JOB_TIMEOUT_MS): Promise<MemoryJob> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const job = await readJob(this.repoRoot, this.brainId, taskId);
      if (job && (job.status === "done" || job.status === "failed")) return job;
      await new Promise((r) => setTimeout(r, 50));
    }
    const job = await readJob(this.repoRoot, this.brainId, taskId);
    if (job && job.status !== "done" && job.status !== "failed") {
      job.status = "failed";
      job.finished_at = new Date().toISOString();
      job.error = { code: "E_TIMEOUT", message: `job exceeded ${timeoutMs}ms` };
      await writeJob(this.repoRoot, this.brainId, job);
      return job;
    }
    if (job) return job;
    return {
      task_id: taskId,
      kind: "remember",
      status: "failed",
      brain_id: this.brainId,
      session_id: "",
      accepted_at: new Date().toISOString(),
      error: { code: "E_JOB", message: `task not found: ${taskId}` },
    };
  }

  private async execute(job: MemoryJob, run: (token: JobAbortToken) => Promise<CompileResult>, timeoutMs: number): Promise<void> {
    const latest = await readJob(this.repoRoot, this.brainId, job.task_id);
    if (!latest || latest.status !== "pending") return;
    latest.status = "running";
    latest.started_at = new Date().toISOString();
    await writeJob(this.repoRoot, this.brainId, latest);
      const token: JobAbortToken = { aborted: false };
      let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const compiled = await Promise.race([
        run(token),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
                token.aborted = true;
                reject(timeoutError(timeoutMs));
              }, timeoutMs);
        }),
      ]);
        if (timer) clearTimeout(timer);
      latest.status = "done";
      latest.finished_at = new Date().toISOString();
      latest.result = resultFromCompile(compiled);
      latest.output = compileResultToToolBody(compiled, {
        task_id: latest.task_id,
        status: "done",
        accepted: true,
      });
      await writeJob(this.repoRoot, this.brainId, latest);
    } catch (e) {
      if (timer) clearTimeout(timer);
        token.aborted = true;
        const code = e instanceof MemoryError ? e.code : (e as { code?: string }).code ?? "E_JOB";
      latest.status = "failed";
      latest.finished_at = new Date().toISOString();
      latest.error = {
        code: typeof code === "string" ? code : "E_JOB",
        message: e instanceof Error ? e.message : String(e),
      };
      await writeJob(this.repoRoot, this.brainId, latest);
    }
  }

    /** 只读轮询 job 文件；执行器是唯一 writer，避免超时竞争覆写。 */
    private async waitFile(taskId: string, timeoutMs: number): Promise<MemoryJob> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const job = await readJob(this.repoRoot, this.brainId, taskId);
        if (job && (job.status === "done" || job.status === "failed")) return job;
        await new Promise((r) => setTimeout(r, 50));
      }
      const job = await readJob(this.repoRoot, this.brainId, taskId);
      if (job && (job.status === "done" || job.status === "failed")) return job;
      if (job) return job;
      return {
        task_id: taskId,
        kind: "remember",
        status: "failed",
        brain_id: this.brainId,
        session_id: "",
        accepted_at: new Date().toISOString(),
        error: { code: "E_JOB", message: `task not found: ${taskId}` },
      };
    }

}

const runners = new Map<string, JobRunner>();

export function getJobRunner(repoRoot: string, brainId: string): JobRunner {
  const key = `${repoRoot}\0${brainId}`;
  let r = runners.get(key);
  if (!r) {
    r = new JobRunner(repoRoot, brainId);
    runners.set(key, r);
    void recoverCrashedJobs(repoRoot, brainId);
  }
  return r;
}

export async function acceptRememberJob(opts: RunCompileOpts & { kind?: MemoryJobKind }): Promise<MemoryJob> {
  const taskId = randomUUID();
  const job: MemoryJob = {
    task_id: taskId,
    kind: opts.kind ?? "remember",
    status: "pending",
    brain_id: opts.brainId,
    session_id: opts.sessionId,
    accepted_at: new Date().toISOString(),
  };
  const repoCfg = await loadRepoConfig(opts.repoRoot);
    const pack = await loadPack(repoCfg.schema_pack);
    const timeoutMs = Number(opts.timeoutMs ?? repoCfg.compile.job_timeout_ms) || DEFAULT_JOB_TIMEOUT_MS;
    await writeJob(opts.repoRoot, opts.brainId, job);
  await pruneJobs(opts.repoRoot, opts.brainId);
    job.timeoutMs = timeoutMs;
  const runner = getJobRunner(opts.repoRoot, opts.brainId);
  runner.enqueue(job, async (token) => {
    const repoCfg = await loadRepoConfig(opts.repoRoot);
    const pack = await loadPack(repoCfg.schema_pack);
    return compileSession({
      repoRoot: opts.repoRoot,
      brainId: opts.brainId,
      sourceId: opts.sourceId,
      createdBy: opts.createdBy,
      pack,
      queue: withJobAbortQueue(opts.queue, token, timeoutMs),
      sessionId: opts.sessionId,
      turns: opts.turns,
      dryRun: opts.dryRun,
      noExtract: opts.noExtract,
      llm: withJobAbort(opts.llm, token, timeoutMs),
    });
  });
  return job;
}

export type RunCaptureOpts = {
  repoRoot: string;
  brainId: string;
  pack: SchemaPack;
  queue: FileMutationExecutor;
  capture: CaptureOptions;
  extract?: boolean;
  noDedupe?: boolean;
  timeoutMs?: number;
};

export async function acceptCaptureJob(opts: RunCaptureOpts): Promise<MemoryJob> {
  const taskId = randomUUID();
  const job: MemoryJob = {
    task_id: taskId,
    kind: "capture",
    status: "pending",
    brain_id: opts.brainId,
    session_id: "",
    accepted_at: new Date().toISOString(),
  };
  const repoCfg = await loadRepoConfig(opts.repoRoot);
  const timeoutMs = Number(opts.timeoutMs ?? repoCfg.compile.job_timeout_ms) || DEFAULT_JOB_TIMEOUT_MS;
  await writeJob(opts.repoRoot, opts.brainId, job);
  await pruneJobs(opts.repoRoot, opts.brainId);
  job.timeoutMs = timeoutMs;
  const runner = getJobRunner(opts.repoRoot, opts.brainId);
  runner.enqueue(job, async (token) => {
    const queue = withJobAbortQueue(opts.queue, token, timeoutMs);
    const path = await captureNode(opts.repoRoot, opts.pack, queue, opts.capture);
    const enrich = await enrichAfterWrite({
      repoRoot: opts.repoRoot,
      brainId: opts.brainId,
      path,
      queue,
      extract: opts.extract,
      noDedupe: opts.noDedupe,
    });
    return {
      kept: [{ type: opts.capture.schemaType, title: opts.capture.title, path }],
      dropped: [],
      unresolved: [],
      errors: [],
      distill: enrich?.extracted_facts != null ? { written: enrich.extracted_facts } : undefined,
    };
  });
  return job;
}

export function compileResultToToolBody(result: CompileResult, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    session_id: result.session_id ?? null,
    kept: result.kept.map((k) => {
      const item: Record<string, unknown> = { type: k.type, title: k.title };
      if (k.path) item.path = k.path;
      if (k.links?.length) item.links = k.links.map((l) => ({ to: l.to }));
      return item;
    }),
    dropped: result.dropped.map((d) => ({ reason: d.reason, excerpt: d.excerpt })),
    errors: result.errors.map((e) => {
      const item: Record<string, unknown> = { message: e.message };
      if (e.code) item.code = e.code;
      return item;
    }),
    ...extra,
  };
  if (result.skipped_reason) out.skipped_reason = result.skipped_reason;
  if (result.distill) {
    const d: Record<string, unknown> = { written: result.distill.written };
    if (result.distill.lazy_omitted !== undefined) d.lazy_omitted = result.distill.lazy_omitted;
    if (result.distill.crystallized) d.crystallized = result.distill.crystallized;
    if (result.distill.error) d.error = result.distill.error;
    out.distill = d;
  }
  return out;
}
