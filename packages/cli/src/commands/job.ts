import { MemoryError, ErrorCodes, readJob } from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function jobCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "status") {
    throw new MemoryError(ErrorCodes.USAGE, "memory job status <task_id>");
  }
  const o = parseArgs(rest, [{ name: "json", type: "boolean" }]);
  const taskId = o._[0]?.trim();
  if (!taskId) {
    throw new MemoryError(ErrorCodes.JOB, "job status 需要 task_id");
  }
  const ctx = await loadContext(Boolean(o.json));
  const job = await readJob(ctx.repoRoot, ctx.brainId, taskId);
  if (!job) {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `task_id 不存在: ${taskId}`);
  }
  if (o.json) console.log(JSON.stringify(job));
  else {
    console.log(`${job.task_id}\t${job.status}\t${job.kind}`);
    if (job.error) console.log(`${job.error.code}: ${job.error.message}`);
  }
  return 0;
}
