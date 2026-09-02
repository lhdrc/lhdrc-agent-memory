# Abstract v1

Write a short L0 abstract of the markdown body for retrieval.

Return **plain text only** (no JSON, no YAML, no wikilink, no `@slug`).
You may wrap the whole answer in one markdown fence; the system will unwrap it.

## Rules

- One short paragraph, same language as the body.
- Keep concrete names, decisions, and numbers.
- Preserve original wording before compress; keep names/numbers; no invent.
- preserve original wording before compress; keep names/numbers; no invent
- Do not invent facts that are not in the body.
- Prefer original wording over vague summary.
- Empty body → empty output.
