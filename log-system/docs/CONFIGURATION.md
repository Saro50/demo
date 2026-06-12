# 配置参考

> 本文档列出所有可配置项及其默认值。

---

## 前端 SDK 配置

传递给 `Logger.init(config)` 的配置对象：

```typescript
interface LoggerConfig {
  // ===== 必需 =====
  endpoint: string;           // 上报地址
  appName: string;            // 应用名
  environment: string;        // 运行环境

  // ===== 被动捕获开关（可选） =====
  autoCapture?: {
    error?: boolean;          // 默认: true
    promise?: boolean;        // 默认: true
    request?: boolean;        // 默认: true
    route?: boolean;          // 默认: true
    performance?: boolean;    // 默认: false
    click?: boolean;          // 默认: false
  };

  // ===== 采样与队列（可选） =====
  sampleRate?: number;        // 默认: 1 (全部采集)
  maxQueueSize?: number;      // 默认: 5000
  retryInterval?: number;     // 默认: 1000 (ms)
  maxRetries?: number;        // 默认: 5

  // ===== 安全（可选） =====
  sanitize?: boolean;         // 默认: true
}
```

### 默认值

```typescript
const DEFAULT_LOGGER_CONFIG = {
  endpoint: '/api/logs',
  appName: 'unknown',
  environment: 'development',
  autoCapture: {
    error: true,
    promise: true,
    request: true,
    route: true,
    performance: false,
    click: false,
  },
  sampleRate: 1,
  maxQueueSize: 5000,
  retryInterval: 1000,
  maxRetries: 5,
  sanitize: true,
};
```

## 后端服务配置

通过环境变量配置：

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | `3100` | HTTP 监听端口 |
| `LOG_DB_PATH` | `./data/logs.db` | SQLite 数据库文件路径 |
| `CORS_ORIGIN` | `*` | CORS 允许的源地址 |

### Express 中间件配置

硬编码配置项（如需修改，直接编辑 `packages/server/src/routes/logs.ts`）：

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `BATCH_INTERVAL` | 100ms | 内存缓冲区刷新间隔 |
| `BATCH_MAX_SIZE` | 100条 | 缓冲区最大条数，满则立即刷入 |
| `JSON_BODY_LIMIT` | 1mb | 请求体大小上限 |

## 日志看板配置

硬编码配置项（`packages/ui/src/App.tsx`）：

| 配置 | 默认值 | 说明 |
|------|--------|------|
| 时间预设 | `15m, 1h, 6h, 24h, 7d` | 快速时间范围选择 |
| 默认筛选 | `error, warn` | 打开页面时默认选中级别 |
| 每页条数 | 50 | 日志列表分页大小 |
| 刷新方式 | 手动点击 | 不自动轮询 |
