import { MemoryError, ErrorCodes } from "@df-memory/core";

export async function readCommand(_argv: string[]): Promise<number> {
  throw new MemoryError(ErrorCodes.USAGE, "read 尚未实现（M2）");
}
