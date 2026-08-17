# df-memory

> 团队记忆，不止于会话。

![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/badge/version-0.1.0-green) ![Language](https://img.shields.io/badge/TypeScript-strict-blue)

## 简介

Agent 的上下文关了就空。一个人定过的决策、踩过的坑，换个会话、换个人，等于没发生过。

**df-memory** 是开源、单机、本地部署的记忆仓：人用 CLI 读写，agent 用插件自动记和取。记忆落在 Markdown 上，不锁进某家云，也不绑死某一个模型。

## 功能特性

**Markdown 是真相，索引可以扔。**
每条记忆是一篇带 frontmatter 的 Markdown：能打开、能 grep、能看 diff。检索索引（默认 PGLite，可选 Postgres）随时可删，`rebuild-index` 从文件重建。git 是可选账本——默认攒一批再提交，也可以完全关掉。写记忆不需要先会用 git。

**LLM 是加速器，不是开关。**
不配 API Key 也能 `capture` 写入、`query` 检索。配上模型才启用会话编译、经验蒸馏、技能结晶。没 Key 时语义检索会降级，不会假装成功。

**原始记录只增，经验会沉淀。**
热路径 ADD-only：不覆盖旧文，也不把整场 transcript 当知识。重复出现的决策会被蒸馏成经验页；成熟经验结晶成 `SKILL.md`。删除默认软归档，源文件还在。

**检索能解释自己。**
关键词（含中文 ngram）+ 向量 + 图谱三路融合，按层加载、带来源。`query --explain` 给出命中理由。技能不混进默认知识检索——需要规则时再查找、再注入。

**接上 agent 就会自己记。**
作为 DeepSeek Harness 插件接入后：会话挂钩把用户/助手正文写入 inbox，达窗后异步编译入库；该查的时候注入上下文，不该查的时候闭嘴。写入默认入队，不堵主会话。立刻要可查，加 `--wait`。

**一个仓，多个脑，数据在自己磁盘上。**
`brains/{id}/` 路径强制隔离，人与 agent 都按作用域读写。单机跑完，没有必须上云的部分。

## 快速开始

环境要求：Node.js ≥ 20 或 Bun ≥ 1.0，git。

```bash
bun install

bun run memory -- init ./demo
cd demo

bun run memory -- capture --wait --title "重试策略" --type decision --body "改为固定3次"
bun run memory -- query "重试"
```

## 使用说明

### 日常读写

```bash
# 写：capture 零 LLM 直写；remember 走 LLM 编译。默认入队，--wait 等到落盘
bun run memory -- capture --wait --title "会议结论" --type decision --body "..."
bun run memory -- remember --wait --body "我们在会上决定……"

# 查：query 给命中，think 给合成答案，graph-query 走关系
bun run memory -- query "重试" --explain
bun run memory -- think "当前最大的风险是什么"
bun run memory -- graph-query "谁提到了支付"

# 维护
bun run memory -- rebuild-index
bun run memory -- sync --commit
bun run memory -- job status <task_id> --json
```

### 配置

仓库根目录的 `memory.yml` 是唯一配置文件（不配也能跑）：

```yaml
brain_id: default          # 默认记忆空间
git:
  mode: batch              # batch | off | per_write
llm:
  provider: off            # off | openai
embedding:
  provider: openai         # 无 key 时自动降级为本地哈希向量
```

## 测试

```bash
bun run test            # 全量回归（含真实 git + PGLite 集成）
bun run typecheck       # 类型检查
bun run eval:mini       # 检索质量评测
bun run test:isolation  # 多空间隔离与防泄漏测试
```

## 贡献

欢迎 Issue、想法和 PR。

流程：开 Issue 讨论 → Fork → 按 `AGENTS.md` 的工程约束开发 → 提交 PR（附对应测试）。

## 许可证

MIT（详见 `LICENSE`）。
