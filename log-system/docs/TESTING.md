# 测试指南

> 本文档提供测试策略和执行方法，便于 AI 生成测试代码和验证系统功能。

---

## 测试层级

```
┌─────────────────────────────┐
│    E2E 测试 (完整链路)       │  ← 从 SDK 上报到看板展示
├─────────────────────────────┤
│    集成测试 (API + DB)      │  ← HTTP 接口 + SQLite
├─────────────────────────────┤
│    单元测试 (各模块独立)     │  ← SDK/Server/UI 内部逻辑
└─────────────────────────────┘
```

## 1. 单元测试

### SDK 单元测试

```typescript
// 测试 Logger.track 生成正确的 LogEntry
// 测试 LocalQueue push/pop/remove
// 测试 Sanitizer 脱敏正则
// 测试 Reporter 重试延时计算
// 测试 ID 生成器 traceID 会话复用
```

关键测试点：

| 模块 | 测试项 | 预期 |
|------|--------|------|
| `logger.ts` | `Logger.track('click')` 调用后队列+1 | 队列 count = 1 |
| `queue.ts` | `push` 超限后丢弃最旧 10% | 队列长度 = maxSize |
| `queue.ts` | `popBatch(10)` 返回 10 条 | items.length = 10 |
| `reporter.ts` | `getRetryDelay(0)` = ~1s | 800-1200ms |
| `reporter.ts` | `getRetryDelay(5)` 上限 30s | <= 30000ms |
| `sanitizer.ts` | 手机号 `13812345678` → `138****5678` | 匹配 |
| `sanitizer.ts` | 邮箱 `user@example.com` → `u***@example.com` | 匹配 |
| `id.ts` | 同一会话多次调用 `getOrCreateTraceId()` 返回相同值 | 相等 |

### Server 单元测试

```typescript
// 测试日志校验逻辑
// 测试 SQL 参数构建
// 测试脱敏函数
```

### UI 组件测试（可选）

```typescript
// 测试 FilterBar 选中/取消选中
// 测试 LogList 渲染空/有数据状态
// 测试 TracePanel 树形构建
```

## 2. 集成测试

### API 集成测试 (HTTP → DB)

```bash
#!/bin/bash
# test_api.sh - 完整 API 集成测试

BASE_URL="http://localhost:3100"
PASS=0
FAIL=0

check() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "❌ $desc (expected: $expected)"
    echo "   got: $actual"
    FAIL=$((FAIL + 1))
  fi
}

# 1. 健康检查
result=$(curl -s "$BASE_URL/api/health")
check "健康检查返回 ok" '"status":"ok"' "$result"

# 2. 上报日志
result=$(curl -s -X POST "$BASE_URL/api/logs" \
  -H "Content-Type: application/json" \
  -d '{"logs":[{
    "trace_id":"test-trace","span_id":"test-span",
    "level":"error","category":"exception",
    "message":"Test error","source":"frontend",
    "timestamp":1781161400000
  }]}')
check "上报返回 accepted" '"accepted":1' "$result"

# 3. 查询日志
sleep 2
result=$(curl -s "$BASE_URL/api/logs")
check "查询日志 total>=1" '"total":1' "$result"

# 4. 按级别筛选
result=$(curl -s "$BASE_URL/api/logs?level=error")
check "筛选 error 级别" '"total":1' "$result"

result=$(curl -s "$BASE_URL/api/logs?level=info")
check "筛选 info 级别无结果" '"total":0' "$result"

# 5. 链路查询
result=$(curl -s "$BASE_URL/api/traces/test-trace")
check "链路查询" '"trace_id":"test-trace"' "$result"

# 6. 统计
result=$(curl -s "$BASE_URL/api/stats")
check "统计数据" '"total_logs"' "$result"

echo ""
echo "=========================="
echo "结果: $PASS 通过, $FAIL 失败"
echo "=========================="
```

### 链路追踪集成测试

```bash
# 模拟一次完整的用户操作链路
curl -X POST "$BASE_URL/api/logs" \
  -H "Content-Type: application/json" \
  -d '{"logs":[
    {"trace_id":"link-test","span_id":"page-load","parent_span_id":null,"level":"info","category":"page","message":"首页加载","source":"frontend","timestamp":1781161400000},
    {"trace_id":"link-test","span_id":"click-btn","parent_span_id":"page-load","level":"info","category":"event","event_key":"button_click","message":"点击查询","source":"frontend","timestamp":1781161400500},
    {"trace_id":"link-test","span_id":"api-req","parent_span_id":"click-btn","level":"info","category":"request","message":"200 OK","source":"frontend","timestamp":1781161400600},
    {"trace_id":"link-test","span_id":"render","parent_span_id":"api-req","level":"error","category":"exception","message":"RenderError: Cannot read","source":"frontend","timestamp":1781161400700}
  ]}'

# 验证链路完整性
curl -s "$BASE_URL/api/traces/link-test" | python3 -c "
import sys, json
d = json.load(sys.stdin)
spans = d['spans']
print(f'Spans: {len(spans)} (expect 4)')
print(f'Has error: {d[\"has_error\"]} (expect True)')
# 验证树形结构
for s in spans:
    print(f'  [{s[\"level\"]}] {s[\"category\"]}: {s[\"message\"]}  parent={s[\"parent_span_id\"]}')
"
```

## 3. E2E 测试

### 全链路手动测试流程

```
1. 启动后端服务 → 验证 health check
2. 启动日志看板 → 打开 http://localhost:3101
3. 用 curl 模拟前端上报 10 条日志（含异常、埋点、请求）
4. 刷新看板 → 确认日志出现在列表中
5. 筛选 error 级别 → 确认只显示异常
6. 点击某条日志 → 确认链路面板展开
7. 查看链路树 → 确认父子关系正确
8. 查看统计 → 确认总数/异常数/事件排名正确
```

### 前端 SDK 手动测试

```html
<!-- test-sdk.html - 在浏览器中打开测试 SDK -->
<script type="module">
import { Logger } from '@myby/log-sdk';

Logger.init({
  endpoint: 'http://localhost:3100/api/logs',
  appName: 'test-app',
  environment: 'test',
});

// 测试主动上报
Logger.track('test_event', { value: 123 });
Logger.error('test_error', { code: 999 });
Logger.info('test_info');

// 测试被动上报（触发一个错误）
setTimeout(() => {
  throw new Error('SDK test error');
}, 1000);
</script>
```
