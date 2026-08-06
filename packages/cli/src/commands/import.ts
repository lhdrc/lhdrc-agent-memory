import { MemoryError, ErrorCodes } from "@df-memory/core";

export async function importCommand(_argv: string[]): Promise<number> {
  throw new MemoryError(ErrorCodes.USAGE, "import 尚未实现（M2）");
}
