import type { CaptureOptions } from "../write/capture.ts";
import type { FileMutationExecutor } from "../write/executor.ts";
import type { SchemaPack } from "../schema/loadPack.ts";

/** 适配器输出：经 captureNode 写入，不直写 sources（P5.8 / D9）。 */
export interface IngestRecord {
  title: string;
  body: string;
  schemaType?: string;
  sourceId?: string;
  tags?: string[];
  aliases?: string[];
}

export interface IngestAdapter {
  id: string;
  map(raw: unknown, ctx: { line: number }): IngestRecord;
}

export interface IngestLineError {
  line: number;
  message: string;
  code?: string;
}

export interface IngestResult {
  adapter: string;
  paths: string[];
  errors: IngestLineError[];
  ok: number;
  failed: number;
}

export type IngestCaptureFn = (
  repoRoot: string,
  pack: SchemaPack,
  queue: FileMutationExecutor,
  opts: CaptureOptions,
) => Promise<string>;
