# Distill refine v1

You write one **experience** record (also used when synthesizing a skill-shaped procedure from a cluster).
The system validates JSON and writes files. You only fill the five fields.
Do not invent path, `[[wikilink]]`, `@slug`, YAML frontmatter, `eta_score`, `source_paths`, or `status`.

## Output

Return **only** a JSON object (no markdown fence if possible):

```json
{ "title": "…", "trigger": "…", "procedure": "…", "boundary": "…", "body": "…" }
```

All five strings required. `title` 1–200 characters.

## Field contract

| field | write | do not write |
|---|---|---|
| `title` | one retrievable experience name | bucket titles like 项目讨论, 会议纪要, project discussion |
| `trigger` | **when** to use this: situation / symptom / task type | this diff, a one-off issue id as the only trigger |
| `procedure` | numbered, executable steps | the whole L0, stack traces, dumps |
| `boundary` | applies / does not apply | empty, or 「见原文」 with no content |
| `body` | short text for retrieval; may include `## Procedure` / `## Boundary` / `## Verification` | path, wikilink, YAML, `@slug` |

Write `title` / `trigger` / `procedure` / `boundary` / `body` in the **same language as the candidate**. Keep code identifiers unchanged.

Do **not** add a `verification` JSON field. If you suggest how to check the result, put it under `## Verification` inside `body`. The system fills skill `verification` itself.

## Task (see user prompt)

The user message starts with `## Task`. Honor it:

- **Write a new experience** — extract trigger / procedure / boundary from the candidate. Prefer create-quality: a future agent must know when and how to reuse this.
- **Merge** — keep old valid steps; add what the candidate introduces; do not drop still-correct procedure. `trigger` stays the shared WHEN.
- **Synthesize** (skill-shaped, from a cluster) — one generalized procedure; shared WHEN as `trigger`; drop instance-only names and one-off ids. Same five fields; do not switch schema.

Be concise. Trigger = WHEN. Procedure = numbered how-to. Boundary = scope.

## Exclude

- Dumping the candidate verbatim into every field
- Inventing extra JSON keys
- Cursor Agent Skill fields (`description`, `disable-model-invocation`)
- Empty `boundary`

## Few-shot

Task: Write a new experience from the candidate.
Candidate: schema_type=decision, title=重试改为固定3次, body=支付网关超时改为固定重试 3 次，不再用指数退避。仅幂等请求可重试。

```json
{
  "title": "网关超时固定重试3次",
  "trigger": "支付或网关超时应重试",
  "procedure": "1. 将重试改为固定 3 次\n2. 去掉指数退避\n3. 仅对幂等请求启用重试",
  "boundary": "适用于支付类同步调用；不适用于非幂等写或异步队列",
  "body": "## Procedure\n1. 将重试改为固定 3 次\n2. 去掉指数退避\n3. 仅对幂等请求启用重试\n\n## Boundary\n适用于支付类同步调用；不适用于非幂等写或异步队列\n"
}
```
