import { parseSessionTurns, type Turn } from "@lhdrc/core";

/** 文件/stdin → Turn[]。compile 仍在 core（P6.4）。 */
export function parseSessionInput(text: string): Turn[] {
  return parseSessionTurns(text);
}

export default { id: "session", parse: parseSessionInput };
