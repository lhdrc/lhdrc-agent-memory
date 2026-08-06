import { MemoryError, ErrorCodes } from "@df-memory/core";

export async function captureCommand(_argv: string[]): Promise<number> {
  throw new MemoryError(ErrorCodes.USAGE, "capture 尚未实现（M2）");
}
