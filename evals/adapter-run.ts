import {
  captureNode,
  openPglite,
  hybridQuery,
  syncAll,
} from "../packages/core/src/index.ts";
import { getAdapter } from "./adapters/registry.ts";
import { fixtureDir, cacheDir } from "./lib/paths.ts";
import { writeReceipt } from "./lib/receipt.ts";
import { createEvalWorkspace } from "./lib/workspace.ts";
import { hitsToBlob } from "./lib/rule-agent.ts";

export async function runAdapter(opts: {
  adapter: string;
  fixture?: boolean;
  json?: boolean;
}): Promise<number> {
  const adapter = getAdapter(opts.adapter);
  const cases = await adapter.load({
    fixture: Boolean(opts.fixture),
    fixtureDir: fixtureDir(`${opts.adapter}-sample`),
    cacheDir: cacheDir(opts.adapter),
  });
  if (cases.length === 0) {
    throw new Error(`${adapter.id} 无 case。请使用 --fixture 或 fetch --allow-net`);
  }

  const ws = await createEvalWorkspace({ brain: "default" });
  const ts = new Date().toISOString();
  try {
    const ingested = new Set<string>();
    const maxIngest = Number.parseInt(process.env.DF_EVAL_MAX_INGEST ?? "0", 10);
    let ingestDone = false;
    for (const c of cases) {
      if (ingestDone) break;
      for (const text of c.ingestTexts ?? []) {
        if (ingested.has(text)) continue;
        if (maxIngest > 0 && ingested.size >= maxIngest) {
          ingestDone = true;
          break;
        }
        ingested.add(text);
        const title = text.slice(0, 80);
        await captureNode(ws.repoRoot, ws.pack, ws.queue, {
          brainId: "default",
          sourceId: "default",
          schemaType: "note",
          title,
          body: text,
          createdBy: `eval:${adapter.id}`,
        });
      }
    }

    const conn = await openPglite(ws.repoRoot);
    try {
      await syncAll(conn.db, ws.repoRoot, "default");
      let hits = 0;
      const rows: Array<{ id: string; score: number }> = [];
      for (const c of cases) {
        const retrieved = await hybridQuery(conn.db, {
          brainId: "default",
          query: c.query,
          skipCache: true,
          limit: 10,
        });
        const score = adapter.score(hitsToBlob(retrieved), c.gold);
        if (score >= 1) hits++;
        rows.push({ id: c.id, score });
      }
      const n = cases.length;
      const accuracy = n === 0 ? 0 : hits / n;
      const ok = accuracy >= 1;
      const metrics = { n, hits, accuracy, fixture: Boolean(opts.fixture) };
      const receiptPath = await writeReceipt({
        id: adapter.id,
        kind: "adapter",
        adapter: adapter.id,
        ts,
        ok,
        metrics,
        extra: { cases: rows },
      });
      console.log(JSON.stringify({ ok, kind: "adapter", adapter: adapter.id, metrics, receipt: receiptPath }));
      return ok ? 0 : 1;
    } finally {
      await conn.close();
    }
  } finally {
    await ws.dispose();
  }
}
