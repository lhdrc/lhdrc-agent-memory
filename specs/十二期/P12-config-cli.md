# 方案：配置查看 / 修改 CLI（P12 配置面）

| 字段 | 值 |
|---|---|
| ID | P12-config（方案；编码见 [`P12.3-config-cli.md`](P12.3-config-cli.md)） |
| 状态 | superseded by P12.3 |
| 依赖 | `memory.yml` / P6.1 / P9.2 / [`failure-degrade-audit.md`](failure-degrade-audit.md) F-06–F-08、F-12 |
| 对应 | 用户：「配置水平太差；要能看/改配置；哪里启用 LLM；需要 key 的地方要提示」 |

> 先落方案。实现另开 Spec（建议 P12.2），DoD 不进 P12.1。

## 1. 问题

现在只能手改 `memory.yml`。init 默认：

- `embedding.provider: openai`（要 `OPENAI_API_KEY` 才有真向量）  
- `llm.provider: off`（remember/compile 默认 `E_DISABLED`）

两套 provider、两套 `openai_api_key_env`、LLM 还有 `extract` / `distill` / `kill_switch.*`。没有 `memory config`，没有 doctor，init 成功也不提示缺 key。

## 2. 目标（实现期）

1. **看**：把生效配置打成一张表（含默认值来源、是否缺 key、该键会驱动哪些命令）。  
2. **改**：安全子集可用 `memory config set embedding.provider=local` 写回 yml（不碰 `brains/**`）。  
3. **LLM 地图**：用户能看懂「哪条命令会打 complete / embed」。  
4. **Key 提示**：缺 env 时 **预检** 就说，而不是 query 静默哈希、remember 异步才 failed。

## 3. 非目标（实现期仍不做）

- 改 git remote / npm registry（#34 upgrade）  
- 交互式 TUI wizard（可后续）  
- 把密钥写入 yml（只存 **env 名**，值只来自环境）  
- 改变 P9.2 / P9.8 的缺 key 语义（只提高可观测与入口）除非同期修 F-04

## 4. 现网：谁在用 LLM / embedding

### 4.1 开关（yml）

| 键 | init 默认 | 实际作用 |
|---|---|---|
| `llm.provider` | `off` | `off` → `NoopLLM`，`complete` 抛 `E_DISABLED`。`openai` 才出网 |
| `llm.model` / `llm.base_url` / `llm.openai_api_key_env` | gpt-4o-mini / api.openai.com / `OPENAI_API_KEY` | chat/completions |
| `llm.extract` | **false** | capture 后 enrich 是否 LLM 抽 facts（还要过 kill_switch） |
| `llm.distill` | true | `isDistillEnabled`：还要求 provider≠off 且 `kill_switch.distill=false` |
| `llm.kill_switch.compile` | false | 挡住 remember/compile `complete(purpose=compile)` |
| `llm.kill_switch.extract` | false | 挡住 enrich 抽 facts |
| `llm.kill_switch.distill` | false | 挡住蒸馏/refine judge |
| `llm.kill_switch.abstract` | false | 挡住 layers abstract |
| `embedding.provider` | **openai** | `off` 关语义臂；`local` 哈希；`onnx` 本地模型；缺 key 读路径哈希（P9.2） |
| `embedding.model` / `dims` / `onnx_model_path` | 3-small / 1536 / "" | 换档要 `rebuild-index --embeddings` |
| `embedding.openai_api_key_env` | `OPENAI_API_KEY` | **可与 llm 的 env 同名，也可不同** |
| `embedding.base_url` | api.openai.com（P12.1） | embeddings 兼容网关 |
| `compile.dedupe_cosine` | 0.95 | **会话 compile** 路径余弦去重（默认开） |
| `write.dedupe_cosine` | 0 | **capture/import enrich** 路径；与上一键同概念、默认不同、代码两套 |
| `distill.lazy_min_sources` | 5 | `≤0` 关懒蒸馏；compile 后是否自动 refine |
| `distill.auto_crystallize` | true | refine 后自动结晶 candidate |
| `layers.auto` | false | capture 后是否 `maybeAutoAbstract`（只 abstract，overview 仍要 `layers refresh`） |
| `cost.daily_token_cap` | 0 | >0 时 complete 可 skipped |
| `search.tokenmax.rerank` | off | 配 `model` **没有** CLI 接线，实际掉 local 启发式（死旋钮） |

CLI 额外门闩（**不在 yml**）：

- `memory capture --extract` / `DF_MEMORY_EXTRACT=1`  
- `memory remember --no-extract`（逃 E_DISABLED）  
- `DF_MEMORY_MOCK_COMPLETE*`（测例；**仅** `llm.provider=openai` 时生效，`off` 不走 mock）  
- `query --scope-first`；`think` **忽略** yml `search.scope_first`，硬编码开（P11.1）

未知 `llm.provider` **静默变 off**（审计 F-08）；未知 embedding provider 抛 `E_USAGE`。

`embedding.provider` 键缺失时 parse 默认 `off`，与 **init 模板写 openai** 不是同一条路。

### 4.2 命令 → purpose → 闸门 → key

| 命令 / 路径 | 调用 | yml 闸门 | 缺 key 时 |
|---|---|---|---|
| `remember` / `ingest session` / inbox compile | `complete(compile)` | provider≠off，`kill_switch.compile=false` | job **failed** `E_DISABLED`，不写 L0 |
| `remember --no-extract` | 无 complete | — | 写一条 note |
| `capture --extract` 或 `llm.extract: true` | enrich `complete(extract)` 或 provider.extractFacts | extract 门 + kill_switch.extract | 跳过抽取或 skipped_reason |
| `capture` 默认 | 常无 LLM；**仍可能 embed**（provider≠off） | embedding | 哈希向量（见审计 F-04） |
| `capture` 且 `write.dedupe_cosine>0` | embed 去重 | 与 compile 去重不是同一键 | mismatch 时余弦无意义（审计 F-26） |
| `import` | 每文件 enrich | `llm.extract` ∨ `write.dedupe_cosine>0` | 同 capture |
| `refine` / 懒蒸馏 / `eval --distill` / `skill crystallize` | `complete(distill)` + judge | `isDistillEnabled`；懒蒸还看 `lazy_min_sources` | skip / `E_DISABLED` |
| `layers refresh` / `layers.auto` | `complete(abstract)` | provider=openai 且非 kill_switch.abstract | **静默启发式**（审计 F-29）；remember 则硬失败 |
| `dream` 蒸馏段 | 同上 distill | 同左 | 跳过并记 reason |
| `dream` phase 4 跨文件 | embed cosine | openai/onnx 且非 fallback | 跳过（P10.3） |
| `query` / `think` 语义臂 | `embed()` | embedding.provider≠off | 哈希 fail-open；**无 --explain 时用户看不见**（F-25） |
| `think` | hybrid + **强制** scope_first | 忽略 yml 默认关 | 同 query |
| `rebuild-index --embeddings` | `embed()` strict | provider≠off | **`E_DISABLED`** |
| `rebuild-index --pending-embeddings` | 同 strict | 同 | 同 |
| 余弦去重 | `embed()` | `compile.dedupe_cosine` 或 `write.dedupe_cosine` | skipped_reason |

**没有** `llm.compile: true` 正开关；compile 只能 kill_switch 关。

## 5. CLI 草图

```
memory config                  # 同 list
memory config list [--json] [--secrets]
memory config get <dotted.key>
memory config set <dotted.key>=<value>
memory config doctor [--json]
```

### 5.1 `list` / `get`

按组输出（embedding / llm / compile / search / index / git / cost）。每行：

| 列 | 含义 |
|---|---|
| key | `llm.provider` |
| value | 生效值（从 yml+默认合并，与 `loadRepoConfig` 一致） |
| source | `file` / `default` |
| effect | 一句话，如「remember/compile 是否出网」 |
| needs | `env:OPENAI_API_KEY` 或 `—` |
| ready | `ok` / `missing_key` / `off` |

`--secrets` 默认 **关**：不打印任何 key **值**（本来也不该在 yml 里）。只打印 env **名** 与 ready。

JSON：与 list 同结构，方便插件。

### 5.2 `set`

允许写回的白名单（初版）：

- `embedding.provider` `embedding.model` `embedding.dims` `embedding.base_url` `embedding.openai_api_key_env` `embedding.onnx_model_path`  
- `llm.provider` `llm.model` `llm.base_url` `llm.openai_api_key_env`  
- `llm.extract` `llm.distill`  
- `llm.kill_switch.compile|extract|distill|abstract`  
- `distill.lazy_min_sources` `distill.auto_crystallize` `layers.auto`  
- `write.dedupe_cosine` `compile.job_timeout_ms` `cost.daily_token_cap`  
- `index.engine`（postgres 时 doctor 检查 `DF_MEMORY_DATABASE_URL`）  

**warn-on-set（允许但打印迁移提示）**：`search.*` 融合旋钮、`git.*`、`auth.*`。`search.tokenmax.rerank=model` 必须注明「现网无 LLM rerank」。

禁止：任意自由 YAML 注入、改 `version`、改路径逃出仓、把 token 写进 yml。

`set embedding.provider=openai` 若 env 空：写回成功 + **stderr 提示** `missing OPENAI_API_KEY；query 将哈希降级；remember 仍要 llm.provider`。

`set llm.provider=openai` 同理。换 embedding provider/dims：提示 `rebuild-index --embeddings`（及 P12.1 `--pending-embeddings`）。

未知 key → `E_USAGE` 并列出白名单。`llm.provider=opena` → `E_USAGE`（顺带修 F-08，禁止静默 off）。

### 5.3 `doctor`（Key 与门闩提示的主入口）

不改文件。检查：

1. `embedding.provider=openai|onnx` → 对应 env / 权重文件  
2. `llm.provider=openai` → env  
3. 两套 `openai_api_key_env` 是否同名、是否都有值  
4. `llm.provider=off` 且用户可能要用 remember：提示 `--no-extract` 或 `config set llm.provider=openai`  
5. `index.engine=postgres` → DSN  
6. 打印 **LLM 地图**（§4.2 的缩略表），标注当前闸门下每条命令是 on / off / missing_key  
7. `embedding.provider=openai` 且无 key：标明 query **会哈希降级**（F-25），remember 仍要另开 `llm.provider`  
8. `tokenmax.rerank=model`：标明未接线  
9. embedding-meta 与 runtime provider 不一致 → 提示 `rebuild-index --embeddings`  
10. 可选 `memory config apply-profile offline|hybrid|full`（offline=`embedding.local`+`llm.off`；full=双 openai）

另：`memory config path` 打印 `memory.yml` 绝对路径。

退出码：全 ready `0`；有 missing_key 或矛盾门闩 `2`（可 `--json` 给 CI）。

### 5.4 `init` 挂钩（小改，可与 doctor 同 PR）

`memory init` 成功后：若 embedding 默认 openai 且无 key，打印 3 行提示（不失败、不改默认 ADR）：

```
embedding.provider=openai 但未检测到 OPENAI_API_KEY
  query 语义臂将 fail-open 为本地哈希
  会话写入请: memory config set llm.provider=openai  （并 export 同一 key）
  查看: memory config doctor
```

## 6. 模块落点（实现期）

| 模块 | 路径 |
|---|---|
| 生效视图 | `packages/core/src/repo/config-view.ts`（纯函数，测例不碰盘） |
| 白名单 set | `packages/core/src/repo/config-set.ts`（读 yml AST/yaml 文档，改键写回，保注释若可行；不行则 round-trip 可接受并在 Spec 写明） |
| CLI | `packages/cli/src/commands/config.ts` |
| help | `run.ts` 增加 `memory config …` |

不把 doctor 做成 network probe（禁止 CI 出网）。只查 env 与文件存在。

## 7. 验收口令（实现期草案）

| ID | Given / When / Then |
|---|---|
| P12C-01 | init 仓 `config list --json` 含 `llm.provider=off`、`embedding.provider=openai` |
| P12C-02 | 无 Key：`doctor` 标 embedding `missing_key`，退出 2；不打网络 |
| P12C-03 | `config set llm.provider=openai` 写回 yml；再 get 为 openai |
| P12C-04 | `config set llm.provider=bogus` → `E_USAGE` |
| P12C-05 | `config set openai_api_key=sk-…`（直接密钥）→ `E_USAGE` 拒绝 |
| P12C-06 | list 的 effect 列对 remember 写明须 llm.provider≠off |
| P12C-07 | help 含 `config doctor` |

## 8. 与审计的衔接

| 审计 | 配置 CLI 是否修 |
|---|---|
| F-06 四门闩 | list/doctor **展示优先级**；不强制删键，除非实现期另开「门闩收敛」 |
| F-07 compile 无正开关 | 方案 **不**新增 `llm.compile`（避免第五门）；doctor 写清「compile 只有 kill_switch」 |
| F-08 静默 off | `set`/`load` 实现期改为 `E_USAGE`（行为变化，须写进 P12.2 Spec） |
| F-12 异步才失败 | doctor + init 提示；可选 remember enqueue 前预检（可同 PR） |
| F-04 三角不一致 | **超出**本 CLI；P12.2 可只提示，行为对齐另票 |
| F-20 job vs inbox | **不**靠 config CLI 修 |
| F-25 无 explain 看不见 fallback | doctor 标 would-fallback；可选 query stderr（另票） |
| F-26 去重混维 | doctor 在 mismatch 时警告 |

## 9. 实现顺序建议

1. 只读 `list`/`get`/`doctor`（零写盘，风险低）  
2. init 提示  
3. `set` 白名单  
4. （可选）remember 预检 warning  

编码见 [`P12.3-config-cli.md`](P12.3-config-cli.md)。
