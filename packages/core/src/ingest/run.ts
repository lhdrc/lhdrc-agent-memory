import { MemoryError, ErrorCodes } from "../errors.ts";
import { captureNode, type CaptureOptions } from "../write/capture.ts";
import type { FileMutationExecutor } from "../write/executor.ts";
import type { SchemaPack } from "../schema/loadPack.ts";
import type {
  IngestAdapter,
  IngestCaptureFn,
  IngestLineError,
  IngestRecord,
  IngestResult,
} from "./types.ts";
import { parseJsonl } from "./jsonl.ts";

export interface IngestJsonlOptions {
  repoRoot: string;
  pack: SchemaPack;
  queue: FileMutationExecutor;
  brainId: string;
  createdBy: string;
  defaultSourceId: string;
  adapter: IngestAdapter;
  text: string;
  continueOnError?: boolean;
  /** 测试注入；默认 captureNode（经 WriteQueue，不直写 sources） */
  capture?: IngestCaptureFn;
}

function asRecord(raw: unknown, line: number): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MemoryError(ErrorCodes.VALIDATION, `第 ${line} 行必须是 JSON 对象`);
  }
  return raw as Record<string, unknown>;
}

export function ingestRecordToCapture(
  rec: IngestRecord,
  opts: { brainId: string; createdBy: string; defaultSourceId: string },
): CaptureOptions {
  return {
    brainId: opts.brainId,
    sourceId: rec.sourceId?.trim() || opts.defaultSourceId,
    schemaType: rec.schemaType?.trim() || "note",
    title: rec.title,
    body: rec.body,
    tags: rec.tags,
    aliases: rec.aliases,
    createdBy: opts.createdBy,
  };
}

/**
 * JSONL/JSON 数组 → map → captureNode。
 * 非法行默认中止；`--continue-on-error` 跳过坏行。
 */
export async function ingestJsonl(opts: IngestJsonlOptions): Promise<IngestResult> {
  const capture = opts.capture ?? captureNode;
  const parsed = parseJsonl(opts.text);
  const errors: IngestLineError[] = parsed.errors.map((e) => ({
    line: e.line,
    message: e.message,
    code: ErrorCodes.VALIDATION,
  }));
  const paths: string[] = [];

  const fail = (err: IngestLineError): IngestResult => {
    if (!errors.some((e) => e.line === err.line && e.message === err.message)) errors.push(err);
    return {
      adapter: opts.adapter.id,
      paths,
      errors,
      ok: paths.length,
      failed: errors.length,
    };
  };

  if (errors.length > 0 && !opts.continueOnError) {
    return fail(errors[0]!);
  }

  for (const row of parsed.rows) {
    try {
      asRecord(row.raw, row.line);
      const rec = opts.adapter.map(row.raw, { line: row.line });
      if (!rec.title?.trim()) {
        throw new MemoryError(ErrorCodes.VALIDATION, `第 ${row.line} 行缺少 title`);
      }
      if (rec.body == null || String(rec.body).length === 0) {
        throw new MemoryError(ErrorCodes.VALIDATION, `第 ${row.line} 行缺少 body`);
      }
      const path = await capture(
        opts.repoRoot,
        opts.pack,
        opts.queue,
        ingestRecordToCapture(rec, {
          brainId: opts.brainId,
          createdBy: opts.createdBy,
          defaultSourceId: opts.defaultSourceId,
        }),
      );
      paths.push(path);
    } catch (e) {
      const err: IngestLineError = {
        line: row.line,
        message: e instanceof Error ? e.message : String(e),
        code: e instanceof MemoryError ? e.code : ErrorCodes.VALIDATION,
      };
      if (!opts.continueOnError) {
        return fail(err);
      }
      errors.push(err);
    }
  }

  return {
    adapter: opts.adapter.id,
    paths,
    errors,
    ok: paths.length,
    failed: errors.length,
  };
}
