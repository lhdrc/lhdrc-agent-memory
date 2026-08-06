import { MemoryError, ErrorCodes } from "../errors.ts";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runGit(repoRoot: string, args: string[]): Promise<GitResult> {
  try {
    const sub = Bun.spawn({
      cmd: ["git", ...args],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(sub.stdout).text(),
      new Response(sub.stderr).text(),
      sub.exited,
    ]);
    return { stdout, stderr, exitCode };
  } catch (e) {
    throw new MemoryError(ErrorCodes.GIT, `git 执行失败: ${args.join(" ")}`, {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
}

export function assertGitOk(result: GitResult, context: string): void {
  if (result.exitCode !== 0) {
    throw new MemoryError(ErrorCodes.GIT, `${context}失败: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export async function gitInit(repoRoot: string): Promise<void> {
  assertGitOk(await runGit(repoRoot, ["init", "-q"]), "git init");
}

export async function gitIsRepo(repoRoot: string): Promise<boolean> {
  const r = await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  return r.exitCode === 0 && r.stdout.trim() === "true";
}

export async function gitAdd(repoRoot: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  assertGitOk(await runGit(repoRoot, ["add", "-A", "--", ...paths]), "git add");
}

export async function gitAddAll(repoRoot: string): Promise<void> {
  assertGitOk(await runGit(repoRoot, ["add", "-A"]), "git add");
}

export async function gitCommit(repoRoot: string, message: string): Promise<void> {
  const r = await runGit(repoRoot, ["commit", "-m", message]);
  if (r.exitCode !== 0) {
    const hasStaged = (await runGit(repoRoot, ["diff", "--cached", "--name-only"])).stdout.trim().length > 0;
    if (!hasStaged) return;
    throw new MemoryError(ErrorCodes.GIT, `git commit 失败: ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

/** 若仓库未配置 user identity，写入本地默认值，保证 init/commit 可用。 */
export async function ensureGitIdentity(repoRoot: string): Promise<void> {
  const email = (await runGit(repoRoot, ["config", "user.email"])).stdout.trim();
  if (!email) {
    await runGit(repoRoot, ["config", "user.email", "memory@local"]);
    await runGit(repoRoot, ["config", "user.name", "df-memory"]);
  }
}

export async function gitLog(repoRoot: string, count = 10): Promise<string[]> {
  const r = await runGit(repoRoot, ["log", `-${count}`, "--pretty=%s"]);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function gitCheckoutRollback(repoRoot: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await runGit(repoRoot, ["checkout", "--", ...paths]);
}
