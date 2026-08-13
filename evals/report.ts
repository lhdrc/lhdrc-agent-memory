import { readLatestReceipt } from "./lib/receipt.ts";

export async function runReport(opts: { json?: boolean } = {}): Promise<number> {
  const latest = await readLatestReceipt();
  if (!latest) {
    console.error("没有评测 receipt。请先跑 bun run eval:mini（或 --fixture / fetch --allow-net）。");
    return 1;
  }
  const { receipt, path } = latest;
  if (opts.json) {
    console.log(JSON.stringify({ path, metrics: receipt.metrics, ok: receipt.ok, kind: receipt.kind }));
    return 0;
  }
  console.log(`latest: ${path}`);
  console.log(`kind: ${receipt.kind}  ok: ${receipt.ok}  ts: ${receipt.ts}`);
  console.log("metrics:");
  console.log(JSON.stringify(receipt.metrics, null, 2));
  return 0;
}
