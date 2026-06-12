# 完整 API 参考

> 本文档详细描述所有 API 的请求/响应格式、参数说明和示例。

---

## 前端 SDK API（面向业务）

### `Logger.init(config)`

**必须**在应用入口调用一次。

```typescript
interface LoggerConfig {
  endpoint: string;           // 上报地址，默认 '/api/logs'
  appName: string;            // 应用名
  environment: string;        // 'production' | 'staging' | 'development'
  autoCapture?: {
    error?: boolean;          // 自动捕获异常，默认 true
    promise?: boolean;        // 自动捕获 Promise 异常，默认 true
    request?: boolean;        // 自动捕获网络请求，默认 true
    route?: boolean;          // 自动捕获路由变化，默认 true
    performance?: boolean;    // 自动采集性能指标，默认 false
    click?: boolean;          // 自动采集点击事件，默认 false
  };
  sampleRate?: number;        // 采样率 0-1，默认 1
  maxQueueSize?: number;      // 队列上限，默认 5000
  retryInterval?: number;     // 重试间隔 ms，默认 1000
  maxRetries?: number;        // 最大重试次数，默认 5
  sanitize?: boolean;         // 脱敏开关，默认 true
}
```

### `Logger.track(eventKey, data?)`

上报业务埋点事件（level=info, category=event）。

```typescript
Logger.track('button_click');
Logger.track('pay_success', { amount: 99.9, channel: 'wechat' });
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| eventKey | `string` | 是 | 事件名，如 `'pay_success'` |
| data | `Record<string, unknown>` | 否 | 附加数据 |

### `Logger.error(message, data?)`

上报自定义错误（level=error, category=exception）。

```typescript
Logger.error('请求失败', { status: 500, url: '/api/order' });
Logger.error('网络超时');
```

### `Logger.info(message, data?)`

上报自定义信息（level=info, category=event）。

```typescript
Logger.info('用户注册完成', { userId: '123', duration: 3500 });
```

### `Logger.setUserId(userId)`

设置当前用户标识，后续所有日志自动携带。

```typescript
Logger.setUserId('user_abc_123');
```

---

## 后端 HTTP API

### POST `/api/logs` — 批量上报

**请求体**：
```json
{
  "logs": [
    {
      "trace_id": "uuid-string",
      "span_id": "uuid-string",
      "parent_span_id": "uuid-string | null",
      "level": "info",
      "category": "event",
      "event_key": "button_click",
      "message": "用户点击了提交按钮",
      "data": {"button_name": "submit_order"},
      "source": "frontend",
      "user_id": "user_123",
      "url": "https://example.com/order",
      "user_agent": "Mozilla/5.0 ...",
      "ip": "192.168.1.1",
      "timestamp": 1781161400000
    }
  ]
}
```

**响应 200**：
```json
{
  "accepted": 5,
  "errors": [
    {"index": 3, "reason": "Missing required fields (trace_id)"}
  ]
}
```

**字段校验规则**：

| 字段 | 必填 | 校验 |
|------|------|------|
| trace_id | 是 | 非空字符串 |
| span_id | 是 | 非空字符串 |
| level | 是 | 必须是 `debug\|info\|warn\|error\|fatal` 之一 |
| category | 是 | 必须是 `event\|exception\|request\|page\|performance` 之一 |
| timestamp | 否 | 缺省使用服务器当前时间 |
| source | 否 | 缺省 `'frontend'` |
| ip | 否 | 缺省使用请求来源 IP |

### GET `/api/logs` — 查询日志

**Query 参数**：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| level | string | - | 筛选级别，多个用逗号分隔 `error,fatal` |
| category | string | - | 筛选分类，多个用逗号分隔 |
| event_key | string | - | 筛选埋点事件名 |
| trace_id | string | - | 按链路 ID 查询 |
| keyword | string | - | 全文搜索 message 和 data |
| start_time | number | 1小时前 | 起始时间戳(ms) |
| end_time | number | 当前 | 结束时间戳(ms) |
| page | number | 1 | 页码 |
| page_size | number | 50 | 每页条数（最大 200） |
| sort | string | 'desc' | 'asc' 或 'desc' |

**响应 200**：
```json
{
  "total": 1000,
  "page": 1,
  "page_size": 50,
  "items": [
    {
      "id": "trace-001-span-001",
      "trace_id": "trace-001",
      "span_id": "span-001",
      "parent_span_id": null,
      "level": "error",
      "category": "exception",
      "event_key": null,
      "message": "TypeError: undefined",
      "data": {"stack": "at..."},
      "source": "frontend",
      "user_id": null,
      "url": "https://example.com",
      "user_agent": "Mozilla/5.0",
      "ip": "::1",
      "timestamp": 1781161400500,
      "created_at": "2026-06-11 07:04:04"
    }
  ]
}
```

### GET `/api/logs/:id` — 单条详情

**响应 200**：同 items 中的单条记录格式。

**响应 404**：
```json
{"error": "Log not found"}
```

### GET `/api/traces/:traceID` — 链路详情

**响应 200**：
```json
{
  "trace_id": "trace-001",
  "root_span_id": "span-001",
  "service_name": "web",
  "start_time": 1781161400000,
  "end_time": 1781161400600,
  "span_count": 3,
  "has_error": true,
  "summary": "3 spans, 1 errors",
  "spans": [
    {
      "id": "trace-001-span-001",
      "trace_id": "trace-001",
      "span_id": "span-001",
      "parent_span_id": null,
      "level": "info",
      "category": "page",
      "message": "Page: /home",
      "timestamp": 1781161400000
    },
    {
      "id": "trace-001-span-002",
      "trace_id": "trace-001",
      "span_id": "span-002",
      "parent_span_id": "span-001",
      "level": "info",
      "category": "event",
      "event_key": "button_click",
      "message": "Button click",
      "timestamp": 1781161400500
    },
    {
      "id": "trace-001-span-003",
      "trace_id": "trace-001",
      "span_id": "span-003",
      "parent_span_id": "span-002",
      "level": "error",
      "category": "exception",
      "message": "TypeError: undefined",
      "timestamp": 1781161400600
    }
  ]
}
```

**链路树构建方式**（给 AI 参考）：
```
root (parent_span_id=null)
  └── span-002 (parent_span_id=span-001)
        └── span-003 (parent_span_id=span-002)
```

### GET `/api/stats` — 统计数据

**Query 参数**：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| start_time | number | 1小时前 | 起始时间戳(ms) |
| end_time | number | 当前 | 结束时间戳(ms) |

**响应 200**：
```json
{
  "total_logs": 50000,
  "error_count": 123,
  "warn_count": 45,
  "events": {
    "page_view": 12000,
    "button_click": 8000,
    "pay_success": 500
  },
  "top_errors": [
    {"message": "TypeError: Cannot read property", "count": 10},
    {"message": "Network Error", "count": 8}
  ],
  "time_series": [
    {"time": "2026-06-11T07:03:00Z", "count": 200},
    {"time": "2026-06-11T07:04:00Z", "count": 180}
  ]
}
```

### GET `/api/health` — 健康检查

**响应 200**：
```json
{"status": "ok", "timestamp": 1781161400000}
```

---

## HTTP 状态码说明

| 状态码 | 含义 | 场景 |
|--------|------|------|
| 200 | 成功 | 所有正常请求 |
| 400 | 参数错误 | 上报数据格式错误、缺少必填字段 |
| 404 | 资源不存在 | 查询不存在的日志 ID 或 traceID |
| 413 | 请求体过大 | 上报数据超过 1MB |
| 500 | 服务端错误 | 数据库异常等 |

## 链路头传递

前端 SDK 通过 HTTP Header 传递链路上下文：

| Header | 说明 | 示例 |
|--------|------|------|
| `x-trace-id` | 链路 ID | `x-trace-id: a1b2c3d4-...` |
| `x-span-id` | 当前 span ID | `x-span-id: e5f6g7h8-...` |
| `x-parent-span-id` | 父 span ID | `x-parent-span-id: i9j0k1l2-...` |

后端中间件会解析这些 Header 并注入到 `req.traceContext`。
