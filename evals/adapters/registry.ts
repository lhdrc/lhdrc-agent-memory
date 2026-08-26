import { locomoAdapter } from "./locomo.ts";
import { groupmembenchAdapter } from "./groupmembench.ts";
import { orgmembenchAdapter } from "./orgmembench.ts";
import type { EvalAdapter } from "./types.ts";

const REGISTRY: Record<string, EvalAdapter> = {
  locomo: locomoAdapter,
  groupmembench: groupmembenchAdapter,
  orgmembench: orgmembenchAdapter,
};

export function getAdapter(id: string): EvalAdapter {
  const a = REGISTRY[id];
  if (!a) {
    throw new Error(
      `未知 adapter: ${id}。已支持: ${Object.keys(REGISTRY).join(", ")}。仓内样例请加 --fixture，全量请 fetch --allow-net`,
    );
  }
  return a;
}

export function listAdapterIds(): string[] {
  return Object.keys(REGISTRY);
}
