# MVP 工程约定

> 所有 MVP Spec 共用。实现时不得偏离，除非提交 ADR 修订 08 方案。

## 1. 技术栈锁定

| 项 | 选型 | 备注 |
|---|---|---|
| 语言 | TypeScript（strict） | `strict: true` |
| 运行时 | Bun ≥ 1.1 | 用 `bun test` / `bun build` |
| 包管理 | Bun workspaces | 根 `package.json` workspaces |
| 权威存储 | 本地 md + YAML frontmatter | `gray-matter` 或等价 |
| 版本账本 | git（系统 git CLI 或 `isomorphic-git`） | MVP 优先调用本机 `git` |
| 索引 | `@electric-sql/pglite` | 数据文件落 `.dfmemory/pglite/` |
| YAML | `yaml` 包 | brain.yml / memory.yml / schema pack |
| CLI 解析 | Bun 原生 + 轻量解析（如 `citty` 或自研） | 二进制入口名 `memory` |

**禁止**：引入云向量库、引入必须联网的默认依赖、在 MVP 调用任何 LLM API。

## 2. Monorepo 布局（MVP 最小）

```
/
├── package.json                 # workspaces
├── packages/
│   ├── core/                    # 文件权威、校验、实体、写队列、索引、检索
│   │   ├── package.json         # name: @df-memory/core
│   │   └── src/
│   │       ├── repo/            # init、路径、brain 树
│   │       ├── schema/          # schema pack 加载
│   │       ├── write/           # WRITE_FORMAT、队列、git commit
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
| 内容 hash | SHA-256 hex of UTF-8 file bytes（含 frontmatter） |

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
| `E_GIT` | 500 | git 操作失败 |
| `E_INDEX` | 500 | 索引损坏/查询失败 |
| `E_INTERNAL` | 500 | 未分类 |

退出码：成功 `0`；用户错误 `2`；系统错误 `1`。

## 5. 配置文件

### 5.1 仓根 `memory.yml`

```yaml
version: 1
brain_id: default
schema_pack: problem-tree
git:
  auto_commit: true
  commit_prefix: "memory:"
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

## 6. `.dfmemory/` 内容（非 git 权威记忆）

```
.dfmemory/
├── write.lock          # 跨进程写锁
├── pglite/             # PGLite 数据目录（可 gitignore）
├── index-meta.json     # { schemaVersion, lastSyncAt, fileCount }
└── logs/               # 可选
```

建议根 `.gitignore` 忽略 `.dfmemory/pglite/`；`memory.yml` 与 md 记忆进 git。

## 7. 测试基线

- 框架：`bun:test`
- 集成测试使用临时目录 + 真实 `git init` + 真实 PGLite
- 每个 Spec 的「验收用例」必须有对应测试文件名约定：`packages/core/tests/m1_*.test.ts` 等
