import { MemoryError, ErrorCodes } from "@df-memory/core";

export async function treeCommand(_argv: string[]): Promise<number> {
  throw new MemoryError(ErrorCodes.USAGE, "tree 尚未实现（M2）");
}
