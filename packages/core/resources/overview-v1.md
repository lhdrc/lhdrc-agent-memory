# Overview v1

Write an L1 overview from the given child text(s) (usually one node body).

Return **plain text only** (no JSON, no YAML, no wikilink, no `@slug`).
You may wrap the whole answer in one markdown fence; the system will unwrap it.

## Rules

- Same language as the source.
- Keep structure: decisions, steps, and boundaries.
- Preserve original wording before compress; keep names/numbers; no invent.
- preserve original wording before compress; keep names/numbers; no invent
- Prefer original wording over vague summary.
- Do not invent facts not in source; keep names/numbers verbatim.
- Empty input → empty output.
