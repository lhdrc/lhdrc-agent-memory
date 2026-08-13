import { readFile } from "node:fs/promises";
import {
  captureNode,
  openPglite,
  hybridQuery,
  syncAll,
  responseContainsSecret,
} from "../packages/core/src/index.ts";
import { fixtureDir } from "./lib/paths.ts";
import { writeReceipt } from "./lib/receipt.ts";
import { createEvalWorkspace } from "./lib/workspace.ts";
import { goldHit, hitsToBlob } from "./lib/rule-agent.ts";

const SECRET_A = "MINI_SECRET_A_x9";
const SECRET_B = "MINI_SECRET_B_y8";

interface MiniNote {
  brain: string;
  title: string;
  body: string;
}

interface MiniQuery {
  id: string;
  brain: string;
  query: string;
  expect_substr: string;
}

interface MiniFixture {
  notes: MiniNote[];
  queries: MiniQuery[];
}

async function wipeIndex(db: { exec: (sql: string) => Promise<unknown> }): Promise<void> {
  await db.exec(`DELETE FROM chunks; DELETE FROM pages; DELETE FROM links; DELETE FROM search_cache;`);
}

export async function runMini(opts: { wipeIndex?: boolean; json?: boolean } = {}): Promise<number> {
  const fixture = JSON.parse(await readFile(fixtureDir("mini", "cases.json"), "utf8")) as MiniFixture;
  const brains = new Set<string>(["brain-a", "brain-b", ...fixture.notes.map((n) => n.brain)]);
  const extra = [...brains].filter((b) => b !== "brain-a");
  const ws = await createEvalWorkspace({ brain: "brain-a", extraBrains: extra });
  const ts = new Date().toISOString();
  try {
    for (const n of fixture.notes) {
      await captureNode(ws.repoRoot, ws.pack, ws.queue, {
        brainId: n.brain,
        sourceId: "default",
        schemaType: "note",
        title: n.title,
        body: n.body,
        createdBy: "eval:mini",
      });
    }
    await captureNode(ws.repoRoot, ws.pack, ws.queue, {
      brainId: "brain-a",
      sourceId: "default",
      schemaType: "note",
      title: "SecretA",
      body: SECRET_A,
      createdBy: "eval:mini",
    });
    await captureNode(ws.repoRoot, ws.pack, ws.queue, {
      brainId: "brain-b",
      sourceId: "default",
      schemaType: "note",
      title: "SecretB",
      body: SECRET_B,
      createdBy: "eval:mini",
    });

    const conn = await openPglite(ws.repoRoot);
    try {
      await syncAll(conn.db, ws.repoRoot, "brain-a");
      await syncAll(conn.db, ws.repoRoot, "brain-b");
      if (opts.wipeIndex) await wipeIndex(conn.db);

      let nHits = 0;
      let top1 = 0;
      const caseRows: Array<{ id: string; hit: boolean; top1: boolean }> = [];
      for (const q of fixture.queries) {
        const hits = await hybridQuery(conn.db, { brainId: q.brain, query: q.query, skipCache: true, limit: 10 });
        const blob = hitsToBlob(hits);
        const hit = goldHit(blob, q.expect_substr);
        const t1 = hits[0] ? goldHit(hitsToBlob([hits[0]]), q.expect_substr) : false;
        if (hit) nHits++;
        if (t1) top1++;
        caseRows.push({ id: q.id, hit, top1: t1 });
      }

      const a = await hybridQuery(conn.db, { brainId: "brain-a", query: SECRET_A, skipCache: true });
      const leak = await hybridQuery(conn.db, { brainId: "brain-a", query: SECRET_B, skipCache: true });
      const isolationOk = a.length > 0 && !responseContainsSecret(leak, SECRET_B);
      const nQueries = fixture.queries.length;
      const hitRate = nQueries === 0 ? 0 : nHits / nQueries;
      const top1Rate = nQueries === 0 ? 0 : top1 / nQueries;
      const ok = hitRate >= 0.8 && top1Rate >= 0.8 && isolationOk;

      const metrics = {
        hit_rate: hitRate,
        top1_rate: top1Rate,
        n_queries: nQueries,
        n_hits: nHits,
        isolation_ok: isolationOk,
        wipe_index: Boolean(opts.wipeIndex),
      };
      const receiptPath = await writeReceipt({
        id: "mini",
        kind: "mini",
        ts,
        ok,
        metrics,
        extra: { cases: caseRows, hitsA: a.length, leakB: responseContainsSecret(leak, SECRET_B) },
      });
      const summary = {
        ok,
        kind: "mini",
        hitsA: a.length,
        leakB: false,
        metrics,
        receipt: receiptPath,
      };
      console.log(JSON.stringify(summary));
      if (!ok) {
        console.error(
          opts.wipeIndex
            ? "mini failed as expected: index wiped without rebuild"
            : "mini failed: retrieval or isolation gate",
        );
        return 1;
      }
      return 0;
    } finally {
      await conn.close();
    }
  } finally {
    await ws.dispose();
  }
}
