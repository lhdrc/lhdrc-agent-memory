# MVP Specs（CLI）

> **一句话**：人/脚本用 CLI 往一个 brain 里 ADD-only 写入 md，能查回来，索引丢了能 rebuild。  
> **状态**：ready  
> **技术栈**：Bun + TypeScript；PGLite；git；零 LLM 默认可跑。

## 实现顺序

| 顺序 | Spec | 文件 | 依赖 |
|---|---|---|---|
| 1 | M1 仓库与文件权威 | [`M1-repo-file-authority.md`](M1-repo-file-authority.md) | — |
| 2 | M2 写入与 CLI | [`M2-write-cli.md`](M2-write-cli.md) | M1 |
| 3 | M3 索引与查询 | [`M3-index-query.md`](M3-index-query.md) | M2 |

## 共享附件

| 文件 | 用途 |
|---|---|
| [`00-conventions.md`](00-conventions.md) | 仓库布局、命名、错误码、配置 |
| [`WRITE_FORMAT.md`](WRITE_FORMAT.md) | 写入校验规格（D14） |
| [`schema-packs/problem-tree.yml`](schema-packs/problem-tree.yml) | 默认 schema pack |

## 冻结的 CLI 命令面

```
memory init
memory capture
memory import
memory query
memory read
memory tree
memory forget
memory entity list|resolve|merge|create
memory rebuild-index
memory schema use
```

## MVP 总验收口令

```bash
bun run memory -- init ./demo
cd demo && bun run memory -- capture --title "重试策略" --type decision --body "改为固定3次"
bun run memory -- query "重试"
bun run memory -- rebuild-index
bun run memory -- query "重试"   # 结果语义一致
bun run memory -- entity create --slug alice --title "Alice"
bun run memory -- entity create --slug a-smith --title "A Smith" --alias alice
# 上面若 alias 冲突则改用 merge：
bun run memory -- entity merge alice a-smith --canonical alice --confirm
bun run memory -- rebuild-index
bun run memory -- entity resolve a-smith   # → alice
```

## 明确不做（二期）

MCP、REST、LLM 提取/蒸馏/结晶、向量检索、RRF、图谱、dream、多租户、硬删产品化。
