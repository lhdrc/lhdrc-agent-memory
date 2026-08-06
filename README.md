# df-memory

开源、单机、本地部署的记忆模块——「agent 的 git + 知识库」。当前为 **CLI MVP**：可写可查的本地记忆仓，零 LLM、不强制联网。

技术栈：TypeScript strict + Bun workspaces；权威存储 = **md + frontmatter**；git = 可选批量账本（D18）；索引 = PGLite。

## 快速开始

```bash
bun install
bun run memory -- init ./demo
cd demo

bun run memory -- capture --title "重试策略" --type decision --body "改为固定3次"
bun run memory -- query "重试"
bun run memory -- rebuild-index
bun run memory -- query "重试"     # rebuild 前后结果语义一致
bun run memory -- sync --commit    # 可选：把 dirty 刷进 git 账本

bun run memory -- entity create --slug alice --title "Alice"
bun run memory -- entity create --slug bob --title "Bob"
bun run memory -- entity merge alice bob --canonical alice --confirm
bun run memory -- entity resolve bob   # → alice
```

## CLI 命令

```
memory init [dir] [--brain <id>] [--source <id>] [--force]
memory capture --title <t> --type <schema_type> --body <b> [--source] [--issue] [--tag]... [--alias]... [--fact]... [--created-by]
memory import <file|dir> [--source <id>]
memory query <text> [--limit N] [--source <id>] [--json]
memory read <path>
memory tree [path] [--depth N]
memory forget <path> [--by <id>]
memory entity <create|list|resolve|merge>
memory rebuild-index [--force]
memory schema use <packId>
memory sync --commit
```

`--json` 全局可选，机器可读输出；错误走 stderr，格式 `[E_XXX] 消息`。

## 设计要点

- **文件是真相（D1）**：内容存为 md + frontmatter；索引 `.dfmemory/pglite/` 可随时删除，`rebuild-index` 全量恢复。
- **git 批量账本（D18）**：默认不每写 commit；N/T/退出/`sync --commit` flush；entity merge 等强制即时 commit。
- **ADD-only（D17）**：L0 capture 只新建节点，不覆盖；重复 path → `E_CONFLICT`。
- **实体合并 = 文件事务（D13）**：merge 只改文件（canonical + redirect stub + `events/YYYY-MM/ledger.jsonl`），不先改索引。
- **写入管线（D14）**：所有写入经 `WRITE_FORMAT` 校验 + 单写者队列 + 跨进程文件锁。
- 查询：PGLite `simple` FTS + 中文 bigram ngram + title/path 加权。

## 开发

```bash
bun run test        # bun:test 全量（含真实 git + PGLite 集成）
bun run typecheck   # tsc --noEmit
```

规格见 [`specs/mvp/`](specs/mvp/)，工程约束见 [`AGENTS.md`](AGENTS.md)。
