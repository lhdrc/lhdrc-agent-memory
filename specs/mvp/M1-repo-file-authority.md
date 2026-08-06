# Spec M1 — 仓库骨架与文件权威

| 字段 | 值 |
|---|---|
| ID | M1 |
| 状态 | ready |
| 依赖 | 无 |
| 技术栈 | 见 [`00-conventions.md`](00-conventions.md) |
| 对应架构 | 08 §4、§4.5.1、§5.1、§5.4、D1/D2/D13 |

## 1. 目标

实现「记忆 = git 仓库里的 md 文件树」：

1. `memory init <dir>` 创建完整仓布局与 git 仓库  
2. 加载默认 schema pack `problem-tree`  
3. Entity registry：**create / resolve / merge（文件事务）**  
4. 路径边界工具：`brainScope` / `sourceScope` / 防 `..` 越界  

## 2. 非目标

- 不实现 PGLite 索引（M3）  
- 不实现 capture/query CLI 全套（M2/M3）；本 Spec 可提供 core API + `init`/`entity` CLI 子集  
- 不实现 LLM、蒸馏、experiences 写入管线（目录仅空壳）  
- 不实现多 brain  

## 3. 包落点

```
packages/core/src/repo/
  init.ts          # initMemoryRepo(dir, opts)
  layout.ts        # 路径拼接与校验
  brain.ts         # 读 brain.yml
  git.ts           # gitInit, gitAddCommit
packages/core/src/schema/
  loadPack.ts      # 加载 YAML pack
packages/core/src/entity/
  registry.ts      # create, resolve, merge, list
  types.ts
packages/cli/src/commands/
  init.ts
  entity.ts        # create|list|resolve|merge
```

将 `specs/mvp/schema-packs/problem-tree.yml` **复制或打包**到 `packages/core/schema-packs/problem-tree.yml`（运行时从此读）。

## 4. 仓布局（init 必须创建）

对 `memory init ./demo --brain default`：

```
demo/
├── memory.yml
├── .gitignore                 # 忽略 .dfmemory/pglite/
├── .git/                      # git init
├── .dfmemory/
│   ├── index-meta.json        # {"schemaVersion":1,"lastSyncAt":null,"fileCount":0}
│   └── logs/
└── brains/default/
    ├── brain.yml
    ├── sources/default/
    │   └── .dfmemory-source   # 内容见下
    ├── sources/default/issues/   # 空目录占位
    ├── entities/              # 空
    ├── events/                # 空（merge 时创建 YYYY-MM/）
    ├── experiences/           # 空壳
    ├── skills/                # 空壳
    └── contradictions.md      # 可选：仅含标题 "# Contradictions\n"
```

### 4.1 `memory.yml`

见 [`00-conventions.md`](00-conventions.md) §5.1。

### 4.2 `brain.yml`

见 §5.2。

### 4.3 `.dfmemory-source`

```yaml
source_id: default
brain_id: default
```

### 4.4 `.gitignore` 最小内容

```
.dfmemory/pglite/
.dfmemory/write.lock
```

### 4.5 首 commit

`git add -A && git commit -m "memory: init brain default"`  
若环境无 git：失败 `E_GIT`，init 中止并清理或不留半成品（推荐事务：先写临时再 rename，或失败删目录——文档化一种即可；**推荐失败时删除新建目录**）。

## 5. 路径 API（必须单测）

```ts
function resolveBrainRoot(repoRoot: string, brainId: string): string
function resolveSourceRoot(repoRoot: string, brainId: string, sourceId: string): string
/** 将用户相对 path 规范为仓内相对 POSIX path；含 .. 则抛 E_PATH_ESCAPE */
function normalizeRepoPath(repoRoot: string, brainId: string, candidate: string): string
function assertUnderPrefix(fullPath: string, prefix: string): void
```

规则：

- 一律用 POSIX `/` 存相对路径  
- Windows 上 `path.resolve` 后仍校验前缀  
- 租户文件禁止写到 `brains/{id}/` 之外（`.dfmemory` 除外）  

## 6. Entity 文件格式

### 6.1 活实体 `brains/{id}/entities/{slug}.md`

```markdown
---
title: Alice
schema_type: entity
slug: alice
status: active
aliases: [alice, Alice Zhang]
external_ids: []
created_at: "2026-08-06T00:00:00Z"
updated_at: "2026-08-06T00:00:00Z"
---
## 摘要

## 正文
```

### 6.2 Redirect stub（merge 后的 loser）

```markdown
---
title: A Smith
schema_type: entity
slug: a-smith
status: merged
redirect: alice
merged_at: "2026-08-06T01:00:00Z"
merged_by: cli:user
---
```

正文可空。`status: merged` 的文件**不得**被当作活实体列出（`entity list` 默认过滤）。

### 6.3 事件 `entity_merged`

路径：`brains/{id}/events/{YYYY-MM}/entity_merged-{timestamp}-{from}-{to}.jsonl`  
或单文件 append：`brains/{id}/events/{YYYY-MM}/ledger.jsonl`（**推荐后者**，一行一事件）。

行 JSON：

```json
{
  "type": "entity_merged",
  "from": ["a-smith"],
  "to": "alice",
  "by": "cli:user",
  "at": "2026-08-06T01:00:00Z"
}
```

MVP：Event ledger **只要求支持 append `entity_merged`**；完整查询 API 二期。

## 7. EntityRegistry 行为

```ts
interface EntityRegistry {
  create(input: {
    slug: string;
    title: string;
    aliases?: string[];
    externalIds?: string[];
    createdBy: string;
  }): Promise<Entity>;

  resolve(aliasOrSlug: string): Promise<Entity>; // 跟随 redirect depth≤2

  list(opts?: { includeMerged?: boolean }): Promise<Entity[]>;

  merge(input: {
    entityIds: string[];       // slug 列表，≥2
    canonical: string;         // 必须是其一
    confirm: boolean;          // false → E_CONFLICT
    mergedBy: string;
  }): Promise<Entity>;
}
```

### 7.1 create

1. slug 合法且文件不存在  
2. 写 md +（若 M2 写队列已存在则入队；**M1 阶段可直接写文件 + git commit**，M2 再统一队列）  
3. 别名不得指向其他已存在活实体（冲突 → `E_CONFLICT`）  

### 7.2 resolve

1. 精确匹配 slug  
2. 否则扫描所有活实体的 `aliases`（M1 可目录扫；M3 后走索引）  
3. 若 `status=merged`，读 `redirect`，depth+1，depth>2 → `E_INTERNAL`  
4. 都没有 → `E_NOT_FOUND`  

### 7.3 merge（文件事务，禁止只改内存/DB）

前置：`confirm===true`，否则 `E_CONFLICT` 提示需 `--confirm`。

原子步骤（同一 git commit）：

1. 校验所有 slug 存在；canonical 存在且当前为 active（若 canonical 已是 merged → 先 resolve）  
2. 合并 losers 的 aliases、external_ids 到 canonical（去重，不含 canonical.slug 自身）  
3. 更新 canonical.md 的 `updated_at`  
4. 每个 loser 覆写为 redirect stub（`status: merged`）  
5. append `entity_merged` 事件行  
6. `git add` 相关文件 + commit：`memory: entity merge {losers} -> {canonical}`  

**禁止**：只更新将来的 PGLite 表而不改文件。

## 8. CLI 契约（本 Spec）

### 8.1 `memory init [dir]`

| 参数 | 默认 | 说明 |
|---|---|---|
| `[dir]` | `.` | 目标目录 |
| `--brain <id>` | `default` | brainId |
| `--force` | false | 目录非空时仍初始化（危险）；默认非空则失败 |

退出：成功 0；目录非空无 force → 2 `E_USAGE`。

### 8.2 `memory entity create`

```
memory entity create --slug <slug> --title <title> [--alias <a>]...
```

### 8.3 `memory entity resolve <name>`

stdout：一行 canonical slug（或 `--json` 输出 Entity）。

### 8.4 `memory entity list`

默认不含 merged；`--all` 含 stub。

### 8.5 `memory entity merge <slug...> --canonical <slug> --confirm`

缺少 `--confirm` → exit 2。

## 9. 验收用例

| ID | Given | When | Then |
|---|---|---|---|
| M1-01 | 空目录 | `init ./d` | 存在 memory.yml、brains/default、`.git`、首 commit |
| M1-02 | 已 init | 再 `init` 无 force | 失败 E_USAGE |
| M1-03 | 已 init | `entity create --slug alice --title Alice` | 文件 `entities/alice.md` status=active |
| M1-04 | alice 存在 | `entity resolve alice` | 输出 `alice` |
| M1-05 | alice + bob | `merge alice bob --canonical alice --confirm` | bob.md status=merged redirect=alice；ledger 有事件 |
| M1-06 | merge 后 | `resolve bob` | 输出 `alice` |
| M1-07 | merge 后 | **删除整个 `.dfmemory`**（若尚无索引则跳过）并 **仅从文件** resolve | 仍得 alice（为 M3 rebuild 铺路：文件权威） |
| M1-08 | path `brains/default/sources/default/../../etc/passwd` | normalize | `E_PATH_ESCAPE` |
| M1-09 | merge 无 `--confirm` | | `E_CONFLICT` |

## 10. DoD

- [ ] `bun test` 覆盖 M1-01…M1-09  
- [ ] `memory init && memory entity …` 人工口令通过  
- [ ] 代码中无「merge 只写数据库」分支  
- [ ] schema pack YAML 可被加载，类型列表含 requirement/decision/lesson/note  
