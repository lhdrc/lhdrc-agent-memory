# WRITE_FORMAT.md — 写入格式规格（D14）

> 所有 L0 写入入口（`capture` / `import` / 四期 MCP·REST）必须通过本规格校验。  
> 实现：`WriteValidator.validate(req) → ValidationResult`。  
> 版本：与包版本同步；破坏性变更升 major。

## 1. 校验入口对象

```ts
type CreateNodeRequest = {
  brainId: string;
  sourceId: string;
  schemaType: string;
  title: string;
  /** 相对 source 根的路径，不含 brains/.../sources/... 前缀；可空则由 pack 模板生成 */
  relativePath?: string;
  body: string;                 // markdown 正文（可无 frontmatter；系统会合成）
  tags?: string[];
  aliases?: string[];
  links?: Array<{ to: string; type: string; source: "wikilink"|"markdown"|"mention"|"verb"|"path" }>;
  facts?: Array<{
    text: string;
    event_type: string;
    attributed_to: string;
    at: string;                 // YYYY-MM-DD 或 ISO-8601
    metric?: string;            // P9.5：量纲 slug，1–64
    value?: number;             // 有 value 必须有 metric
    unit?: string;
    period?: string;            // 如 2026-Q1 / 2026-08-16
  }>;
  createdBy: string;            // 如 "cli:user" / "agent:claude"
  status?: "active" | "archived" | "stale";  // 默认 active；forget 另走 API
};
```

## 2. 必填与类型规则

| 字段 | 规则 | 失败码细节 |
|---|---|---|
| `title` | 非空，trim 后 1–200 字符 | `field=title` |
| `schema_type` | 必须 ∈ 当前 schema pack 的 `schema_types` | `field=schema_type` |
| `source` / `sourceId` | 合法 slug；路径落在该 source 下 | `field=source` |
| `path` | 最终仓内相对路径唯一；无 `..`；UTF-8 | `field=path` |
| `created_by` | 非空，≤128 | `field=created_by` |
| `created_at` | 系统生成 ISO-8601 UTC（调用方不可伪造覆盖，可忽略传入） | — |
| `status` | ∈ `active\|archived\|stale`，L0 capture 仅允许 `active` | `field=status` |
| `body` | UTF-8；长度 ≤ `max_body_chars`（默认 200_000） | `field=body` |
| `facts[].text` | 非空，≤2000；P9.7 落盘后可追加 ` [Source: {path}]`（已有 `[Source:` 则跳过） | `field=facts` |
| `facts[].metric` | 可选；trim 后 1–64 | `field=facts` |
| `facts[].value` | 可选；须为有限数；有 value 必须有 metric | `field=facts` |
| `facts[].unit` / `facts[].period` | 可选字符串 | — |
| `links[].to` | 非空相对/逻辑 path | `field=links` |
| `links[].type` | ∈ pack 或核心允许集合（见下） | `field=links.type` |

核心默认允许的 `links.type`：

`belongs_to` | `references` | `mentions` | `decided` | `produced_by` | `works_on`

## 3. 落盘文件形状

校验通过后，写入单个 `.md`：

```markdown
---
title: <title>
schema_type: <schemaType>
source: <sourceId>
path: <path-relative-to-brain-sources-or-pack-defined>
version: 1
status: active
created_by: <createdBy>
created_at: <ISO8601>
tags: [...]
aliases: [...]
links:
  - { to: ..., type: ..., source: ... }
facts:
  - text: ...
    event_type: ...
    attributed_to: ...
    at: ...
    metric: ...       # 可选
    value: ...        # 可选
    unit: ...         # 可选
    period: ...       # 可选
---
## 摘要
<首段或调用方提供的摘要；可空则留空标题>

## 正文
<body>
```

- 若 `body` 已含 `## 摘要`，不再重复包裹。
- `path` frontmatter 存**相对 `brains/{brainId}/` 的路径**（含 `sources/...`），便于检索展示。

## 4. 路径生成（relativePath 为空时）

由 schema pack 的 `filename_templates[schema_type]` 渲染：

变量：`{n}` 序号（同目录已有同类型文件数+1）、`{slug}`（title 转 slug）、`{date}`（YYYY-MM-DD）。

例（problem-tree / decision）：

`sources/{source}/issues/{issue}/decisions/{n}-{slug}.md`

MVP：`capture` 若未传 `--issue`，默认 issue id = `general`。

## 5. ADD-only（D17 L0）

| 情况 | 行为 |
|---|---|
| 目标 path 不存在 | 创建 |
| 目标 path 存在且 status=active | **拒绝** `E_CONFLICT`（不覆盖） |
| 目标 path 存在且 status=archived | **拒绝** `E_CONFLICT`（MVP 不复用 path；二期可定义 revive） |
| 仅追加 facts 到已有节点 | **MVP 不做**（推二期或显式 `append-facts`）；capture 只建新节点 |

## 6. 拒绝规则（硬）

1. 非 UTF-8 → `E_VALIDATION`
2. 正文或任一字段匹配 `mask_patterns`（`memory.yml` 可配，默认空）→ `E_VALIDATION`
3. 最终文件路径越出 `brains/{brainId}/sources/{sourceId}/` → `E_PATH_ESCAPE`
4. `schema_type` 不在 pack → `E_VALIDATION`
5. frontmatter YAML 无法序列化 → `E_VALIDATION`

## 7. ValidationResult

```ts
type ValidationResult =
  | { ok: true; normalized: NormalizedWrite }  // 含最终 path、frontmatter、body
  | {
      ok: false;
      code: "E_VALIDATION" | "E_PATH_ESCAPE" | "E_CONFLICT";
      errors: Array<{ field: string; message: string }>;
    };
```

CLI：校验失败时 stderr 打印 errors，exit 2。

## 8. 验收

- 缺 title → 失败且 `field=title`
- `schema_type=foobar`（不在 pack）→ 失败
- path 含 `../` → `E_PATH_ESCAPE`
- 同 path 二次 capture → `E_CONFLICT`
- 合法 capture → 文件存在且 frontmatter 可被 gray-matter 解析

## 9. Experience 写入（P2.2 / D14）

L1 经验层走 `validateExperienceWrite` → `writeExperience`（WriteQueue），**不**使用 L0 `CreateNodeRequest` 路径模板。

| 字段 | 规则 |
|---|---|
| `title` / `trigger` / `procedure` / `boundary` | 必填 |
| `source_paths` | 非空数组（只读引用，不改 sources） |
| `schema_type` | 固定 `experience`；pack 须声明 |
| `status` | `active` \| `superseded` \| `archived` |
| `eta_score` / `support` / `counter_examples` | 默认 `0.5` / `0` / `[]` |
| `path` | `brains/{brainId}/experiences/{id}.md` |

失败码同 §7；禁止旁路写盘。

## 10. Skill 写入（P3.2 / D14）

L2 技能层走 `validateSkillWrite` → `writeSkill`（WriteQueue），目录 `brains/{brainId}/skills/{name}/SKILL.md`。

| 字段 | 规则 |
|---|---|
| `name` | `[a-z0-9-]{1,64}`；目录名与 frontmatter 一致 |
| `title` / `trigger` / `procedure` / `boundary` / `verification` | 必填 |
| `schema_type` | 固定 `skill`；pack 须声明 |
| `status` | `candidate` \| `active` \| `archived` |
| `eta_score` | 与经验一致（08 示例字段 `eta` 作别名写入时归一为 `eta_score`） |
| `support` / `counter_examples` | 默认 `0` / `[]` |
| `source_experience_ids` | 结晶来源经验 id 列表 |
| `path` | `brains/{brainId}/skills/{name}/SKILL.md` |

正文建议含 `## Procedure` / `## Boundary` / `## Verification` 三段。失败码同 §7。

成熟判定常量（可配置覆盖，默认冻结）：`eta_score >= 0.7 && support >= 2 && counter_examples.length == 0`。

outcome：成功 `eta_score += 0.1`、`support += 1`；失败 `eta_score -= 0.2` 并 append `counter_examples`。

## 11. 分层字段与 sidecar（P5.2）

`abstract`（L0）与 `overview`（L1）为**派生字段**，不走 L0 `CreateNodeRequest` 必填校验；`capture` / `import` 可不带。由 `layers refresh` 或 `layers.auto` 写入 frontmatter，**禁止改正文**。

| 形态 | 规则 |
|---|---|
| frontmatter `abstract` / `overview` | 字符串；refresh 可覆盖（非 ADD-only 正文） |
| sidecar `{stem}.overview.md` | 当 overview 超过 `layers.overview_max_chars` 时落在同目录；`read --layer l1` 优先读 sidecar |
| 目录摘要 `{dir}/_overview.md` | `layers refresh --dirs` 写出；可覆盖重算；**不是** L0 capture 目标 |

上述 sidecar / `_overview.md` **豁免** WRITE_FORMAT 节点校验与 ADD-only 冲突（派生文件，允许刷新覆盖）。

## 12. Entity facts 与硬删（P5.4）

`memory entity link-facts <slug> --fact <text>` 向 **entity 文件** frontmatter `facts` **append**（不改正文），并写 `fact_linked` 账本事件。不是 L0 `capture` 路径，不走 ADD-only 冲突。

`forget <path>` 软归档（文件保留，`node_archived`）。`forget <path> --purge --confirm` **物理删除**文件（`node_purged`）；禁止无确认、禁止自动化/dream 触发。
