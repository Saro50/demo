# 集成测试 Demo

验证 log-system 各组件是否正常工作。

## 目录

```
demo/
├── e2e/
│   ├── api-test.mjs      # API 端点自动化测试（Node.js）
│   └── server-check.mjs  # 服务健康检查脚本
├── browser/
│   └── sdk-test.html     # SDK 浏览器端手动测试页
├── package.json           # 通过 file: 协议引用本地 SDK 包
└── README.md
```

## 前置条件

```bash
# 1. log-system 根目录安装（建立 workspace 链接）
cd /path/to/log-system && npm install

# 2. 启动后端服务
cd packages/server && npm run dev
# 服务运行在 http://localhost:3100
```

## 测试方式

### 1. API 端点自动测试（Node.js）

验证所有 HTTP 接口是否正常：

```bash
cd demo
npm install        # 安装 @myby/log-sdk / @myby/log-shared（file: 协议链接到本地）
node e2e/server-check.mjs   # 检查服务是否运行
node e2e/api-test.mjs       # 运行完整 API 测试
```

预期输出：
```
🔍 日志服务 API 测试

1️⃣  健康检查
  ✅ /api/health 返回 ok

2️⃣  日志 CRUD（上报 → 查询 → 链路）
  ✅ 完整 CRUD 流程

3️⃣  统计接口
  ✅ /api/stats 返回格式正确

4️⃣  参数校验
  ✅ 缺失字段和非法值被正确拒绝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  结果: 4 通过, 0 失败
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 2. SDK 浏览器测试（手动）

验证 SDK 初始化、主动上报、被动捕获：

```bash
# 确保后端已启动，然后在 demo 目录下：
cd demo
npm install
npm run test:browser
```

Vite 自动打开 `http://localhost:3101/sdk-test.html`：

1. 默认后端地址为 `http://localhost:3100`，如果不同可修改输入框
2. 点击 **「初始化 SDK」** — 验证后端连通性 + SDK 初始化
3. 点击各按钮，观察页面上的日志输出：
   - **埋点事件** → Logger.track()，category=event
   - **上报异常** → Logger.error()，category=exception
   - **上报信息** → Logger.info()，category=event
   - **触发 JS 错误** → 被 window.onerror 自动捕获
   - **触发 Promise 拒绝** → 被 unhandledrejection 自动捕获
   - **触发网络请求** → 被 fetch 拦截器自动捕获
4. 打开 DevTools Console，过滤 `[LogSystem]` 查看 SDK 内部日志
5. 切换到日志看板 `http://localhost:5173` 确认日志已入库

> Vite 会自动处理 TypeScript 编译和 `@myby/log-sdk` 的模块解析，不需要任何额外配置。

### 3. 验证集成方式

`package.json` 演示了外部项目如何引用本地包：

```json
{
  "dependencies": {
    "@myby/log-sdk": "file:../packages/sdk",
    "@myby/log-shared": "file:../packages/shared"
  }
}
```

`npm install` 后，`node_modules/@myby/` 下会建立符号链接，SDK 源码变更即时生效。

## 测试清单

- [ ] `server-check.mjs` 返回 ✅
- [ ] `api-test.mjs` 全部 4 项通过
- [ ] 浏览器 SDK 测试页初始化成功
- [ ] track/error/info 按钮触发后日志出现在看板
- [ ] 被动捕获的异常和请求出现在看板
