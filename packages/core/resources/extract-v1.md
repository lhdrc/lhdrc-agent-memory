# Extract facts v1

Extract concise factual statements from a markdown note body.
The system appends them to frontmatter. You only return JSON.

Return **only** a JSON object (no markdown fence if possible):

```json
{ "facts": [ { "text": "…", "event_type": "note", "attributed_to": "cli:user", "at": "2026-08-14" } ] }
```

## Field contract

| field | write |
|---|---|
| `text` | one atomic fact, non-empty, ≤2000 characters |
| `event_type` | copy from the user prompt default unless the body clearly differs |
| `attributed_to` | copy from the user prompt default |
| `at` | `YYYY-MM-DD`; copy from the user prompt default |

## Rules

- Prefer list items and `##` headings as fact candidates. Skip headings `摘要` / `正文`.
- Do not rewrite or summarize the source; copy the fact wording closely.
- Preserve original wording before compress; keep names/numbers; no invent.
- preserve original wording before compress; keep names/numbers; no invent
- Drop empty, duplicate, or uncertain items.
- No facts → `{ "facts": [] }`.
- Do not invent paths, `[[wikilink]]`, `@slug`, or YAML.
