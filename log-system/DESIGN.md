# 日志系统设计文档 v1.0

---

## 1. 产品概念

### 1.1 核心定位
一套**面向 Web 前后端**的完整链路日志系统，业务代码几乎零侵入，自动采集 + 主动埋点，提供可视化日志看板。

### 1.2 解决什么问题
| 痛点 | 方案 |
|------|------|
| 线上问题难以复现 | 完整链路追踪，按 traceID 串联用户操作全流程 |
| 业务埋点代码侵入大 | SDK 自动捕获 + 极简 API，一行代码完成主动上报 |
| 前端异常不可见 | 自动捕获未处理异常、网络请求失败、Promise 异常 |
| 日志分散难以关联 | 前后端共享 traceID，从浏览器到服务器完整串联 |
| 排查效率低 | 日志看板支持筛选、搜索、链路详情、异常聚合 |

### 1.3 核心概念定义

| 术语 | 说明 |
|------|------|
| **traceID** | 链路ID，一次用户操作的全流程唯一标识，前端生成，HTTP Header 透传到后端 |
| **spanID** | 当前环节的唯一标识，用于构建调用树 |
| **parentSpanID** | 父级环节ID，串联父子关系 |
| **主动上报** | 业务代码调用 `Logger.track()` / `Logger.error()` 手动上报 |
| **被动上报** | SDK 自动捕获异常、请求、路由变化、性能指标等，无需业务代码改动 |
| **Log Level** | debug / info / warn / error / fatal，支持按级别筛选 |
| **Category** | log 分类：event(埋点)、exception(异常)、request(请求)、page(页面)、performance(性能) |
| **本地队列** | 前端 IndexedDB 缓存，上报失败时自动重试，避免丢日志 |

---

## 2. 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器端                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                 前端 SDK (@log-system/sdk)           │   │
│  │                                                      │   │
│  │  ┌─────────────┐   ┌─────────────┐                  │   │
│  │  │ 被动上报引擎  │   │ 主动上报API  │                  │   │
│  │  │  - onerror   │   │  .track()   │                  │   │
│  │  │  - onreject  │   │  .error()   │                  │   │
│  │  │  - fetch wrap│   │  .info()    │                  │   │
│  │  │  - route     │   └──────┬──────┘                  │   │
│  │  │  - perf      │          │                         │   │
│  │  └──────┬───────┘          │                         │   │
│  │         │                  │                         │   │
│  │         ▼                  ▼                         │   │
│  │  ┌────────────────────────────────────┐              │   │
│  │  │        上报调度器                     │              │   │
│  │  │  - 生成 traceID / spanID            │              │   │
│  │  │  - 合并 + 去重 + 节流               │              │   │
│  │  │  - 本地队列 (IndexedDB)             │              │   │
│  │  │  - 自动重试 (指数退避)              │              │   │
│  │  └────────────────┬───────────────────┘              │   │
│  └───────────────────┼──────────────────────────────────┘   │
│                      │ POST /api/logs                       │
│                      │ Header: x-trace-id                   │
└──────────────────────┼──────────────────────────────────────┘
                       │
┌──────────────────────┼──────────────────────────────────────┐
│                      ▼                                      │
│              后端日志服务 (@log-system/server)               │
│                                                             │
│  ┌─────────────────────────────────────────────┐           │
│  │           接收层 (Express 中间件)             │           │
│  │  - traceID 解析 / 不存在则生成               │           │
│  │  - 参数校验 (JSON Schema)                   │           │
│  │  - 敏感字段脱敏 (手机号/邮箱/身份证)          │           │
│  │  - IP 解析                                  │           │
│  └──────────────────┬──────────────────────────┘           │
│                     │                                      │
│                     ▼                                      │
│  ┌─────────────────────────────────────────────┐           │
│  │           写入层 (异步批量)                   │           │
│  │  - 内存缓存合并 (100ms 窗口 / 100条阈值)      │           │
│  │  - 批量 INSERT OR IGNORE                    │           │
│  │  - 写入失败降级 -> 日志文件                   │           │
│  │  - 更新 traces 汇总表                        │           │
│  └──────────────────┬──────────────────────────┘           │
│                     │                                      │
│                     ▼                                      │
│  ┌─────────────────────────────────────────────┐           │
│  │               SQLite 存储                    │           │
│  │  - logs 表 (明细)                           │           │
│  │  - traces 表 (链路汇总)                     │           │
│  │  - 自动 WAL 模式                            │           │
│  └─────────────────────────────────────────────┘           │
│                                                             │
│  ┌─────────────────────────────────────────────┐           │
│  │           查询 API (REST)                    │           │
│  │  GET  /api/logs         列表+筛选           │           │
│  │  GET  /api/logs/:id     单条详情            │           │
│  │  GET  /api/traces/:id   链路详情            │           │
│  │  GET  /api/stats        统计聚合            │           │
│  └─────────────────────────────────────────────┘           │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────┼──────────────────────────────────────┐
│                      ▼                                      │
│              日志管理界面 (@log-system/ui)                  │
│                                                             │
│  ┌─────────────────────────────────────────────┐           │
│  │  主面板                                       │           │
│  │  ┌─────────┐ ┌───────────────────────────┐  │           │
│  │  │ 筛选栏   │ │ 实时日志流 / 列表         │  │           │
│  │  │ - 级别   │ │ - 时间线 + 缩略信息       │  │           │
│  │  │ - 分类   │ │ - 异常高亮 (红色)         │  │           │
│  │  │ - 关键词 │ │ - 点击展开详情           │  │           │
│  │  │ - 时间   │ │ - 链路跳转               │  │           │
│  │  └─────────┘ └───────────────────────────┘  │           │
│  │                                             │           │
│  │  ┌───────────────────────────────────────┐  │           │
│  │  │ 详情 / 链路追踪面板                    │  │           │
│  │  │ - 日志完整信息                        │  │           │
│  │  │ - 链路图 (树形时间线)                  │  │           │
│  │  │ - 关联日志列表                        │  │           │
│  │  └───────────────────────────────────────┘  │           │
│  └─────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 用户交互路径

### 3.1 主要路径

#### 路径 A：业务主动埋点上报
```
业务代码调用 Logger.track('pay_success', { amount: 99.9 })
  → SDK 生成 traceID(如已有则复用) + spanID
  → 写入本地队列 (IndexedDB)
  → 调度器批量 POST /api/logs
  → 后端校验/脱敏/异步写入 SQLite
  → 更新 traces 汇总表
```

#### 路径 B：异常自动捕获上报（被动）
```
用户操作引发未捕获异常
  → window.onerror 捕获
  → SDK 自动生成 traceID + spanID
  → 附加 context: URL, UA, 调用栈
  → 写入本地队列 → 上报 → 存储
```

#### 路径 C：开发查看日志
```
打开日志看板
  → 默认加载最近 1 小时日志 (GET /api/logs)
  → 筛选 error 级别 → 列表过滤
  → 点击某条异常 → 查看详情
  → 点击"查看链路" → GET /api/traces/:traceID
  → 渲染链路树形时间线
```

### 3.2 异常路径

| 场景 | 处理策略 |
|------|----------|
| 网络断开 | 日志留在 IndexedDB 本地队列，恢复后按序重发 |
| 上报接口 500 | 指数退避重试 (1s / 2s / 4s / 8s / 16s 上限) |
| 本地队列满 ( > 5000条) | 丢弃最旧的 10% 日志，记录 "drop_logs" 事件 |
| SQLite 写入失败 | 降级写入服务器本地日志文件 |
| traceID 冲突 (UUID v4) | 概率极低，忽略 |
| 后端重启 | 前端重试，幂等写入 (INSERT OR IGNORE) |
| 敏感信息泄漏 | 脱敏正则替换手机号/邮箱/身份证/Token |

---

## 4. 数据流设计

### 4.1 链路追溯数据流

```
[页面加载]                     traceID-A
  ├── [点击支付按钮]             traceID-A / spanID-A1 (parentSpanID: root)
  │     ├── POST /api/order      traceID-A / spanID-A2 (parentSpanID: A1)
  │     │     └── 后端处理        traceID-A / spanID-B1 (parentSpanID: A2)
  │     └── 支付成功回调          traceID-A / spanID-A3 (parentSpanID: A1)
  └── [页面跳转]                 traceID-A / spanID-A4 (parentSpanID: root)
```

### 4.2 traceID 生成与传递

```
前端首次操作：
  → navigator.sendBeacon? 取 URL 参数 ?_trace=xxx
  → 否则生成 UUID v4
  → 存入 sessionStorage (单次会话内复用)

前端发起请求 (axios/fetch 拦截器)：
  → 请求头添加 x-trace-id: currentTraceID
  → 请求头添加 x-span-id: newSpanID
  → 请求头添加 x-parent-span-id: currentSpanID

后端接收：
  → 从请求头读取 traceID / spanID
  → 如果没有，生成新的
  → 传递给后续处理环节
```

---

## 5. API 设计

### 5.1 日志上报

```
POST /api/logs
Content-Type: application/json
x-trace-id: <traceID>  (可选，SDK 已生成则可直接传入 body)

Body:
{
  "logs": [
    {
      "trace_id": "uuid",
      "span_id": "uuid",
      "parent_span_id": "uuid | null",
      "level": "info",
      "category": "event",
      "event_key": "button_click",
      "message": "用户点击了提交按钮",
      "data": { "button_name": "submit_order" },
      "source": "frontend",
      "url": "https://example.com/order",
      "user_agent": "Mozilla/5.0 ...",
      "timestamp": 1718000000000
    }
  ]
}

Response 200:
{ "accepted": 5, "errors": [] }
```

### 5.2 日志查询

```
GET /api/logs
  ?level=error                  // 按级别筛选
  &category=exception           // 按分类筛选
  &event_key=pay_success        // 按埋点事件筛选
  &trace_id=xxx                 // 按链路查询
  &keyword=xxx                  // 全文关键词
  &start_time=1718000000000     // 起始时间
  &end_time=1718003600000       // 结束时间
  &page=1&page_size=50          // 分页
  &sort=desc                    // 排序

Response:
{
  "total": 1000,
  "page": 1,
  "page_size": 50,
  "items": [...]
}
```

### 5.3 链路详情

```
GET /api/traces/:traceID

Response:
{
  "trace_id": "uuid",
  "root_span_id": "uuid",
  "start_time": 1718000000000,
  "end_time": 1718000005000,
  "span_count": 12,
  "has_error": true,
  "summary": "支付流程 - 3步",
  "spans": [
    { "span_id": "...", "parent_span_id": null, ... },
    { "span_id": "...", "parent_span_id": "root", ... }
  ]
}
```

### 5.4 统计

```
GET /api/stats
  ?start_time=xxx&end_time=xxx

Response:
{
  "total_logs": 50000,
  "error_count": 123,
  "events": {
    "page_view": 1200,
    "button_click": 800
  },
  "top_errors": [
    { "message": "TypeError: xxx", "count": 10 }
  ],
  "time_series": [
    { "time": "2024-06-11T10:00:00Z", "count": 200 }
  ]
}
```

---

## 6. 前端 SDK 设计细节

### 6.1 初始化配置

```typescript
interface LoggerConfig {
  endpoint: string;              // 上报地址，默认 '/api/logs'
  appName: string;               // 应用名，如 'web-app'
  environment: string;           // 'production' | 'staging' | 'development'
  
  // 被动上报开关
  autoCapture: {
    error?: boolean;             // 自动捕获异常，默认 true
    promise?: boolean;           // 自动捕获 Promise 异常，默认 true
    request?: boolean;           // 自动捕获网络请求，默认 true
    route?: boolean;             // 自动捕获路由变化，默认 true
    performance?: boolean;       // 自动采集性能指标，默认 false
    click?: boolean;             // 自动采集点击事件，默认 false
  };
  
  // 采样配置
  sampleRate?: number;           // 0-1，默认 1（全员采集）
  
  // 本地队列
  maxQueueSize?: number;         // 最大队列长度，默认 5000
  retryInterval?: number;        // 初始重试间隔 ms，默认 1000
  maxRetries?: number;           // 最大重试次数，默认 5
}
```

### 6.2 业务 API

```typescript
// -- 主动上报 API（业务代码调用，极简签名）--

// 埋点事件
Logger.track('pay_success', { amount: 99.9, channel: 'wechat' });

// 自定义错误
Logger.error('请求失败', { status: 500, url: '/api/order' });

// 自定义信息
Logger.info('用户完成注册', { userId: '123' });

// 设置用户标识（后续日志自动携带）
Logger.setUserId('user_xxx');
```

### 6.3 被动上报内容

| 分类 | 触发时机 | 自动采集字段 |
|------|----------|-------------|
| exception | window.onerror | message, source, lineno, colno, error.stack |
| exception | unhandledrejection | reason.message, reason.stack |
| request | axios/fetch 响应 | method, url, status, duration, requestData(可选) |
| page | 路由变化 | from, to, title, duration(停留时间) |
| performance | 页面加载 | FCP, LCP, CLS, TTFB, DOMContentLoaded |
| click | 点击事件(可选) | selector, text, x, y |

---

## 7. 界面布局描述

### 7.1 主看板布局
```
┌─────────────────────────────────────────────────────────────┐
│  [Logo]  日志中心                    [时间选择] [刷新]      │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────┐ ┌─────────────────────────────────────────┐   │
│  │ 筛选栏   │ │ 日志列表                                │   │
│  │          │ │                                         │   │
│  │ ☐ debug  │ │ [e][10:00:01.123] TypeError: xxx      │   │
│  │ ☑ info   │ │ [w][10:00:01.200] Slow request 1.2s  │   │
│  │ ☑ warn   │ │ [i][10:00:02.001] page_view: /home   │   │
│  │ ☑ error  │ │ [e][10:00:02.500] Network Error      │   │
│  │ ☐ fatal  │ │ [i][10:00:03.100] pay_success ￥99.9 │   │
│  │          │ │                     ...更多...           │   │
│  │ 分类:     │ │                                         │   │
│  │ ☑ 全部   │ │ [分页: 1 2 3 ... 10]                    │   │
│  │ ☐ 异常   │ │                                         │   │
│  │ ☐ 埋点   │ └─────────────────────────────────────────┘   │
│  │ ☐ 请求   │                                             │
│  │ ☐ 页面   │ ┌─────────────────────────────────────────┐   │
│  │ ☐ 性能   │ │ 链路面板 (点击列表项后展开)              │   │
│  │          │ │                                         │   │
│  │ 搜索:    │ │  [root] 0ms                             │   │
│  │ [______] │ │   ├─ [page_view] /home  10ms           │   │
│  │          │ │   ├─ [click] 按钮A     200ms           │   │
│  │ 统计:    │ │   │  └─ [request] POST/api 450ms 🟢   │   │
│  │ 总日志:500│ │   └─ [error] TypeError 500ms 🔴       │   │
│  │ 异常:  12 │ │                                         │   │
│  └─────────┘ └─────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  [聚合统计] 异常Top5 │ 事件Top10 │ 时间分布图              │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 视觉设计原则
- **异常日志**：红色左侧边框 + 🔴 图标
- **Warn 日志**：黄色左侧边框 + 🟡 图标
- **Info 日志**：灰色左侧边框
- **链路图**：树形缩进，蓝色为请求，红色为异常，绿色为成功
- **每列信息**：时间(灰) → 级别(色块) → 分类(标签) → 摘要信息
- **图片/视觉提示**：用颜色和图标区分级别，不依赖文字

---

## 8. 隐私与安全

1. **脱敏规则**：自动对 `data` 字段中匹配手机号 (`1[3-9]\d{9}`)、邮箱、身份证、token 等做 `***` 替换
2. **采样率控制**：生产环境默认采样率 0.1，可动态调整
3. **数据保留**：默认保留 30 天，自动清理过期数据
4. **用户授权**：符合 GDPR/个人信息保护法，首次上报需用户同意
5. **上报链路**：仅上报必要的诊断信息，不上报 cookie/session

---

## 9. 技术选型

| 层 | 技术 | 理由 |
|----|------|------|
| 前端 SDK | TypeScript + Rollup | 轻量打包，支持 ES Module / UMD |
| 后端服务 | Express + TypeScript | 简单轻量，适合日志接收 |
| 数据库 | better-sqlite3 | 同步 API 性能好，无需配置 |
| UI 框架 | React + Tailwind CSS | 快速构建，视觉一致性 |
| 前端队列 | IndexedDB + idb-keyval | 异步存储，多 Tab 共享 |
| 链路追踪 | 自实现 traceID 传递 | 轻量，无需引入 OpenTelemetry |

---

## 10. 测试策略

### 10.1 单元测试
- SDK：Logger.track/error/info 调用校验
- SDK：本地队列 push/pop/retry 逻辑
- SDK：脱敏正则正确性
- 后端：日志接收与校验
- 后端：批量写入幂等性

### 10.2 集成测试
- SDK → 后端 → SQLite 完整链路写入
- traceID 跨前后端传递验证
- 本地队列断网重试

### 10.3 E2E 测试
- 模拟用户页面操作 → 被动上报触发 → 看板可见
- 业务调用主动 API → 看板可见
- 筛选/搜索/链路追踪功能

---

## 待确认事项

1. **采样策略**：是否支持服务端动态下发采样率？
2. **存储容量**：SQLite 设计为单机 demo 使用，后续是否需要考虑迁移 PostgreSQL？
3. **用户身份**：是否对接已有用户系统，还是 SDK 单独维护 userId？
4. **上报协议**：批量上报数组还是单个上报？目前设计为批量数组。
5. **性能采集**：CLS/LCP 采集默认开启还是按需？
6. **是否要支持 WebSocket 实时推流**？目前设计是轮询，实时性要求高可加 WS。

---

请审阅以上设计文档，确认无异议后我开始编码实现。
