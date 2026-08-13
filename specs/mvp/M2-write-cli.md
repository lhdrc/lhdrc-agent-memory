# Spec M2 — 写入管线与 CLI（D17 L0）

| 字段 | 值 |
|---|---|
| ID | M2 |
| 状态 | ready |
| 依赖 | M1 |
| 对应架构 | 08 §5.4、§6.0–6.2、**D1/D14/D17/D18** |

## 1. 目标

1. 实现 `WRITE_FORMAT` 强制校验（见 [`WRITE_FORMAT.md`](WRITE_FORMAT.md)）  
2. 单写者串行队列 + 跨进程文件锁  
3. 写文件 → **content_hash 索引 hook** → 按 D18 **标记 dirty / 条件 flush**（默认 **不**每写 `git commit`）  
4. CLI：`capture` / `import` / `read` / `tree` / `forget` / `schema use` / **`sync --commit`**  
5. 将 M1 的 entity 写操作也迁入同一写队列  

## 2. 非目标

- LLM 提取  
- 索引同步实现细节（在写成功后调用 **hook 接口**，由 M3 实现；M2 定义 `onFilesWritten(paths)`；可保留别名 `onFilesCommitted`）  
- MCP/REST  
- 完整外部仓 `git pull/diff` 同步（二期 / 对齐 gbrain sync；本 Spec 只做 **本地 dirty flush**）  

## 3. 包落点

```
packages/core/src/write/
  validator.ts       # WriteValidator
  queue.ts           # WriteQueue（文件+索引+dirty/flush）
  lock.ts            # file lock
  flush.ts           # dirty 集合、N/T、force、显式 flush（可并入 queue）
  capture.ts         # build NormalizedWrite + enqueue
  forget.ts          # soft archive
  import.ts          # import file(s)
packages/core/src/node/
  read.ts
  tree.ts
packages/cli/src/commands/
  capture.ts
  import.ts
  read.ts
  tree.ts
  forget.ts
  schema.ts
  sync.ts            # memory sync --commit
```

## 4. 写锁

- 锁文件：`.dfmemory/write.lock`  
- 格式：`{ "pid": number, "acquiredAt": ISO, "owner": string }`  
- 获取：O_EXCL 创建或等价；超时 `lock_timeout_ms` → `E_LOCK`  
- 若锁内 pid 不存在（进程已死），允许 break（写警告到 stderr）  
- **所有** 文件变更（capture/import/forget/entity create|merge）必须持锁  

## 5. WriteQueue（D18）

```ts
type WriteJob =
  | { type: "create_node"; payload: NormalizedWrite }
  | { type: "archive_node"; path: string; by: string }
  | { type: "entity_create"; ... }
  | { type: "entity_merge"; ... };

class WriteQueue {
  /** 串行执行；进程内 mutex + 跨进程 lock */
  enqueue(job: WriteJob): Promise<WriteResult>;
  /** 显式 flush dirty → git commit；无 dirty 则 no-op */
  flush(reason: "explicit" | "batch" | "exit" | "force"): Promise<void>;
}
```

单 job 步骤（**默认 `git.mode=batch`**）：

1. acquire lock  
2. 再校验一次 path 不冲突（TOCTOU）  
3. 写文件到磁盘（权威已落盘）  
4. 调用 `IndexSyncHooks.onFilesWritten(changedPaths)`（M3 填充；失败 → warn，**不**回滚文件）  
5. 将路径加入 dirty 集合  
6. 若 job 属于 `force_commit_on`（如 `entity_merge`）或 `mode=per_write` → **立即** `git add` + `git commit`  
7. 否则若 `mode=batch` 且 `auto_commit`：检查 N / T，满足则 batch flush  
8. release lock  

崩溃 / 失败语义：

| 阶段 | 失败处理 |
|---|---|
| 写文件前/中 | 回滚本 job 未完成文件（能删则删）；抛错 |
| 文件已写、索引 hook 失败 | **保留文件**；warn `[E_INDEX]…rebuild-index` |
| 强制/batch flush 的 git 失败 | **保留文件与索引**；抛 `E_GIT` 或 warn（显式 `sync --commit` 应非 0 退出） |

**禁止**：在「仅索引/flush 失败」时用 `git checkout --` 抹掉已成功的权威文件。

### 5.1 Flush 与配置

见 [`00-conventions.md`](00-conventions.md) §8。  
CLI 退出时若有 dirty → best-effort `flush("exit")`。

## 6. capture

### 6.1 CLI

```
memory capture \
  --title <string> \
  --type <schema_type> \
  --body <string> | --body-file <path> | stdin \
  [--source <id>] \
  [--issue <id>] \
  [--tag <t>]... \
  [--alias <a>]... \
  [--fact <text>]... \
  [--created-by <id>]
```

默认：`--source` ← env/默认 `default`；`--created-by` ← `cli:$USER`；`--issue` ← `general`。

`--fact` 重复多次 → facts[]，`event_type` 默认 = schema_type，`attributed_to` = created-by，`at` = 当天 UTC 日期。

### 6.2 流程

```
parse CLI → CreateNodeRequest
  → WriteValidator.validate
  → 失败则打印 errors，exit 2
  → WriteQueue.enqueue(create_node)
  → stdout 打印最终仓内相对 path
```

### 6.3 账本消息（仅当本步实际产生 commit 时）

- batch 窗口 flush：`memory: flush N files`（或带类型摘要）  
- `per_write`：`memory: capture decision issues/general/decisions/1-retry.md`  

## 7. import

```
memory import <file.md|dir> [--source <id>] [--created-by <id>]
```

规则：

- 单文件：若已有合法 frontmatter，补齐缺省字段后校验；`schema_type` 缺失 → 失败  
- 目录：递归 `*.md`，每个文件独立 job（保持串行）  
- 不覆盖已存在 path（ADD-only）  

## 8. read / tree

```
memory read <path>           # path 相对 brain 或 sources；打印全文
memory tree [path] [--depth N]
```

- `read`：只读文件，不经索引；不存在 → `E_NOT_FOUND`  
- `tree`：列目录；默认从 `brains/{id}/`；`--depth` 默认 3  

## 9. forget（D17 L3 软删）

```
memory forget <path> [--by <id>]
```

行为：

1. 读 md，设 `status: archived`，加 `archived_at` / `archived_by`  
2. **不**删除文件  
3. 索引 hook（M3：查询默认排除 archived）  
4. dirty / 条件 flush；**不**要求单次 forget 必有独立 commit（除非 `per_write`）  

`--purge`：见 [P5.4](../五期/P5.4-ledger-purge.md)。必须 `--confirm`；物理删除 + `node_purged`；`git.mode≠off` 时独立 force commit；需 owner。硬删不可默认、不可自动化。无 `--confirm` → `E_USAGE`。

## 10. schema use

```
memory schema use <packId>
```

MVP：仅允许 `problem-tree`；其他 → `E_NOT_FOUND`。  
成功：更新 `memory.yml` 与 `brain.yml` 的 `schema_pack` 字段，并 **强制即时 commit**（D18 `schema_use`）。

## 11. sync --commit（显式 flush）

```
memory sync --commit [--json]
```

- 将当前 dirty 路径 `git add` + 一次 commit  
- 无 dirty → 成功 no-op（stdout 可提示 `nothing to commit`）  
- git 不可用 / 失败 → `E_GIT`，**不**改动工作区文件  

## 12. Source 解析链（MVP 简化为 4 层）

完整 7 层进二期；MVP：

```
--source flag → DF_MEMORY_SOURCE → brain.yml sources.default → "default"
```

## 13. 验收用例

| ID | Given | When | Then |
|---|---|---|---|
| M2-01 | init 后（batch） | capture decision 合法 | 文件存在，status=active；**不**要求立刻多一条 git commit |
| M2-02 | 缺 title | capture | E_VALIDATION field=title，无新文件 |
| M2-03 | 同 path 再 capture | | E_CONFLICT |
| M2-04 | body 含 `../` 试图写 path | | E_PATH_ESCAPE 或校验拒绝 |
| M2-05 | 并行两个 capture 进程 | | 均成功或一个 E_LOCK；最终文件树一致、无半写 |
| M2-06 | capture 后 | read path | 输出含 title 与 body |
| M2-07 | capture 后 | tree | 可见该文件 |
| M2-08 | forget path | | status=archived；文件仍在 |
| M2-09 | import 合法 md | | 新节点；非法 frontmatter 失败且不部分写入（单文件失败不影响已成功的——目录 import 已成功的保留） |
| M2-10 | entity create 与 capture 交错 | | 均经同一锁，无交叉写坏 |
| M2-11 | capture 一次后 | `sync --commit` | dirty 清空；`git log` 出现 flush/`memory:` commit |
| M2-12 | entity merge --confirm | | 文件事务成功；**有 git 时**立刻有独立 merge commit |
| M2-13 | 索引 hook 抛错 | capture | 文件仍在；stderr 含索引失败提示；进程不假装写入失败而删文件 |

## 14. DoD

- [ ] WRITE_FORMAT 单测全绿  
- [ ] 写锁单测（含 stale pid）  
- [ ] CLI 口令：capture → read → forget；`sync --commit` 可落账本  
- [ ] Index hook 接口已定义；默认 no-op；失败不回滚文件  
- [ ] `git.mode=batch` 下单测证明「单次 capture ≠ 必有 commit」  
- [ ] 无任何 LLM 依赖  
