# generic-jsonl 摄取适配器

仓内 JSONL → `captureNode`（不直写 sources）。

## 字段

| JSONL 字段 | 记忆仓 |
|---|---|
| `title` | 必填 |
| `body` / `content` / `text` | 正文 |
| `type` / `schema_type` | 默认 `note` |
| `source` / `source_id` | source；缺省用 CLI `--source` / 仓默认 |
| `tags` | 可选字符串数组 |

```bash
memory ingest --adapter generic-jsonl --input ./packages/adapters/ingest-generic-jsonl/fixtures/two-notes.jsonl --json
```

退出码：全成功 0；有非法行且未 `--continue-on-error` → 2；`--continue-on-error` 时坏行进 `errors`，好行落盘，仍有错误则 2。
