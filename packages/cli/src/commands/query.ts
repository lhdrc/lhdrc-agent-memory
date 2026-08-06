import { MemoryError, ErrorCodes } from "@df-memory/core";

export async function queryCommand(_argv: string[]): Promise<number> {
  throw new MemoryError(ErrorCodes.USAGE, "query 尚未实现（M3）");
}
