import { MemoryError, ErrorCodes } from "@df-memory/core";

export async function forgetCommand(_argv: string[]): Promise<number> {
  throw new MemoryError(ErrorCodes.USAGE, "forget 尚未实现（M2）");
}
