import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { receiptDir } from "./paths.ts";

export interface EvalReceipt {
  id: string;
  kind: "mini" | "distill" | "adapter";
  adapter?: string;
  ts: string;
  ok: boolean;
  metrics: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

function stamp(ts: string): string {
  return ts.replace(/[:.]/g, "-");
}

export async function writeReceipt(receipt: EvalReceipt): Promise<string> {
  const dir = receiptDir();
  await mkdir(dir, { recursive: true });
  const name = `${stamp(receipt.ts)}-${receipt.kind}${receipt.adapter ? `-${receipt.adapter}` : ""}.json`;
  const abs = join(dir, name);
  const body = JSON.stringify(receipt, null, 2);
  await writeFile(abs, body, "utf8");
  await writeFile(join(dir, "latest.json"), JSON.stringify({ file: name, ...receipt }, null, 2), "utf8");
  return abs;
}

export async function readLatestReceipt(): Promise<{ path: string; receipt: EvalReceipt } | null> {
  const dir = receiptDir();
  const latest = join(dir, "latest.json");
  if (existsSync(latest)) {
    const raw = JSON.parse(await readFile(latest, "utf8")) as EvalReceipt & { file?: string };
    return { path: latest, receipt: raw };
  }
  if (!existsSync(dir)) return null;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && f !== "latest.json");
  if (files.length === 0) return null;
  let best = files[0]!;
  let bestM = 0;
  for (const f of files) {
    const m = (await stat(join(dir, f))).mtimeMs;
    if (m >= bestM) {
      bestM = m;
      best = f;
    }
  }
  const abs = join(dir, best);
  return { path: abs, receipt: JSON.parse(await readFile(abs, "utf8")) as EvalReceipt };
}
