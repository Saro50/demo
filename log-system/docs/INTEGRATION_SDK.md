# 前端 SDK 集成指南

> 本文档面向需要将日志 SDK 接入自己前端项目的开发者。

---

## 安装

包尚未发布到 npm。你的业务项目在 log-system monorepo **之外**，有两种方式引用：

### 方式一：file: 协议（推荐）

在你项目的 `package.json` 中直接写本地路径：

```json
{
  "dependencies": {
    "@myby/log-sdk": "file:../log-system/packages/sdk",
    "@myby/log-shared": "file:../log-system/packages/shared"
  }
}
```

然后正常安装：
```bash
npm install
```

`file:` 协议会创建符号链接指向源码目录，SDK 源码变更即时生效，无需重复 `npm install`。

### 方式二：npm link（适合临时测试）

```bash
# 终端1：在 log-system 各个包目录创建全局链接
cd /path/to/log-system/packages/shared && npm link
cd /path/to/log-system/packages/sdk && npm link

# 终端2：在你的项目中链接
cd /path/to/your-app
npm link @myby/log-shared @myby/log-sdk
```

### 注意

两种方式都不需要 `npm publish`，代码改动实时生效。正式发布到 npm 后，改为常规安装即可：
```bash
npm install @myby/log-sdk
```

## 初始化

在**应用入口文件**（如 `main.ts`、`App.tsx`、`main.js`）中执行一次初始化：

```typescript
import { Logger } from '@myby/log-sdk';

// 【必须】初始化
Logger.init({
  endpoint: '/api/logs',            // 后端日志服务地址（同域可省略域名）
  appName: 'web-app',               // 应用名，便于区分多项目
  environment: 'production',        // 'production' | 'staging' | 'development'
});

// 【可选】设置用户标识（后续日志自动携带）
Logger.setUserId('user_12345');
```

> `endpoint` 如果与前端同域，只需写路径 `/api/logs`，Vite/Webpack 可配置代理到后端。
> 如果跨域，需填写完整 URL `https://log.example.com/api/logs`，且后端配置 CORS。

## 主动上报 API

### 埋点事件

```typescript
// 基本用法
Logger.track('page_view', { page: '/home' });

// 带业务数据
Logger.track('pay_success', {
  orderId: 'ORD-2024-001',
  amount: 99.9,
  currency: 'CNY',
  channel: 'wechat',
});

// 无附加数据
Logger.track('button_click');
```

### 异常上报

```typescript
try {
  // ... 业务逻辑
} catch (err) {
  Logger.error('订单处理失败', {
    orderId: 'ORD-2024-001',
    errorMessage: (err as Error).message,
    stack: (err as Error).stack,
  });
}

// 简单用法
Logger.error('网络请求超时');
```

### 自定义信息

```typescript
Logger.info('用户完成注册流程', { userId: 'user_123', duration: 3500 });
Logger.info('数据同步完成', { recordsCount: 150 });
```

## 被动上报（自动捕获，无需代码）

以下功能在 `init()` 时自动启用，**无需业务代码改动**：

| 捕获项 | 触发条件 | 日志示例 |
|--------|----------|----------|
| JS 运行时错误 | `window.onerror` | `level: error, category: exception` |
| Promise 未捕获异常 | `unhandledrejection` | `level: error, category: exception` |
| 网络请求 | fetch 拦截器 | `level: info/error, category: request` |
| 路由变化 | popstate/hashchange | `level: info, category: page` |
| 性能指标 | PerformanceObserver（需配置） | `level: info, category: performance` |
| 点击事件 | document click（需配置） | `level: info, category: event` |

**关闭特定捕获**：
```typescript
Logger.init({
  // ...
  autoCapture: {
    error: true,       // 自动捕获 JS 异常
    promise: true,     // 自动捕获 Promise 异常
    request: true,     // 自动捕获网络请求
    route: true,       // 自动捕获路由变化
    performance: false, // 关闭性能采集（默认关闭）
    click: false,       // 关闭点击采集（默认关闭）
  },
});
```

## 采样控制

生产环境可通过采样率减少日志量：

```typescript
Logger.init({
  sampleRate: 0.1,  // 只采集 10% 的用户
  // sampleRate: 1  // 全部采集（默认）
});
```

## 本地队列与重试

SDK 内部使用 IndexedDB 做本地缓存，断网时日志不丢失：

```
用户操作 → IndexedDB 队列 → 每 2s 批量上报（最多 20 条）→ 后端
                                    ↓ 失败
                              指数退避重试 (1s → 2s → 4s → 8s → 16s)
                                    ↓ 超过 5 次
                              丢弃日志，记录丢弃事件
```

配置项：
```typescript
Logger.init({
  maxQueueSize: 5000,    // 队列最大长度，超限丢弃最旧 10%
  retryInterval: 1000,   // 初始重试间隔 (ms)
  maxRetries: 5,         // 最大重试次数
});
```

## 隐私与脱敏

默认开启数据脱敏，自动识别并替换以下敏感信息：

| 类型 | 原始 | 脱敏后 |
|------|------|--------|
| 手机号 | `13812345678` | `138****5678` |
| 邮箱 | `user@example.com` | `u***@example.com` |
| 身份证 | `110101199001011234` | `110101********1234` |
| Token | `tok_abc123def456` | `tok_***` |

```typescript
// 关闭脱敏（不推荐）
Logger.init({
  sanitize: false,
});
```

## axios 集成（可选）

如果项目使用 axios 而非 fetch，可通过 axios 拦截器补充请求日志：

```typescript
import axios from 'axios';
import { Logger } from '@myby/log-sdk';
import { getOrCreateTraceId, generateSpanId } from '@myby/log-sdk';

// 请求拦截器 - 注入 traceID
axios.interceptors.request.use((config) => {
  config.headers['x-trace-id'] = getOrCreateTraceId();
  config.headers['x-span-id'] = generateSpanId();
  return config;
});

// 响应拦截器 - 记录日志
axios.interceptors.response.use(
  (response) => {
    Logger.track('api_success', {
      method: response.config.method,
      url: response.config.url,
      status: response.status,
    });
    return response;
  },
  (error) => {
    Logger.error('api_failed', {
      method: error.config?.method,
      url: error.config?.url,
      status: error.response?.status,
      message: error.message,
    });
    return Promise.reject(error);
  }
);
```

## React 集成示例

```tsx
// src/main.tsx
import { Logger } from '@myby/log-sdk';

Logger.init({
  appName: 'web-app',
  environment: import.meta.env.MODE,
  autoCapture: {
    performance: import.meta.env.PROD, // 生产环境开启性能采集
  },
});

// src/components/PayButton.tsx
function PayButton({ amount }: { amount: number }) {
  const handleClick = async () => {
    Logger.track('pay_click', { amount });
    try {
      await api.createOrder({ amount });
      Logger.track('pay_success', { amount });
    } catch (err) {
      Logger.error('pay_failed', { amount, error: (err as Error).message });
    }
  };

  return <button onClick={handleClick}>支付 ¥{amount}</button>;
}
```

## Vue 集成示例

```typescript
// src/main.ts
import { Logger } from '@myby/log-sdk';
import { createApp } from 'vue';
import App from './App.vue';

Logger.init({
  appName: 'vue-app',
  environment: process.env.NODE_ENV,
});

// 全局挂载（可选）
const app = createApp(App);
app.config.globalProperties.$logger = Logger;
app.mount('#app');

// 组件内使用
// this.$logger.track('page_view')
```

---

## 常见问题

**Q: SDK 会影响页面性能吗？**
A: 所有操作（队列写入、上报）都是异步的，不阻塞主线程。单次采集耗时 < 0.1ms。

**Q: 用户关闭页面时日志会丢吗？**
A: 页面关闭前会用 `navigator.sendBeacon` 尝试上报剩余日志。如果网络断开，日志留在 IndexedDB 中，下次打开页面时会继续上报。

**Q: 如果后端服务挂了会怎样？**
A: 日志暂存在 IndexedDB 队列中，后端恢复后自动继续上报。队列上限 5000 条，超限丢弃最旧的 10%。
