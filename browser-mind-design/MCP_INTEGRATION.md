# BrowserMind × Playwright MCP 集成方案

> **核心思路**：Playwright MCP 提供了"手"，BrowserMind 提供"脑 + 眼睛"——两者互补，不是竞争关系。

---

## 1. 角色分析

### Playwright MCP 是什么
微软开源的 **MCP 服务器**，将 Playwright 的浏览器操作暴露为标准化的 MCP 工具集：
- `browser_navigate(url)` — 导航
- `browser_click(selector)` — 点击
- `browser_type(selector, text)` — 输入
- `browser_snapshot()` — 获取无障碍树 + 截图
- `browser_evaluate(script)` — 执行 JS

### BrowserMind 是什么
本框架（还未命名），在 Playwright 之上增加：
- **智能 DOM 压缩**（150KB → 3-8KB）
- **预置探针引擎**（一键探测表单/导航/交互元素）
- **安全守卫**（脚本沙箱、脱敏、熔断器、死锁检测）
- **全链路日志**（Pino + Prisma 持久化）
- **规划器**（自动编排多步探测）

### 两者定位

```
                 Playwright MCP              BrowserMind
                ──────────────────          ─────────────────
  抽象层级      工具层（Tool Layer）          智能层（Intelligence Layer）
  目标          让 LLM "能操作浏览器"         让 LLM "能理解网页"
  输出          原始 HTML / 截图 / A11y树    压缩 DOM / 语义结构 / 交互热点
  安全          ❌ 无内置安全机制             ✅ 完整的脚本审核 + 脱敏
  记忆          ❌ 无持久化                   ✅ Pino + Prisma 全链路日志
  探针          ❌ 无预置探针                 ✅ 结构化探测脚本引擎
```

**结论：两者是互补关系，BrowserMind 应该构建在 Playwright MCP 之上，而不是与之竞争。**

---

## 2. 推荐的集成架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│  MCP Client                                                              │
│  (Claude Desktop / Cursor / VS Code / 自定义 LLM 应用)                    │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │ MCP Protocol (JSON-RPC)
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  BrowserMind MCP Server (browser-mind-mcp)                         │ │
│  │                                                                     │ │
│  │  ┌──────────────────────────────────────────────────────────────┐  │ │
│  │  │  High-Level Probe Tools（BrowserMind 独家能力）               │  │ │
│  │  │  ├── probe_page_structure()     → 压缩语义 DOM               │  │ │
│  │  │  ├── probe_interactive_elements() → 可交互元素清单            │  │ │
│  │  │  ├── probe_forms()              → 表单结构 + 校验规则        │  │ │
│  │  │  ├── probe_navigation()         → 导航菜单结构               │  │ │
│  │  │  ├── extract_data(pattern)      → 智能数据提取               │  │ │
│  │  │  ├── assert_state(condition)    → 智能断言                   │  │ │
│  │  │  ├── explore_page(goal)         → 多步自动探索               │  │ │
│  │  │  └── compare_snapshots()        → 页面差异检测               │  │ │
│  │  └──────────────────────────────────────────────────────────────┘  │ │
│  │                                   │                                  │ │
│  │  ┌──────────────────────────────────────────────────────────────┐  │ │
│  │  │  BrowserMind Core                                            │  │ │
│  │  │  ├── Observation Layer（DOM 压缩 + 结构提取）                 │  │ │
│  │  │  ├── Safety Guard（脚本审核 + 数据脱敏 + 熔断器）             │  │ │
│  │  │  ├── Action Planner（意图解析 + 动作编排 + 死锁检测）         │  │ │
│  │  │  └── Logging Layer（Pino + Prisma 全链路）                   │  │ │
│  │  └──────────────────────────────────────────────────────────────┘  │ │
│  │                                   │                                  │ │
│  │  ┌──────────────────────────────────────────────────────────────┐  │ │
│  │  │  Playwright MCP（内部调用）                                   │  │ │
│  │  │  ├── browser_navigate(url)       → 底层导航                  │  │ │
│  │  │  ├── browser_click(selector)     → 底层点击                  │  │ │
│  │  │  ├── browser_type(selector,text) → 底层输入                  │  │ │
│  │  │  ├── browser_snapshot()          → 原始无障碍树 + 截图       │  │ │
│  │  │  └── browser_evaluate(script)    → 原始 JS 执行             │  │ │
│  │  └──────────────────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
                   ┌───────────────┐
                   │  浏览器实例    │
                   └───────────────┘
```

### 2.2 关键设计决策

| 决策 | 说明 |
|------|------|
| **BrowserMind 作为 MCP Server** | 实现 MCP 协议，暴露高级探针工具 |
| **内部调用 Playwright MCP** | `browser-mind-mcp` 内嵌 `@playwright/mcp` 作为依赖 |
| **LLM 自由选择工具** | LLM 可以混合使用高级探针和底层操作 |
| **安全层前置** | 所有通过 MCP 的脚本执行都经过 Safety Guard |

---

## 3. MCP 协议集成

### 3.1 工具定义（Tools）

```typescript
// MCP 工具注册示例
server.tool(
  'probe_page_structure',
  '获取页面的语义化 DOM 结构（压缩后，适合 LLM 理解）',
  {},  // 无需参数，自动探测当前页面
  async () => {
    // 1. 通过 Playwright MCP 获取当前页面
    // 2. ObservationBuilder 压缩 DOM
    // 3. SafetyGuard 脱敏
    // 4. 返回结构化结果
    const structure = await observationBuilder.getPageStructure(page);
    return { content: [{ type: 'text', text: JSON.stringify(structure) }] };
  }
);

server.tool(
  'probe_forms',
  '探测页面所有表单的字段结构、校验规则',
  {},  // 可选参数：表单索引
  async (args) => {
    const result = await probeEngine.execute(page, { probeName: 'getForms' });
    return { content: [{ type: 'text', text: JSON.stringify(result.rawResult) }] };
  }
);

server.tool(
  'explore_page',
  '自动多步探索页面，理解页面功能结构',
  { goal: 'string' },  // 探索目标
  async ({ goal }) => {
    const mind = new BrowserMind(config);
    const result = await mind.run(goal);
    return { content: [{ type: 'text', text: result.summary || '探索完成' }] };
  }
);
```

### 3.2 资源定义（Resources）

```typescript
// 暴露结构化页面信息作为 MCP 资源
server.resource(
  'page://current/structure',
  '当前页面的压缩 DOM 结构',
  async (uri) => {
    const data = await observationBuilder.getPageStructure(page);
    return { mimeType: 'application/json', text: JSON.stringify(data) };
  }
);

server.resource(
  'session://{id}/log',
  '会话的完整执行日志',
  async (uri) => {
    const sessionId = uri.pathname.split('/')[1];
    const actions = await db.actionLog.findMany({ where: { sessionId } });
    return { mimeType: 'application/json', text: JSON.stringify(actions) };
  }
);
```

---

## 4. 三种集成模式

### 模式 A: BrowserMind 作为独立 MCP Server（推荐）

```
npm install browser-mind-mcp @playwright/mcp

# 启动 MCP Server
npx browser-mind-mcp start --port 3100
```

**LLM 客户端配置（Claude Desktop 示例）：**
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp"]
    },
    "browser-mind": {
      "command": "npx",
      "args": ["browser-mind-mcp"],
      "env": {
        "OPENAI_API_KEY": "...",
        "DATABASE_URL": "file:./dev.db"
      }
    }
  }
}
```

**LLM 使用方式：**
```
User: "这个登录页面有什么问题？"
LLM: 
  1. 调用 playwright.browser_snapshot → 看到页面截图
  2. 调用 browser-mind.probe_forms → 获取表单结构
  3. 调用 browser-mind.probe_page_structure → 获取完整结构
  4. 分析后回复用户
```

### 模式 B: BrowserMind 嵌入 Playwright MCP（插件模式）

利用 Playwright MCP 的插件机制（如果未来支持），将 BrowserMind 的探针工具作为插件注入：

```
npx @playwright/mcp --plugins browser-mind
```

### 模式 C: BrowserMind 纯上层 Prompt 模式（最低耦合）

不修改代码，由 **BrowserMind 生成系统提示词**，教导 LLM 如何有效使用 Playwright MCP 的工具：

```typescript
// BrowserMind 生成优化后的 system prompt
const prompt = browserMind.generateMCPPrompt({
  // 告诉 LLM 在 snapshot 后应该调用 probe 工具深入
  tools: ['probe_page_structure', 'probe_forms'],
  // 指导 LLM 的探索策略
  strategy: '先从大结构开始，再深入细节'
});
```

---

## 5. 对现有代码的改造

### 5.1 新增模块

```
browser-mind/
├── src/
│   ├── mcp/
│   │   ├── mcpServer.ts        # MCP 服务器入口
│   │   ├── tools/              # MCP 工具定义
│   │   │   ├── probeTools.ts   # 高级探针工具
│   │   │   ├── exploreTool.ts  # 自动探索工具
│   │   │   └── assertTool.ts   # 断言工具
│   │   ├── resources/          # MCP 资源定义
│   │   └── transports/         # 传输层（stdio/SSE）
│   ├── core/
│   │   └── execution/
│   │       └── mcpExecutor.ts  # 通过 Playwright MCP 执行
└── └── ...
```

### 5.2 关键改动

```typescript
// 新增：MCP 执行器（替代直接 Playwright 调用）
class MCPExecutor {
  private mcpClient: MCPClient;
  private safetyGuard: SafetyGuard;
  
  async navigate(url: string): Promise<void> {
    // 通过 MCP 工具执行，而不是直接 Playwright API
    await this.mcpClient.callTool('browser_navigate', { url });
  }
  
  async probeStructure(): Promise<CompressedNode> {
    // 先通过 MCP 获取原始快照
    const snapshot = await this.mcpClient.callTool('browser_snapshot', {});
    // 再用 ObservationBuilder 压缩
    return this.observationBuilder.compressFromSnapshot(snapshot);
  }
}
```

---

## 6. 对比评估

| 维度 | 纯 Playwright MCP | BrowserMind 独立 | BrowserMind + MCP（推荐）|
|------|------------------|-----------------|-----------------------|
| LLM 接入复杂度 | 直接使用 | 需集成 SDK | 标准 MCP 协议 |
| 页面理解深度 | 浅（原始 DOM/A11y） | 深（压缩语义） | **深** |
| 安全性 | 无 | 完整安全层 | **两层安全** |
| 日志追溯 | 无 | Pino + Prisma | **全链路** |
| 工具丰富度 | 5 个基础工具 | 全套探查工具集 | **基础 + 高级** |
| 部署复杂度 | 极简 | 中等 | 中等（一个 Server） |

---

## 7. 推荐的实施路径

```
Phase 1: BrowserMind 独立 MCP Server（当前可做）
  └─ 将现有的 BrowserMind 核心包装为 MCP Server
  └─ 依赖 @playwright/mcp 作为底层执行引擎
  └─ 对外暴露高级探针工具

Phase 2: 深度融合（Playwright MCP 更新后）
  └─ 利用 Playwright MCP 的新 API（如 snapshot 的 DOM 原始数据）
  └─ BrowserMind 的 ObservationBuilder 直接消费 MCP snapshot 数据
  
Phase 3: 双向调用
  └─ LLM 可以混合使用 Playwright MCP 的底层工具和 BrowserMind 的高层工具
  └─ 示例: snapshot → probe_structure → click → probe_forms
```

---

## 总结

**BrowserMind + Playwright MCP = 1+1 > 2**

| 组件 | 比喻 | 提供的价值 |
|------|------|-----------|
| **Playwright MCP** | 手 | 标准化浏览器操控，MCP 协议兼容 |
| **BrowserMind** | 眼 + 脑 | 智能页面理解，安全守卫，日志追溯 |

让 BrowserMind 实现 MCP Server 协议，既保留了自身的能力，又融入 MCP 生态，是当前最优解。
