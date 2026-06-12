# 后端服务集成指南

> 本文档面向需要部署后端日志服务或将其集成到现有 Node.js 项目的开发者。

---

## 独立部署（推荐）

### 启动方式

```bash
cd packages/server
npm install
npm run dev        # 开发模式（tsx watch，端口 3100）
# 或
npm run build      # 编译到 dist/
npm start          # 生产模式
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3100` | 监听端口 |
| `LOG_DB_PATH` | `./data/logs.db` | SQLite 数据库路径 |
| `CORS_ORIGIN` | `*` | CORS 允许的来源 |

示例：
```bash
PORT=8080 LOG_DB_PATH=/var/data/logs.db npm run dev
```

### 验证

```bash
curl http://localhost:3100/api/health
# → {"status":"ok","timestamp":...}
```

## 作为中间件集成到现有 Express 项目

```typescript
import express from 'express';
import { logRouter, logMiddleware } from '@myby/log-server';

const app = express();

// 【必须】注册日志上报路由
app.use('/api/logs', logRouter);

// 【可选】注册链路查询路由
import { traceRouter, statsRouter } from '@myby/log-server';
app.use('/api/traces', traceRouter);
app.use('/api/stats', statsRouter);
```

> 当前版本暂未导出中间件形式，如需集成请参考 `packages/server/src/index.ts` 自行组装。

## API 端点汇总

| 方法 | 路径 | 说明 | 调用方 |
|------|------|------|--------|
| POST | `/api/logs` | 批量上报日志 | 前端 SDK |
| GET | `/api/logs` | 查询日志列表 | 日志看板 |
| GET | `/api/logs/:id` | 单条日志详情 | 日志看板 |
| GET | `/api/traces/:traceID` | 链路详情 | 日志看板 |
| GET | `/api/stats` | 统计数据 | 日志看板 |
| GET | `/api/health` | 健康检查 | 监控系统 |

## 数据库

### SQLite 数据库文件

默认路径：`packages/server/data/logs.db`

表结构：

```sql
-- 日志明细表
CREATE TABLE logs (
    id              TEXT PRIMARY KEY,           -- trace_id + '-' + span_id
    trace_id        TEXT NOT NULL,
    span_id         TEXT NOT NULL,
    parent_span_id  TEXT,
    level           TEXT NOT NULL,
    category        TEXT NOT NULL,
    event_key       TEXT,
    message         TEXT,
    data            TEXT,                       -- JSON 字符串
    source          TEXT NOT NULL,
    user_id         TEXT,
    url             TEXT,
    user_agent      TEXT,
    ip              TEXT,
    timestamp       INTEGER NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 链路汇总表
CREATE TABLE traces (
    trace_id        TEXT PRIMARY KEY,
    root_span_id    TEXT NOT NULL,
    service_name    TEXT NOT NULL DEFAULT 'web',
    start_time      INTEGER NOT NULL,
    end_time        INTEGER,
    span_count      INTEGER DEFAULT 0,
    has_error       INTEGER DEFAULT 0,
    summary         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### WAL 模式

数据库使用 WAL（Write-Ahead Logging）模式，支持**读写并发**：
- 写入时不会阻塞读取
- 适合日志场景的高频写入 + 低频查询

## 写入性能

| 场景 | 性能 |
|------|------|
| 单条写入 | ~1000 ops/s |
| 批量写入（100 条/批） | ~10000 ops/s |
| 内存缓冲区 | 每 100ms 刷入或满 100 条刷入 |

> 当前内存缓冲区合并写入 + SQLite WAL 模式，单机可支撑中小规模应用。
> 如果 QPS > 10000，建议迁移到 PostgreSQL。

## 生产部署建议

```yaml
# docker-compose.yml 示例
version: '3'
services:
  log-server:
    build: ./packages/server
    ports:
      - "3100:3100"
    environment:
      - PORT=3100
      - LOG_DB_PATH=/data/logs.db
      - CORS_ORIGIN=https://your-app.com
    volumes:
      - ./data:/data
    restart: always
```

```nginx
# Nginx 反向代理配置
server {
    listen 443 ssl;
    server_name log-api.your-domain.com;

    location /api/ {
        proxy_pass http://localhost:3100;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 数据保留

当前版本不包含自动清理功能。可通过定时任务清理过期数据：

```bash
# 清理 30 天前的日志
sqlite3 /data/logs.db "DELETE FROM logs WHERE timestamp < strftime('%s','now','-30 days')*1000;"
sqlite3 /data/logs.db "DELETE FROM traces WHERE start_time < strftime('%s','now','-30 days')*1000;"
sqlite3 /data/logs.db "VACUUM;"
```

## 监控告警

建议对以下指标设置告警：
- `POST /api/logs` 响应时间 > 500ms
- 数据库文件大小 > 1GB
- 错误率（accepted < logs.length 的比例）> 1%
