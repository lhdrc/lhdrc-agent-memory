# df-app 摄取适配器

**不**把 df-app 硬编码进 core（08 **D9**）。本包只转换**仓内 fixture**（模拟导出 JSONL），不依赖真实 df-app 进程。

相对真 df-app：夹具 pin 为 `session` + `message.{role,text|content}`；若上游改字段，只改本包 `map()` / 本表，不改 core。

## 映射表

| df-app 导出（fixture） | 记忆仓 |
|---|---|
| `session` / `session_id` | `source` |
| `message.text` / `message.content` / `message.body` | note `body` |
| `title` / `topic` / 正文首行 | `title` |
| （固定） | `schema_type: note` |

```bash
memory ingest --adapter df-app --input ./packages/adapters/ingest-df-app/fixtures/sample-export.jsonl --json
```
