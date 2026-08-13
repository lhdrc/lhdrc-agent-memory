import { join } from "node:path";

/** evals/ 目录（仓根下）。 */
export const EVALS_ROOT = join(import.meta.dir, "..");

export function fixtureDir(...parts: string[]): string {
  return join(EVALS_ROOT, "fixtures", ...parts);
}

export function receiptDir(): string {
  return process.env.DF_EVAL_RECEIPT_DIR?.trim() || join(EVALS_ROOT, "receipts");
}

export function cacheDir(adapterId: string): string {
  const override = process.env.DF_EVAL_CACHE_DIR?.trim();
  if (override) return override;
  return join(EVALS_ROOT, "cache", adapterId);
}
