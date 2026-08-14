import { readFile } from "node:fs/promises";
import {
  captureNode,
  writeExperience,
  openPglite,
  thinkQuery,
  syncAll,
  refineSource,
  type LLMProvider,
  type CompleteResult,
  type DistillDecision,
  type ExperienceContext,
  type ExperienceResult,
} from "../packages/core/src/index.ts";
import { fixtureDir } from "./lib/paths.ts";
import { writeReceipt } from "./lib/receipt.ts";
import { createEvalWorkspace } from "./lib/workspace.ts";
import { goldHit, hitsToBlob, recall } from "./lib/rule-agent.ts";

interface DistillFixture {
  notes: Array<{ title: string; body: string }>;
  experiences: Array<{
    title: string;
    trigger: string;
    procedure: string;
    boundary: string;
  }>;
  questions: Array<{ id: string; query: string; gold: string[] }>;
}

function fixtureRefineLlm(experiences: DistillFixture["experiences"]): LLMProvider {
  let i = 0;
  return {
    id: "openai",
    async complete(): Promise<CompleteResult> {
      return { text: "{}" };
    },
    async judgeDistill(): Promise<DistillDecision> {
      return { candidate: "create", confidence: 1, rationale: "eval:distill" };
    },
    async generateAbstract(c: string) {
      return c.slice(0, 100);
    },
    async generateOverview(c: string[]) {
      return c.join("\n");
    },
    async refineExperience(_ctx: ExperienceContext): Promise<ExperienceResult> {
      const e = experiences[Math.min(i, experiences.length - 1)]!;
      i += 1;
      return {
        title: e.title,
        trigger: e.trigger,
        procedure: e.procedure,
        boundary: e.boundary,
        body: `${e.procedure}\n${e.boundary}`,
      };
    },
  };
}

export async function runDistill(
  opts: { json?: boolean; fixtureExperiences?: boolean } = {},
): Promise<number> {
  const fixture = JSON.parse(await readFile(fixtureDir("distill", "cases.json"), "utf8")) as DistillFixture;
  const ws = await createEvalWorkspace({ brain: "default" });
  const ts = new Date().toISOString();
  try {
    const sourcePaths: string[] = [];
    for (const n of fixture.notes) {
      const p = await captureNode(ws.repoRoot, ws.pack, ws.queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: n.title,
        body: n.body,
        createdBy: "eval:distill",
      });
      sourcePaths.push(p);
    }

    const scoreQuestions = async (db: Parameters<typeof thinkQuery>[0]) => {
      const flags: boolean[] = [];
      for (const q of fixture.questions) {
        const thought = await thinkQuery(db, {
          brainId: "default",
          query: q.query,
          repoRoot: ws.repoRoot,
          limit: 10,
        });
        const blob = hitsToBlob([...thought.experiences, ...thought.notes, ...thought.skills]);
        flags.push(goldHit(blob, q.gold));
      }
      return recall(flags);
    };

    let withoutExperience: ReturnType<typeof recall>;
    const conn1 = await openPglite(ws.repoRoot);
    try {
      await syncAll(conn1.db, ws.repoRoot, "default");
      withoutExperience = await scoreQuestions(conn1.db);
    } finally {
      await conn1.close();
    }

    let usedRefine = false;
    let written = 0;

    if (opts.fixtureExperiences) {
      for (const e of fixture.experiences) {
        await writeExperience(ws.repoRoot, ws.pack, ws.queue, {
          brainId: "default",
          title: e.title,
          trigger: e.trigger,
          procedure: e.procedure,
          boundary: e.boundary,
          sourcePaths: sourcePaths.length > 0 ? sourcePaths : ["sources/default/notes/placeholder.md"],
        });
      }
      written = fixture.experiences.length;
    } else {
      const refine = await refineSource(ws.repoRoot, {
        brainId: "default",
        queue: ws.queue,
        llm: fixtureRefineLlm(fixture.experiences),
      });
      usedRefine = true;
      written = refine.written;
      if (written < 1) {
        console.error("eval:distill refineSource written=0；需要 DF_MEMORY_MOCK_COMPLETE_DISTILL 或 openai key，或检查 fixture");
        return 1;
      }
    }

    const conn2 = await openPglite(ws.repoRoot);
    try {
      await syncAll(conn2.db, ws.repoRoot, "default");
      const withExperience = await scoreQuestions(conn2.db);

      const ok = withExperience.recall >= withoutExperience.recall && (!usedRefine || written >= 1);
      const metrics = {
        with_experience: withExperience,
        without_experience: withoutExperience,
        used_refine: usedRefine,
        written,
      };
      const receiptPath = await writeReceipt({
        id: "distill",
        kind: "distill",
        ts,
        ok,
        metrics,
      });
      const summary = { ok, kind: "distill", metrics, receipt: receiptPath, used_refine: usedRefine, written };
      console.log(JSON.stringify(summary));
      return ok ? 0 : 1;
    } finally {
      await conn2.close();
    }
  } finally {
    await ws.dispose();
  }
}
