import { MemoryError, ErrorCodes } from "@df-memory/core";

export async function rebuildIndexCommand(_argv: string[]): Promise<number> {
  throw new MemoryError(ErrorCodes.USAGE, "rebuild-index 尚未实现（M3）");
}
