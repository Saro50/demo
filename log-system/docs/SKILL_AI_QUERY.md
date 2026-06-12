# AI 排障技能：日志查询

> 当被问到需要排查线上问题、查看错误、追踪用户行为或分析系统状态时，使用本技能通过日志服务 API 获取数据。

---

## 1. 连接信息

```
服务地址: http://localhost:3100
健康检查: GET /api/health
```

## 2. API 速查

### 查询日志列表

```
GET /api/logs?{params}
```

| 参数 | 格式 | 示例 | 说明 |
|------|------|------|------|
| `level` | 逗号分隔 | `error,fatal` | 按级别筛选 |
| `category` | 逗号分隔 | `exception,request` | 按分类筛选 |
| `trace_id` | 完整 UUID | `d935c4ed-...` | 精确匹配链路 |
| `user_id` | 字符串 | `user-001` | 按用户筛选 |
| `keyword` | 字符串 | `TypeError` | 搜索 message / data |
| `start_time` | 毫秒时间戳 | `1781161400000` | 起始时间 |
| `end_time` | 毫秒时间戳 | `1781161500000` | 结束时间 |
| `page` | 数字 | `1` | 页码 |
| `page_size` | 数字(≤200) | `50` | 每页条数 |
| `sort` | `asc`/`desc` | `desc` | 排序 |

**响应**：
```json
{
  "total": 100,
  "page": 1,
  "page_size": 50,
  "items": [{ "trace_id": "...", "level": "error", ... }]
}
```

### 查询链路详情

```
GET /api/traces/{trace_id}
```

**响应**：
```json
{
  "trace_id": "xxx",
  "span_count": 5,
  "has_error": true,
  "spans": [{ "span_id": "s1", "parent_span_id": null, ... }]
}
```

### 查询统计

```
GET /api/stats?start_time={ms}&end_time={ms}
```

**响应**：
```json
{
  "total_logs": 50000,
  "error_count": 123,
  "top_errors": [{"message": "TypeError: xxx", "count": 10}]
}
```

---

## 3. 常用排障查询

### 场景一：最近发生了哪些错误？

```bash
# 最近 1 小时所有 error/fatal
curl "http://localhost:3100/api/logs?level=error,fatal&page_size=20"

# 只看异常分类（排除业务埋点中的 error）
curl "http://localhost:3100/api/logs?level=error&category=exception&page_size=20"
```

**看什么**：`items[].message` 列出错误摘要，`items[].data.stack` 看堆栈。如果 `total` 很大，缩小时间范围或用 `page` 翻页。

### 场景二：某个用户遇到了什么问题？

```bash
# 查该用户最近 6 小时的所有日志
curl "http://localhost:3100/api/logs?user_id=user-001&start_time=$(( $(date +%s) - 21600 ))000"

# 只看其中的错误
curl "http://localhost:3100/api/logs?user_id=user-001&level=error"
```

**看什么**：按 `timestamp` 升序排列事件时间线。先 `page_view` → 然后 `click` → 然后 `error`，还原用户操作路径。

### 场景三：某个接口请求慢/报错

```bash
# 查最近某接口的所有请求日志
curl "http://localhost:3100/api/logs?category=request&keyword=/api/order&page_size=20"

# 只看失败的请求
curl "http://localhost:3100/api/logs?category=request&level=error&keyword=/api/order"
```

**看什么**：`data.duration` 字段显示请求耗时（ms）。`level=error` 表示请求失败。

### 场景四：追踪一次完整的用户操作链路

```bash
# 先找到目标 trace_id（从错误日志或用户日志中）
curl "http://localhost:3100/api/logs?level=error&page_size=5"

# 然后用 trace_id 查完整链路
curl "http://localhost:3100/api/traces/{trace_id}"
```

**看什么**：`spans` 按时间排列，`parent_span_id` 构建调用树。`has_error` 标记链路是否有异常。

### 场景五：统计整体健康状态

```bash
# 最近 1 小时统计
curl "http://localhost:3100/api/stats?start_time=$(( $(date +%s) - 3600 ))000&end_time=$(date +%s)000"

# 只看 top_errors 了解最常见的问题
```

**看什么**：`error_count / total_logs` 算错误率。`top_errors` 列出最常见异常及其出现次数。

### 场景六：按关键词搜索具体问题

```bash
# 搜索某段错误信息
curl "http://localhost:3100/api/logs?keyword=Cannot+read+property"

# 搜索某类事件
curl "http://localhost:3100/api/logs?category=event&event_key=pay_success"
```

---

## 4. 时间范围快捷计算

```bash
# 最近 15 分钟
start_time=$(( $(date +%s) - 900 ))000

# 最近 1 小时（默认）
start_time=$(( $(date +%s) - 3600 ))000

# 最近 6 小时
start_time=$(( $(date +%s) - 21600 ))000

# 最近 24 小时
start_time=$(( $(date +%s) - 86400 ))000

# 最近 7 天
start_time=$(( $(date +%s) - 604800 ))000
```

## 5. 诊断响应解读

### 日志级别含义

| 级别 | 含义 | 处理建议 |
|------|------|---------|
| `debug` | 调试信息 | 一般可忽略 |
| `info` | 正常事件 | 用于理解用户操作流程 |
| `warn` | 可恢复的异常 | 关注但不紧急 |
| `error` | 业务/程序错误 | 需要排查原因 |
| `fatal` | 致命错误 | 需立即处理 |

### 日志分类含义

| 分类 | 触发方式 | 典型场景 |
|------|---------|---------|
| `event` | `Logger.track()` | 业务埋点、点击、支付 |
| `exception` | `onerror` / `Logger.error()` | JS 异常、请求失败 |
| `request` | fetch 拦截器 | API 请求耗时、状态码 |
| `page` | 路由监听 | 页面加载、切换 |
| `performance` | PerformanceObserver | FCP、LCP、CLS |

### 链路树判断

```
root (page_load)                    ← 用户进入页面
  └── click (button_submit)         ← 用户点击
      └── request (POST /api/order) ← 触发 API 请求
          └── exception (TypeError) ← 请求返回后报错
```

- 如果 `exception` 出现在 `request` 之后：后端接口返回了异常数据
- 如果只有孤立的 `exception` 没有上下文：可能是指令本身的问题
- 如果 `span_count=1` 且 `has_error=false`：单条信息日志，无需关注

---

## 6. 常见排障流程

### 用户反馈"页面白屏/报错"

```
1. 查用户最近的 error 日志
   → curl "...?user_id={uid}&level=error"
2. 找到报错的 trace_id
3. 查链路详情，看异常上下文
   → curl ".../traces/{trace_id}"
4. 判断错误是前端还是后端
   → source=frontend：JS 执行错误
   → source=backend：服务端返回异常
```

### 用户反馈"功能不可用"

```
1. 查相关接口的请求记录
   → curl "...?category=request&keyword=/api/xxx"
2. 看是否有大量 500/超时
   → data.status >= 500 或 data.duration > 10000
3. 对比正常时段和异常时段的数据量
```

### 告警"错误率突然上升"

```
1. 查统计确认趋势
   → curl ".../stats?start_time=..."
2. 看 top_errors 中新增的错误类型
3. 按新错误类型搜索，定位首次出现时间
   → curl "...?keyword={error_message}&sort=asc&page_size=1"
```
