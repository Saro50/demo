# 5 分钟跑通全链路

> 从零启动后端服务 → 模拟前端上报 → 日志看板查看结果

---

## 1. 启动后端服务

```bash
cd packages/server
npm install    # 首次运行
npm run dev    # 开发模式，tsx watch 自动重启
```

预期输出：
```
Log Service running at: http://localhost:3100
DB: ./data/logs.db
```

验证：
```bash
curl http://localhost:3100/api/health
# → {"status":"ok","timestamp":...}
```

## 2. 模拟前端上报

```bash
curl -X POST http://localhost:3100/api/logs \
  -H "Content-Type: application/json" \
  -H "x-trace-id: demo-trace-001" \
  -d '{
    "logs": [
      {
        "trace_id": "demo-trace-001",
        "span_id": "span-page-load",
        "parent_span_id": null,
        "level": "info",
        "category": "page",
        "message": "页面加载: /home",
        "source": "frontend",
        "timestamp": 1781161400000
      },
      {
        "trace_id": "demo-trace-001",
        "span_id": "span-click-btn",
        "parent_span_id": "span-page-load",
        "level": "info",
        "category": "event",
        "event_key": "button_click",
        "message": "用户点击提交按钮",
        "data": {"button_id": "submit-order", "page": "/home"},
        "source": "frontend",
        "timestamp": 1781161400500
      },
      {
        "trace_id": "demo-trace-001",
        "span_id": "span-error",
        "parent_span_id": "span-click-btn",
        "level": "error",
        "category": "exception",
        "message": "TypeError: Cannot read property 'price' of undefined",
        "data": {"stack": "at Object.submit (order.js:45:12)"},
        "source": "frontend",
        "timestamp": 1781161400600
      }
    ]
  }'
```

预期返回：
```json
{"accepted": 3, "errors": []}
```

## 3. 查询日志

```bash
# 查看所有日志
curl "http://localhost:3100/api/logs" | python3 -m json.tool

# 只看异常
curl "http://localhost:3100/api/logs?level=error" | python3 -m json.tool

# 按链路查看
curl "http://localhost:3100/api/traces/demo-trace-001" | python3 -m json.tool

# 统计数据
curl "http://localhost:3100/api/stats" | python3 -m json.tool
```

## 4. 启动日志看板

```bash
cd packages/ui
npm install    # 首次运行
npm run dev    # 启动在 http://localhost:3101
```

打开浏览器访问 `http://localhost:3101`，即可看到刚上报的日志。

## 5. 前端 SDK 集成到业务项目

包尚未发布 npm，在 `package.json` 中用 `file:` 协议引用本地路径：

```json
{
  "dependencies": {
    "@myby/log-sdk": "file:../log-system/packages/sdk",
    "@myby/log-shared": "file:../log-system/packages/shared"
  }
}
```

```bash
npm install
```

```typescript
// 安装后即可使用
import { Logger } from '@myby/log-sdk';

// 在应用入口初始化（只执行一次）
Logger.init({
  endpoint: 'http://localhost:3100/api/logs',  // 后端地址
  appName: 'my-app',
  environment: 'production',
});

// 业务埋点
function onPaySuccess(amount: number) {
  Logger.track('pay_success', { amount, channel: 'wechat' });
}

// 业务异常
function onApiError(err: Error) {
  Logger.error('API 请求失败', { message: err.message, code: 500 });
}
```

---

## 验证清单

- [ ] 后端服务启动成功（端口 3100）
- [ ] 模拟上报返回 `accepted: 3`
- [ ] 查询接口返回刚上报的日志
- [ ] 链路接口显示完整 3 个 span
- [ ] 日志看板 UI 正常渲染
- [ ] SDK 集成后业务项目编译通过
