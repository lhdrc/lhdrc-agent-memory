# Spec M2 — 写入管线与 CLI（D17 L0）

| 字段 | 值 |
|---|---|
| ID | M2 |
| 状态 | ready |
| 依赖 | M1 |
| 对应架构 | 08 §6.0–6.2、D14、D17 L0/L3 |

## 1. 目标

1. 实现 `WRITE_FORMAT` 强制校验（见 [`WRITE_FORMAT.md`](WRITE_FORMAT.md)）  
2. 单写者串行队列 + 跨进程文件锁  
3. 写文件 → git commit 原子化  
4. CLI：`capture` / `import` / `read` / `tree` / `forget` / `schema use`  
5. 将 M1 的 entity 写操作也迁入同一写队列  

## 2. 非目标

- LLM 提取  
- 索引同步（在写成功后调用 **hook 接口**，由 M3 实现；M2 定义 `onFilesCommitted(paths)` 空实现或 no-op）  
- MCP/REST  

## 3. 包落点

```
packages/core/src/write/
  validator.ts       # WriteValidator
  queue.ts           # WriteQueue
  lock.ts            # file lock
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
```

## 4. 写锁

- 锁文件：`.dfmemory/write.lock`  
- 格式：`{ "pid": number, "acquiredAt": ISO, "owner": string }`  
- 获取：O_EXCL 创建或等价；超时 `lock_timeout_ms` → `E_LOCK`  
- 若锁内 pid 不存在（进程已死），允许 break（写警告到 stderr）  
- **所有** 文件变更（capture/import/forget/entity create|merge）必须持锁  

## 5. WriteQueue

```ts
type WriteJob =
  | { type: "create_node"; payload: NormalizedWrite }
  | { type: "archive_node"; path: string; by: string }
  | { type: "entity_create"; ... }
  | { type: "entity_merge"; ... };

class WriteQueue {
  /** 串行执行；进程内 mutex + 跨进程 lock */
  enqueue(job: WriteJob): Promise<WriteResult>;
}
```

单 job 步骤：

1. acquire lock  
2. 再校验一次 path 不冲突（TOCTOU）  
3. 写文件到磁盘  
4. `git add` + `git commit -m "memory: <summary>"`  
5. 调用 `IndexSyncHooks.onFilesCommitted(changedPaths)`（M3 填充）  
6. release lock  

崩溃：若 commit 失败，尝试回滚未提交工作区变更（`git checkout --` 相关文件）并返回 `E_GIT`。

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

### 6.3 成功 commit message

`memory: capture decision issues/general/decisions/1-retry.md`

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
3. git commit：`memory: forget <path>`  
4. 钩子通知索引（M3：pages 标记 archived，查询默认排除）  

`--purge`：**MVP 解析参数但返回 `E_USAGE`「未实现」**（接口预留）。

## 10. schema use

```
memory schema use <packId>
```

MVP：仅允许 `problem-tree`；其他 → `E_NOT_FOUND`。  
成功：更新 `memory.yml` 与 `brain.yml` 的 `schema_pack` 字段并 commit。

## 11. Source 解析链（MVP 简化为 4 层）

完整 7 层进二期；MVP：

```
--source flag → DF_MEMORY_SOURCE → brain.yml sources.default → "default"
```

## 12. 验收用例

| ID | Given | When | Then |
|---|---|---|---|
| M2-01 | init 后 | capture decision 合法 | 文件存在，status=active，git log 有 commit |
| M2-02 | 缺 title | capture | E_VALIDATION field=title，无新文件 |
| M2-03 | 同 path 再 capture | | E_CONFLICT |
| M2-04 | body 含 `../` 试图写 path | | E_PATH_ESCAPE 或校验拒绝 |
| M2-05 | 并行两个 capture 进程 | | 均成功或一个 E_LOCK；最终文件树一致、无半写 |
| M2-06 | capture 后 | read path | 输出含 title 与 body |
| M2-07 | capture 后 | tree | 可见该文件 |
| M2-08 | forget path | | status=archived；文件仍在 |
| M2-09 | import 合法 md | | 新节点；非法 frontmatter 失败且不部分写入（单文件失败不影响已成功的——目录 import 已成功的保留） |
| M2-10 | entity create 与 capture 交错 | | 均经同一锁，无交叉写坏 |

## 13. DoD

- [ ] WRITE_FORMAT 单测全绿  
- [ ] 写锁单测（含 stale pid）  
- [ ] CLI 口令：capture → read → forget  
- [ ] Index hook 接口已定义；默认 no-op  
- [ ] 无任何 LLM 依赖  
