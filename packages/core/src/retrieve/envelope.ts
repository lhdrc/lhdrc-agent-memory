import { ErrorCodes, type ErrorCode } from "../errors.ts";

/** P12.2：给宿主 agent 的降级/错误信封。仓内 complete() 不消费此类型。 */
export type MemoryDegradationArm = "semantic" | "graph" | "keyword" | "write" | "job";

export interface MemoryDegradation {
  code: string;
  reason: string;
  message: string;
  arm?: MemoryDegradationArm;
}

export interface MemoryToolError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface MemoryToolEnvelope<T = unknown> {
  ok: boolean;
  result?: T;
  degradation?: MemoryDegradation[];
  error?: MemoryToolError;
}

export function envelopeOk<T>(result: T, degradation?: MemoryDegradation[]): MemoryToolEnvelope<T> {
  const env: MemoryToolEnvelope<T> = { ok: true, result };
  if (degradation && degradation.length > 0) env.degradation = degradation;
  return env;
}

export function envelopeFail(
  code: ErrorCode | string,
  message: string,
  details?: Record<string, unknown>,
): MemoryToolEnvelope<never> {
  return {
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  };
}

export function degradation(
  reason: string,
  message: string,
  opts?: { code?: string; arm?: MemoryDegradationArm },
): MemoryDegradation {
  return {
    code: opts?.code ?? ErrorCodes.DISABLED,
    reason,
    message,
    ...(opts?.arm ? { arm: opts.arm } : {}),
  };
}

export function mergeDegradations(
  ...lists: Array<MemoryDegradation[] | undefined>
): MemoryDegradation[] {
  const out: MemoryDegradation[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const d of list ?? []) {
      const k = `${d.arm ?? ""}:${d.reason}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
    }
  }
  return out;
}
