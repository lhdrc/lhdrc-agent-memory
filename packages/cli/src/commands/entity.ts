import { MemoryError, ErrorCodes, createEntityRegistry } from "@lhdrc/core";
import { parseArgs, type ParsedArgs } from "../args.ts";
import { loadContext } from "../context.ts";
import { createQueue } from "../services.ts";

function usage(sub?: string): void {
  const help: Record<string, string> = {
    create: "memory entity create --slug <slug> --title <title> [--alias <a>]...",
    list: "memory entity list [--all]",
    resolve: "memory entity resolve <name>",
    merge: "memory entity merge <slug>... --canonical <slug> --confirm",
    "link-facts": "memory entity link-facts <slug> --fact <text> [--path <rel>]",
  };
  console.error(help[sub ?? ""] ?? "memory entity <create|list|resolve|merge|link-facts>");
}

export async function entityCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const ctx = await loadContext(argv.includes("--json"));
  const queue = await createQueue(ctx.repoRoot);
  const registry = createEntityRegistry(ctx.repoRoot, ctx.brainId, queue);

  switch (sub) {
    case "create": {
      const o = parseArgs(rest, [
        { name: "slug", type: "string" },
        { name: "title", type: "string" },
        { name: "alias", type: "string[]" },
        { name: "json", type: "boolean" },
      ]);
      if (!o.slug || !o.title) {
        usage("create");
        throw new MemoryError(ErrorCodes.USAGE, "entity create 需要 --slug 与 --title");
      }
      const e = await registry.create({
        slug: o.slug as string,
        title: o.title as string,
        aliases: (o.alias as string[]) ?? [],
        createdBy: "cli:user",
      });
      if (o.json) console.log(JSON.stringify(e));
      else console.log(e.slug);
      return 0;
    }
    case "list": {
      const o = parseArgs(rest, [
        { name: "all", type: "boolean" },
        { name: "json", type: "boolean" },
      ]);
      const entities = await registry.list({ includeMerged: Boolean(o.all) });
      if (o.json) {
        console.log(JSON.stringify(entities));
      } else {
        for (const e of entities) console.log(e.slug + (e.status === "merged" ? " (merged)" : ""));
      }
      return 0;
    }
    case "resolve": {
      const o = parseArgs(rest, [
        { name: "json", type: "boolean" },
        { name: "help", type: "boolean" },
      ]);
      const name = o._[0] as string | undefined;
      if (!name) {
        usage("resolve");
        throw new MemoryError(ErrorCodes.USAGE, "entity resolve 需要一个名称");
      }
      const e = await registry.resolve(name);
      if (o.json) console.log(JSON.stringify(e));
      else console.log(e.slug);
      return 0;
    }
    case "merge": {
      const o = parseArgs(rest, [
        { name: "canonical", type: "string" },
        { name: "confirm", type: "boolean" },
        { name: "by", type: "string" },
        { name: "json", type: "boolean" },
      ]);
      const slugs = o._ as string[];
      if (slugs.length < 2 || !o.canonical) {
        usage("merge");
        throw new MemoryError(ErrorCodes.USAGE, "entity merge 需要至少两个 slug 与 --canonical");
      }
      const merged = await registry.merge({
        entityIds: slugs,
        canonical: o.canonical as string,
        confirm: Boolean(o.confirm),
        mergedBy: (o.by as string) ?? "cli:user",
      });
      if (o.json) console.log(JSON.stringify(merged));
      else console.log(`merged -> ${merged.slug}`);
      return 0;
    }
    case "link-facts": {
      const o = parseArgs(rest, [
        { name: "fact", type: "string" },
        { name: "path", type: "string" },
        { name: "json", type: "boolean" },
      ]);
      const slug = o._[0] as string | undefined;
      const fact = o.fact as string | undefined;
      if (!slug || !fact) {
        usage("link-facts");
        throw new MemoryError(ErrorCodes.USAGE, "entity link-facts 需要 <slug> 与 --fact");
      }
      const e = await registry.linkFacts({
        slug,
        fact,
        path: o.path as string | undefined,
        by: "cli:user",
      });
      if (o.json) console.log(JSON.stringify({ slug: e.slug, facts: e.facts ?? [] }));
      else console.log(`linked ${e.slug}`);
      return 0;
    }
    default:
      usage();
      throw new MemoryError(ErrorCodes.USAGE, `未知 entity 子命令: ${sub ?? ""}`);
  }
}
