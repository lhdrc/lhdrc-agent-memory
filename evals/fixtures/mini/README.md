# fixtures/mini

检索回归夹具（P5.6 / 08 §17.1：12 条查询）。运行时 harness 另注入 isolation secret A/B，不提交真实密钥。

- `cases.json`：`brain-a` 笔记 + 12 条 `expect_substr` 查询
- 期望：hit_rate≥80%、top1_rate≥80%；`brain-a` 查询不含 secret B
- 清空索引不 rebuild → mini 非 0
