# fixtures/distill

有经验 vs 无经验 mini-bench（规则代理，无 LLM）。

- `notes`：故意不含标准步骤
- `experiences`：含 gold 子串（retry / idempotent key / rebuild-index）
- 期望：`with_experience.recall >= without_experience.recall`
