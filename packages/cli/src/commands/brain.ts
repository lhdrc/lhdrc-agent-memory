import {
  MemoryError,
  ErrorCodes,
  createBrain,
  listBrains,
  isSlug,
} from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadNoSourceContext } from "../context.ts";

export async function brainCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help") {
    console.log(`memory brain <create|list>`);
    return 0;
  }
  const ctx = await loadNoSourceContext(rest.includes("--json"));

  switch (sub) {
    case "create": {
      const o = parseArgs(rest, [
        { name: "source", type: "string" },
        { name: "name", type: "string" },
        { name: "json", type: "boolean" },
      ]);
      const id = o._[0];
      if (!id) throw new MemoryError(ErrorCodes.USAGE, "brain create 需要 <id>");
      if (!isSlug(id)) throw new MemoryError(ErrorCodes.VALIDATION, `非法 brain id: ${id}`);
      await createBrain(ctx.repoRoot, id, {
        source: (o.source as string) ?? "default",
        name: o.name as string | undefined,
      });
      if (o.json) console.log(JSON.stringify({ id, created: true }));
      else console.log(`created brain ${id}`);
      return 0;
    }
    case "list": {
      const o = parseArgs(rest, [{ name: "json", type: "boolean" }]);
      const brains = await listBrains(ctx.repoRoot);
      if (o.json) console.log(JSON.stringify({ brains }));
      else {
        for (const b of brains) console.log(`${b.id}\t${b.name}\t${b.schema_pack}`);
      }
      return 0;
    }
    default:
      throw new MemoryError(ErrorCodes.USAGE, `未知 brain 子命令: ${sub}`);
  }
}
