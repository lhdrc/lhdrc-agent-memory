import {
  MemoryError,
  ErrorCodes,
  loadRepoConfig,
  WriteQueue,
  pgliteIndexHooks,
  crystallizeExperiences,
  activateSkill,
  applySkillOutcome,
  applyExperienceOutcome,
  listSkills,
  appendMemoryDiff,
} from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadNoSourceContext } from "../context.ts";

export async function skillCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help") {
    console.log(`memory skill <crystallize|activate|outcome|list|experience-outcome>`);
    return 0;
  }
  const ctx = await loadNoSourceContext(rest.includes("--json"));
  const cfg = await loadRepoConfig(ctx.repoRoot);
  const queue = new WriteQueue(ctx.repoRoot, cfg, pgliteIndexHooks);

  switch (sub) {
    case "crystallize": {
      const o = parseArgs(rest, [
        { name: "trigger", type: "string" },
        { name: "experience", type: "string" },
        { name: "name", type: "string" },
        { name: "json", type: "boolean" },
      ]);
      const result = await crystallizeExperiences(ctx.repoRoot, {
        brainId: ctx.brainId,
        queue,
        trigger: o.trigger as string | undefined,
        experience: o.experience as string | undefined,
        name: o.name as string | undefined,
      });
      if (o.json) console.log(JSON.stringify(result));
      else {
        console.log(`crystallize: written=${result.written.length} skipped=${result.skipped}`);
        for (const p of result.written) console.log(`  ${p}`);
        if (result.reason) console.log(`  reason=${result.reason}`);
      }
      return 0;
    }
    case "activate": {
      const o = parseArgs(rest, [{ name: "json", type: "boolean" }]);
      const name = o._[0];
      if (!name) throw new MemoryError(ErrorCodes.USAGE, "skill activate 需要 <name>");
      const path = await activateSkill(ctx.repoRoot, ctx.brainId, name, queue);
      await appendMemoryDiff(ctx.repoRoot, ctx.brainId, {
        op: "skill_activate",
        paths_written: [path],
        paths_readonly_refs: [],
        decision: { name, status: "active" },
      });
      if (o.json) console.log(JSON.stringify({ path, status: "active" }));
      else console.log(`activated ${path}`);
      return 0;
    }
    case "outcome": {
      const o = parseArgs(rest, [
        { name: "success", type: "boolean" },
        { name: "fail", type: "boolean" },
        { name: "note", type: "string" },
        { name: "json", type: "boolean" },
      ]);
      const name = o._[0];
      if (!name) throw new MemoryError(ErrorCodes.USAGE, "skill outcome 需要 <name>");
      if (!o.success && !o.fail) {
        throw new MemoryError(ErrorCodes.USAGE, "skill outcome 需要 --success 或 --fail");
      }
      const result = await applySkillOutcome(ctx.repoRoot, ctx.brainId, name, queue, {
        success: Boolean(o.success) && !o.fail,
        note: o.note as string | undefined,
      });
      await appendMemoryDiff(ctx.repoRoot, ctx.brainId, {
        op: "skill_outcome",
        paths_written: [result.path],
        paths_readonly_refs: [],
        decision: { name, success: Boolean(o.success) && !o.fail, ...result },
      });
      if (o.json) console.log(JSON.stringify(result));
      else console.log(`outcome ${name}: eta=${result.eta_score} support=${result.support} status=${result.status}`);
      return 0;
    }
    case "list": {
      const o = parseArgs(rest, [
        { name: "status", type: "string" },
        { name: "json", type: "boolean" },
      ]);
      const status = o.status as "candidate" | "active" | "archived" | undefined;
      const items = await listSkills(ctx.repoRoot, ctx.brainId, status);
      if (o.json) console.log(JSON.stringify({ skills: items }));
      else {
        for (const s of items) console.log(`${s.status}\t${s.name}\t${s.title}`);
      }
      return 0;
    }
    case "experience-outcome": {
      const o = parseArgs(rest, [
        { name: "success", type: "boolean" },
        { name: "fail", type: "boolean" },
        { name: "note", type: "string" },
        { name: "json", type: "boolean" },
      ]);
      const id = o._[0];
      if (!id) throw new MemoryError(ErrorCodes.USAGE, "skill experience-outcome 需要 <experienceId>");
      if (!o.success && !o.fail) {
        throw new MemoryError(ErrorCodes.USAGE, "experience-outcome 需要 --success 或 --fail");
      }
      const rel = id.includes("/")
        ? id
        : `brains/${ctx.brainId}/experiences/${id.replace(/\.md$/, "")}.md`;
      const result = await applyExperienceOutcome(ctx.repoRoot, rel, queue, {
        success: Boolean(o.success) && !o.fail,
        note: o.note as string | undefined,
      });
      if (o.json) console.log(JSON.stringify(result));
      else console.log(`experience outcome: eta=${result.eta_score} support=${result.support}`);
      return 0;
    }
    default:
      throw new MemoryError(ErrorCodes.USAGE, `未知 skill 子命令: ${sub}`);
  }
}
