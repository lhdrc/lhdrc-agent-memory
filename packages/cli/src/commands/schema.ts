import { MemoryError, ErrorCodes } from "@df-memory/core";

export async function schemaCommand(_argv: string[]): Promise<number> {
  throw new MemoryError(ErrorCodes.USAGE, "schema 尚未实现（M2）");
}
