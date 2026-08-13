# Postgres 可选索引后端（P5.7）

单机默认 **PGLite**（零配置，见 `memory.yml` `index.engine: pglite`）。只有仓库变大、需要外部 Postgres 时才改 `postgres`。

CI 默认仍跑 PGLite；本页是可选路径，目标 10 分钟内跑通 P57-02。

## 1. 启动数据库

仓库根目录：

```bash
docker compose -f scripts/docker-compose.postgres.yml up -d
```

镜像含 pgvector。端口 **5433**（避免和本机 5432 冲突）。

## 2. 环境变量

PowerShell:

```powershell
$env:DF_MEMORY_DATABASE_URL = "postgres://dfmemory:dfmemory@127.0.0.1:5433/dfmemory"
```

bash:

```bash
export DF_MEMORY_DATABASE_URL=postgres://dfmemory:dfmemory@127.0.0.1:5433/dfmemory
```

多仓共用一个实例时，可设 `DF_MEMORY_PG_SCHEMA=mybrain`（仅字母数字下划线）做 schema 隔离。

## 3. 初始化仓并改引擎

```bash
bun run memory -- init ./pgdemo
```

编辑 `pgdemo/memory.yml`：

```yaml
index:
  engine: postgres
  path: .dfmemory/pglite
```

`path` 在 postgres 模式下忽略（索引在 DSN 指向的库里）。

## 4. 写 / 查 / 重建（P57-02 / P57-03）

在 `pgdemo` 目录：

```bash
bun run memory -- capture --title "重试策略" --type note --body "改为固定3次"
bun run memory -- query "重试"
# 期望命中刚才的 path，退出 0

# 清空索引后从 md 恢复
bun run memory -- rebuild-index
bun run memory -- query "重试"
```

无 URL：`engine=postgres` 时首个需索引命令失败，提示设置 `DF_MEMORY_DATABASE_URL`（不静默回退 PGLite）。

## 5. 可选测试

```bash
export DF_MEMORY_DATABASE_URL=postgres://dfmemory:dfmemory@127.0.0.1:5433/dfmemory
bun run test:postgres
```

无服务时 `p57_postgres.test.ts` 会 skip P57-02/03，P57-04/05（坏 DSN / 缺 URL）仍跑。
