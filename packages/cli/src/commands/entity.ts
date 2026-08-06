import { MemoryError, ErrorCodes, createEntityRegistry } from "@df-memory/core";
import { parseArgs, type ParsedArgs } from "../args.ts";
import { loadContext } from "../context.ts";

function usage(sub?: string): void {
  const help: Record<string, string> = {
    create: "memory entity create --slug <slug> --title <title> [--alias <a>]...",
    list: "memory entity list [--all]",
    resolve: "memory entity resolve <name>",
    merge: "memory entity merge <slug>... --canonical <slug> --confirm",
  };
  console.error(help[sub ?? ""] ?? "memory entity <create|list|resolve|merge>");
}

export async function entityCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const ctx = await loadContext(argv.includes("--json"));
  const registry = createEntityRegistry(ctx.repoRoot, ctx.brainId);

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
    default:
      usage();
      throw new MemoryError(ErrorCodes.USAGE, `未知 entity 子命令: ${sub ?? ""}`);
  }
}
