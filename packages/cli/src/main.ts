#!/usr/bin/env bun
import { MemoryError, isUserError } from "@df-memory/core";
import { run } from "./run.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  try {
    const code = await run(argv);
    process.exit(code ?? 0);
  } catch (e) {
    const wantJson = argv.includes("--json");
    if (e instanceof MemoryError) {
      const msg = wantJson
        ? JSON.stringify({ error: { code: e.code, message: e.message, details: e.details } })
        : `[${e.code}] ${e.message}`;
      console.error(msg);
      process.exit(isUserError(e.code) ? 2 : 1);
    }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

main();
