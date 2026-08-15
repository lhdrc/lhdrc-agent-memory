# MVP 工程约定

> 所有 MVP Spec 共用。实现时不得偏离，除非提交 ADR 修订 08 方案。  
> **文件权威 / git 账本**：对齐 08 **D1 / D18**——热路径不借 git；git 为可选批量账本。

## 1. 技术栈锁定

| 项 | 选型 | 备注 |
|---|---|---|
| 语言 | TypeScript（strict） | `strict: true` |
| 运行时 | Bun ≥ 1.1 | 用 `bun test` / `bun build` |
| 包管理 | Bun workspaces | 根 `package.json` workspaces |
| 权威存储 | 本地 md + YAML frontmatter | **文件是真相**（D1）；`gray-matter` 或等价 |
| 版本账本 | git（可选批量 flush，D18） | MVP 优先本机 `git` CLI；**不是**每次写入的必要条件 |
| 索引 | `@electric-sql/pglite` | 数据文件落 `.dfmemory/pglite/`；可丢可 `rebuild-index` |
| YAML | `yaml` 包 | brain.yml / memory.yml / schema pack |
| CLI 解析 | Bun 原生 + 轻量解析（如 `citty` 或自研） | 二进制入口名 `memory` |

**禁止**：引入云向量库、引入必须联网的默认依赖、在 MVP 调用任何 LLM API。

## 2. Monorepo 布局（MVP 最小）

```
/
├── package.json                 # workspaces
├── packages/
│   ├── core/                    # 文件权威、校验、实体、写队列、索引、检索
│   │   ├── package.json         # name: @lhdrc/core
│   │   └── src/
│   │       ├── repo/            # init、路径、brain 树、git flush 辅助
│   │       ├── schema/          # schema pack 加载
│   │       ├── write/           # WRITE_FORMAT、队列、dirty/flush（D18）
│   │       ├── entity/          # registry create/resolve/merge
│   │       ├── index/           # PGLite schema、sync、rebuild
│   │       └── retrieve/        # BM25 + path/title
│   └── cli/                     # name: @df-memory/cli；bin: memory
│       └── src/
│           ├── main.ts
│           └── commands/
├── specs/                       # 本目录（规格，不进运行时）
└── reports/                     # 架构文档
```

入口：`packages/cli` 的 `bin.memory` → `bun run` 可执行。

## 3. 路径与 ID 规则

| 概念 | 规则 |
|---|---|
| `brainId` | `[a-z0-9][a-z0-9_-]{0,63}`，`init` 默认 `default` |
| `sourceId` | 同上；默认 `default` |
| `slug`（实体） | `[a-z0-9][a-z0-9_-]{0,127}`，小写 |
| 记忆节点相对 path | 相对 `brains/{brainId}/sources/{sourceId}/`，禁止 `..` |
| 绝对仓内 path | 必须以 `brains/{brainId}/` 开头（租户内容） |
| 内容 hash | SHA-256 hex；MVP 可用整文件 UTF-8 字节；演进应对齐 08 §5.3（剔除 `captured_at` 等易变 frontmatter） |

路径越界判定：解析后的绝对路径若不在允许前缀内 → `E_PATH_ESCAPE`。

## 4. 统一错误码

CLI 与 core 共用字符串错误码（stderr JSON 可选 `--json`）：

| 码 | HTTP 映射（二期） | 含义 |
|---|---|---|
| `E_USAGE` | 400 | 参数错误 |
| `E_VALIDATION` | 400 | WRITE_FORMAT / schema 校验失败 |
| `E_NOT_FOUND` | 404 | 路径/实体不存在 |
| `E_CONFLICT` | 409 | 路径已存在（ADD-only）或 merge 缺确认 |
| `E_PATH_ESCAPE` | 403 | 越出 brain/source 边界 |
| `E_LOCK` | 423 | 拿不到写锁 |
| `E_GIT` | 500 | git flush / init 等操作失败（**不**表示文件写入失败） |
| `E_INDEX` | 500 | 索引损坏/查询失败 |
| `E_INTERNAL` | 500 | 未分类 |
| `E_DISABLED` | 503 | 能力关闭（llm/embedding provider=off、kill-switch、缺 key、cost cap） |
| `E_LLM` | 502 | LLM HTTP/解析失败（inbox 标 failed；**不**写 L0） |
| `E_TIMEOUT` | 504 | 异步任务超过 `compile.job_timeout_ms`（八期 P8.1） |
| `E_JOB` | 500 | 任务文件损坏 / 状态非法 / `task_id` 不存在（八期 P8.1） |

退出码：成功 `0`；用户错误 `2`；系统错误 `1`。

> **语义**：热路径写文件成功后若仅 flush 失败 → warn / `E_GIT` 视命令而定，**不得**回滚已落盘文件（D1）。

## 5. 配置文件

### 5.1 仓根 `memory.yml`

```yaml
version: 1
brain_id: default
schema_pack: problem-tree
git:
  mode: batch                 # off | batch | per_write（见 §8）
  auto_commit: true           # batch 下启用 N/T 自动 flush；mode=off 时忽略
  commit_prefix: "memory:"
  batch_size: 20
  batch_interval_ms: 300000   # 5 min
  force_commit_on:
    - entity_merge
    - schema_use
    - purge
index:
  engine: pglite
  path: .dfmemory/pglite
writer:
  lock_file: .dfmemory/write.lock
  lock_timeout_ms: 30000
```

### 5.2 `brains/{id}/brain.yml`

```yaml
id: default
name: Default Brain
schema_pack: problem-tree
sources:
  default: default
created_at: "2026-08-06T00:00:00Z"
```

### 5.3 环境变量覆盖

| Env | 覆盖 |
|---|---|
| `DF_MEMORY_ROOT` | 仓根路径（默认 cwd 向上找 `memory.yml`） |
| `DF_MEMORY_SOURCE` | 默认 source |
| `DF_MEMORY_BRAIN` | 默认 brain（MVP 仅单 brain，校验一致即可） |

## 6. `.dfmemory/` 内容（非权威记忆）

```
.dfmemory/
├── write.lock          # 跨进程写锁
├── pglite/             # PGLite 数据目录（gitignore）
├── inbox/              # 六期：会话原文队列（gitignore；非 L0）
├── jobs/               # 八期：异步 compile / remember 任务状态（gitignore；非 L0）
├── index-meta.json     # { schemaVersion, lastSyncAt, fileCount }
├── git-dirty.json      # 可选：待 flush 路径集合（实现可换内存+落盘）
└── logs/               # 可选
```

建议根 `.gitignore` 忽略：

```
.dfmemory/pglite/
.dfmemory/write.lock
.dfmemory/inbox/
.dfmemory/jobs/
.dfmemory/index-meta.json
.dfmemory/git-dirty.json
```

`memory.yml` 与 `brains/**` md **进 git**（flush 后）。

## 7. 测试基线

- 框架：`bun:test`
- 集成测试使用临时目录 + 真实 `git init`（init 仍建仓）+ 真实 PGLite
- **不要**默认断言「每次 capture 都产生一条 git commit」（除非 `mode: per_write` 或显式 `sync --commit` / 强制路径）
- 每个 Spec 的「验收用例」必须有对应测试：`packages/core/tests/m1_*.test.ts` 等

## 8. git 批量账本（D18，MVP 必遵）

> 写事务原子边界 = **单写者锁 + 磁盘 md + 索引投影**，不是 `git commit`。

### 8.1 模式

| `git.mode` | 含义 |
|---|---|
| `batch` | **默认**：热路径只写文件 + 索引 + 标记 dirty；按触发 flush |
| `off` | 永不自动/强制 commit；**仅**显式 `memory sync --commit`（merge/schema 也不即时提交） |
| `per_write` | 兼容旧行为：每次成功写入都 commit（调试/迁移） |

### 8.2 Flush 触发（`mode: batch` 且 `auto_commit: true`）

| 触发 | 默认 | 行为 |
|---|---|---|
| 条数 N | `batch_size: 20` | dirty 累计 ≥ N → 一次 commit |
| 时间 T | `batch_interval_ms: 300000` | 距上次 commit ≥ T 且仍有 dirty → flush |
| 显式 | `memory sync --commit` | 有 dirty 才提交；无则 no-op |
| 退出 | CLI 正常退出 | best-effort flush；失败只 warn |
| 强制 | `force_commit_on` 白名单 | **立刻单独 commit**（entity_merge / schema_use / purge） |
| 不触发 | hash 未变 no-op、query/read/rebuild-index | 禁止空 commit |

一次 flush = 一个 commit，包含窗口内全部 dirty 路径；消息形如 `memory: flush 12 files`。  
强制路径单独消息，例如 `memory: entity merge bob -> alice`。

### 8.3 心智对照（GBrain）

| git | df-memory |
|-----|-----------|
| 工作区 | 磁盘 md（权威） |
| 对象库 | PGLite pages/…（可重建） |
| blob 哈希 | `content_hash` |
| 提交历史 | flush 后的 `git log`（可选账本） |
