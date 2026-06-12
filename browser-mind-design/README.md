# BrowserMind — 基于 Playwright 的 LLM 网页探测测试框架

> **核心理念**：让纯语言模型像人类 QA 工程师一样，通过脚本注入逐层探测 Web 页面，自主理解功能结构并生成测试断言。

---

## 目录

1. [问题定义](#1-问题定义)
2. [整体架构](#2-整体架构)
3. [核心流程](#3-核心流程)
4. [脚本注入引擎](#4-脚本注入引擎)
5. [观察层（Observation Layer）](#5-观察层observation-layer)
6. [动作层（Action Layer）](#6-动作层action-layer)
7. [安全层（Safety Layer）](#7-安全层safety-layer)
8. [日志与可回溯性](#8-日志与可回溯性)
9. [推荐的架构部署模式](#9-推荐的架构部署模式)
10. [用户交互路径与测试路径](#10-用户交互路径与测试路径)
11. [异常与安全边界](#11-异常与安全边界)

---

## 1. 问题定义

### 1.1 痛点

| 问题 | 描述 |
|------|------|
| **LLM 无眼无手** | 纯语言模型无法直接看到页面渲染结果，也无法点击、输入、滚动 |
| **DOM 过于庞大** | 完整 DOM 动辄数千行，远超 LLM 上下文窗口，且充斥无用信息 |
| **动态页面难以抓取** | SPA、异步加载、弹窗等场景，静态 HTML 无法反映真实状态 |
| **缺乏时序感知** | LLM 无法感知动画、loading、过渡等时序交互反馈 |

### 1.2 解决思路

```
LLM(文本输入/输出)  ←→  BrowserMind(中间层)  ←→  Playwright(浏览器)
```

- **BrowserMind** 充当「翻译官 + 观察者 + 行动者」
- 将 Web 页面转化为 LLM 可理解的**结构化观测报告**
- 将 LLM 的意图转化为**精确的浏览器操作**
- 支持**多轮迭代**，层层深入探测

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      LLM (纯语言模型)                         │
│    接收: 结构化观测文本  |  输出: 自然语言意图/行动计划         │
└──────────────────┬──────────────────────┬──────────────────┘
                   │                      ▲
                   ▼                      │
┌─────────────────────────────────────────────────────────────┐
│                  BrowserMind Framework                       │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │  Planning    │  │ Observation │  │  Safety      │          │
│  │  Layer       │◄─┤  Layer      │◄─┤  Layer       │          │
│  │  (意图→动作)  │  │  (页面→文本) │  │  (安全过滤)   │          │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘          │
│         │                │                │                  │
│         ▼                ▼                ▼                  │
│  ┌────────────────────────────────────────────────────┐      │
│  │              Playwright Execution Layer             │      │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐         │      │
│  │  │ Script   │  │ DOM      │  │ Network  │         │      │
│  │  │ Injector │  │ Probe    │  │ Capture  │         │      │
│  │  └──────────┘  └──────────┘  └──────────┘         │      │
│  └────────────────────────────────────────────────────┘      │
│                                                              │
│  ┌────────────────────────────────────────────────────┐      │
│  │              Logging & Tracing Layer                │      │
│  │  每次交互完整记录: 意图→动作→页面状态→LLM反馈        │      │
│  └────────────────────────────────────────────────────┘      │
└──────────────────┬───────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│                    Target Web Page                           │
│         (被测应用，可以是任意 Web 应用)                        │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 分层职责

| 层级 | 职责 | 输入 | 输出 |
|------|------|------|------|
| **Planning Layer** | 解析 LLM 意图，编排动作序列 | LLM 自然语言指令 | 可执行的 Action[] |
| **Observation Layer** | 将页面状态压缩为 LLM 可用文本 | 页面实时状态 | 结构化 Observation |
| **Execution Layer** | 执行 Playwright 操作 + 脚本注入 | Action | 执行结果 + 状态快照 |
| **Safety Layer** | 过滤危险操作，保护被测环境 | 拦截所有出入数据 | 安全通过的指令/数据 |
| **Logging Layer** | 完整记录链路，支持回溯 | 全链路数据 | 结构化日志 + 回放能力 |

---

## 3. 核心流程

### 3.1 一次交互的完整生命周期

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Step 1: 目标输入                                                        │
│  LLM: "探测这个页面的登录功能，找出表单结构"                                │
├─────────────────────────────────────────────────────────────────────────┤
│  Step 2: Planning Layer 解析                                              │
│  ┌──────────────────────────────────────────────────────────┐            │
│  │  Plan:                                                    │            │
│  │  1. navigate(url) — 导航到页面                              │            │
│  │  2. probe('form') — 探测表单结构                           │            │
│  │  3. observe() — 获取观测报告                               │            │
│  │  4. extract('login flow') — 提取登录流程                   │            │
│  └──────────────────────────────────────────────────────────┘            │
├─────────────────────────────────────────────────────────────────────────┤
│  Step 3: Execution Layer 执行                                             │
│  ┌──────────────────────────────────────────────────────────┐            │
│  │  Playwright: page.goto(url)                              │            │
│  │  Injection: page.evaluate(probeScript)                   │            │
│  │  Capture: screenshot + DOM snapshot + network logs       │            │
│  └──────────────────────────────────────────────────────────┘            │
├─────────────────────────────────────────────────────────────────────────┤
│  Step 4: Observation Layer 结构化输出                                     │
│  ┌──────────────────────────────────────────────────────────┐            │
│  │  Observation {                                             │            │
│  │    url: 'https://example.com/login',                     │            │
│  │    title: '登录页面',                                     │            │
│  │    forms: [{ action: '/api/login', fields: ['user','pwd'] }],│         │
│  │    interactive: { buttons: 2, inputs: 3, links: 5 },     │            │
│  │    screenshot: 'base64...',                               │            │
│  │    consoleLogs: [...],                                    │            │
│  │    networkRequests: [...]                                 │            │
│  │  }                                                        │            │
│  └──────────────────────────────────────────────────────────┘            │
├─────────────────────────────────────────────────────────────────────────┤
│  Step 5: LLM 接收 Observation，生成下一步指令                              │
│  LLM: "输入用户名 'admin'，密码 '123456'，然后点击登录按钮"               │
├─────────────────────────────────────────────────────────────────────────┤
│  Step 6: 循环直到 LLM 认为探索完成或达到终止条件                            │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 多轮探测策略（主动探测 vs 被动观察）

```
第一轮(泛探测)        第二轮(深入)          第三轮(验证)
────────────         ────────              ────────
页面概览             表单字段             提交后状态
├── URL / Title      ├── input[name]      ├── loading态
├── 导航结构          ├── 按钮 + href       ├── 成功/失败提示
├── 可见表单          ├── label关联         ├── 页面跳转
├── 按钮 + 链接       ├── 校验规则          ├── Token存储
├── 媒体元素          └── placeholder      └── Cookie变化
└── iframe检测        
```

---

## 4. 脚本注入引擎

这是框架的核心能力——通过注入 JavaScript 脚本来**探测**页面内部状态。

### 4.1 脚本分类

#### A. 静态预置脚本（Pre-built Probes）

| 脚本名称 | 功能 | 输出示例 |
|---------|------|---------|
| `getPageStructure` | 页面骨架（语义标签 + 层级） | `{header, main, footer, nav[], sections[]}` |
| `getInteractiveElements` | 所有可交互元素 | `[{tag, role, text, rect, disabled}]` |
| `getFormStructure` | 表单完整结构 | `[{formId, action, fields[{name, type, required}]}]` |
| `getAccessibilityTree` | 无障碍树 | `{role, name, children[]}` |
| `getNetworkState` | 页面发起的请求/响应 | `[{url, method, status, timing}]` |
| `getStorageState` | localStorage/sessionStorage/cookies | `{cookies[], localStorage{}}` |
| `getComputedStyles` | 关键元素的计算样式 | `[{selector, display, visibility, zIndex}]` |
| `getAnimationState` | 当前动画/过渡状态 | `[{element, animationName, state}]` |

#### B. 动态生成脚本（Dynamic Probes）

LLM 可以"口述"探测需求，框架自动翻译为 JS 脚本：

```
LLM: "找出页面上所有红色边框的输入框"
→ 翻译为: document.querySelectorAll('input').filter(el => 
    getComputedStyle(el).borderColor === 'rgb(255, 0, 0)')
```

| 自然语言指令 | 生成的注入脚本 |
|------------|--------------|
| "找到所有 disabled 的按钮" | `button[disabled], input[disabled]` |
| "找出隐藏的 iframe" | `iframe[hidden], iframe[style*="display:none"]` |
| "检查 loading 状态" | `[aria-busy="true"], .loading, [class*="spinner"]` |
| "提取表格数据" | `table > tr > td 逐行提取` |
| "验证表单校验" | 触发 validation，收集 `validationMessage` |

#### C. 监控型脚本（Observability Probes）

**长期驻留页面，持续反馈状态变化：**

```typescript
// MutationObserver 监听 DOM 变化
const observer = new MutationObserver((mutations) => {
  // 压缩变化报告：只记录 新增/删除/属性变化 的节点摘要
  report.push({
    type: mutation.type,
    target: cssPath(mutation.target),
    added: mutation.addedNodes?.length || 0,
    removed: mutation.removedNodes?.length || 0,
    attribute: mutation.attributeName
  });
});
observer.observe(document.body, { 
  childList: true, subtree: true, attributes: true 
});
```

### 4.2 脚本注入的安全策略

```
┌──────────────────────────────────────────────────────┐
│  Script Injection Pipeline                           │
│                                                      │
│  LLM 请求 → 脚本模板匹配 → 参数填充 → 安全校验       │
│                                          │           │
│                                          ▼           │
│                                    Safety Layer      │
│                                    ├── 禁止: eval    │
│                                    ├── 禁止: innerHTML│
│                                    ├── 禁止: 修改原型│
│                                    ├── 限制: 循环次数│
│                                    ├── 限制: 数据量  │
│                                    └── 超时: 5s     │
│                                          │           │
│                                          ▼           │
│                                    page.evaluate()   │
└──────────────────────────────────────────────────────┘
```

---

## 5. 观察层（Observation Layer）

### 5.1 DOM 压缩策略

原始 DOM → 压缩为 LLM 友好的结构，**核心原则：保留语义，丢弃样式噪音**。

#### 压缩比示例

```
原始 HTML: ~150KB (5000 行)
↓
Accessibility Tree: ~5KB
↓
交互元素摘要: ~2KB
↓
LLM 输入: ~3-8KB
```

#### 压缩算法

```typescript
interface CompressedNode {
  tag: string;
  role: string;
  text?: string;            // 仅保留有意义文本
  attributes: {             // 仅保留关键属性
    href?: string;
    src?: string;
    alt?: string;
    'aria-label'?: string;
    'data-testid'?: string;
    type?: string;
    name?: string;
    disabled?: boolean;
    required?: boolean;
  };
  rect?: { x: number; y: number; w: number; h: number };
  children?: CompressedNode[];  // 递归，但限制深度 ≤ 5
  interactive: boolean;     // 是否可交互
  visible: boolean;         // 是否可见
}
```

### 5.2 观测报告格式

```typescript
interface Observation {
  // ===== 元信息 =====
  timestamp: string;
  url: string;
  viewport: { width: number; height: number };
  
  // ===== 页面概览 =====
  summary: {
    title: string;
    description?: string;
    language?: string;
    interactiveElements: number;  // 可交互元素总数
    forms: number;
    links: number;
    images: number;
    iframes: number;
  };
  
  // ===== 结构化内容 =====
  pageStructure: CompressedNode;  // 压缩后的 DOM 树
  
  // ===== 交互热点 =====
  hotSpots: HotSpot[];  // 根据视口和交互密度标记的热区
  
  // ===== 网络状态 =====
  network: {
    pending: number;
    completed: number;
    errors: string[];
    xhrRequests: string[];
  };
  
  // ===== 控制台 =====
  console: {
    errors: ConsoleEntry[];
    warnings: ConsoleEntry[];
    logs: ConsoleEntry[];
  };
  
  // ===== 视觉快照 =====
  screenshot?: string;  // Base64, 供多模态 LLM 使用
  
  // ===== 上轮动作的反馈 =====
  lastActionFeedback?: {
    action: string;
    success: boolean;
    error?: string;
    before?: Partial<Observation>;
    after?: Partial<Observation>;
    duration: number;
  };
}
```

---

## 6. 动作层（Action Layer）

### 6.1 LLM 可用的动作集

| 动作 | 参数 | 说明 |
|------|------|------|
| `navigate` | url | 页面导航 |
| `click` | selector / text / coordinates | 点击元素 |
| `type` | selector, text, [clearFirst] | 输入文本 |
| `select` | selector, value | 选择下拉 |
| `scroll` | direction / selector | 滚动 |
| `hover` | selector | 悬停（触发 tooltip） |
| `wait` | ms / condition | 等待 |
| `evaluate` | script | 执行任意 JS（受安全限制）|
| `snapshot` | — | 截取当前观测 |
| `extract` | pattern | 提取特定模式数据 |
| `assert` | condition | 断言页面状态 |

### 6.2 动作执行流程

```
LLM: "点击登录按钮"

1. Planning Layer 解析
   → Action: { type: 'click', target: { text: '登录', role: 'button' } }

2. Execution Layer 执行
   a. 根据 text/role 查找元素
   b. 滚动到视口（如需要）
   c. 等待元素稳定（不再移动）
   d. 执行 click
   e. 等待页面响应 (waitForLoadState / waitForNavigation)
   f. 捕获 Console + Network 变化

3. Observation Layer 生成反馈
   → 页面是否跳转？是否有错误？是否有 loading？
   → 新的页面状态快照

4. 反馈给 LLM
   → "点击后页面跳转到 /dashboard，无控制台错误，3 个 API 请求已完成"
```

### 6.3 动作编排（Planning Layer）

对于复杂指令，Planning Layer 会自动分解：

```
LLM: "测试登录流程，包括错误密码和正确密码"

Planning Layer 分解:
├── Phase 1: 探测表单
│   ├── navigate(login_url)
│   ├── probe('form')
│   └── observe()
├── Phase 2: 错误密码
│   ├── type(username, 'test')
│   ├── type(password, 'wrong')
│   ├── click(login_button)
│   ├── wait(2s)
│   └── observe(error_message)
├── Phase 3: 正确密码
│   ├── type(username, 'test')
│   ├── type(password, 'correct')
│   ├── click(login_button)
│   ├── waitForNavigation()
│   └── observe(dashboard)
└── Phase 4: 总结报告
    ├── extract('error message')
    └── assert('current url === /dashboard')
```

---

## 7. 安全层（Safety Layer）

### 7.1 风险矩阵

| 风险 | 场景 | 防御措施 |
|------|------|---------|
| **越权操作** | LLM 尝试删除数据、提权 | 动作白名单 + 方法黑名单 |
| **XSS 注入** | LLM 生成恶意 JS | 脚本沙箱 + 仅读模式默认 |
| **DDOS** | LLM 高频轮询 | 速率限制 + 最大并发控制 |
| **敏感信息泄露** | 提取用户数据、Token | 输出脱敏 + 字段过滤 |
| **无限循环** | LLM 陷入死循环 | 最大轮次限制 + 超时 |
| **跨域操作** | 导航到不可控域名 | 域白名单配置 |

### 7.2 安全策略配置

```typescript
interface SafetyConfig {
  // 操作限制
  maxStepsPerSession: 50;      // 每次探索最多 50 步
  maxConcurrentSessions: 5;    // 最多 5 个并发会话
  actionTimeoutMs: 10000;      // 每个动作超时 10s
  
  // 脚本安全
  readonlyMode: true;          // 默认只读探测
  allowedApis: string[];       // 允许的 DOM API 白名单
  blockedApis: string[];       // 禁止的 API（如 localStorage.clear）
  maxScriptReturnSize: 102400; // 脚本返回最大 100KB
  
  // 数据脱敏
  sensitivePatterns: RegExp[]; // 敏感数据正则（Token、密码等）
  maskFields: string[];        // 自动掩码字段名（password、secret）
  
  // 域限制
  allowedOrigins: string[];    // 允许导航的域名
  blockCrossOrigin: true;      // 阻止跨域跳转
}
```

---

## 8. 日志与可回溯性

### 8.1 全链路追踪

每条日志记录完整链路：

```typescript
interface InteractionLog {
  sessionId: string;
  stepNumber: number;
  timestamp: string;
  
  // 输入
  llmIntent: string;           // LLM 的原始指令
  parsedAction: Action;        // 解析后的动作
  
  // 执行
  injectedScript?: string;     // 注入的脚本（如有）
  executionResult: any;        // Playwright 执行结果
  
  // 观察
  observationBefore: Observation;  // 动作前快照
  observationAfter: Observation;   // 动作后快照
  
  // 性能
  duration: number;            // 动作耗时
  memoryUsage?: MemoryInfo;    // 页面内存
  
  // 异常
  error?: ErrorInfo;           // 异常信息
  retries?: number;            // 重试次数
}
```

### 8.2 回放能力

日志可以直接用于回放：

```bash
# 命令行回放某个 session
browser-mind replay --session abc-123

# 输出为 Playwright 测试脚本
browser-mind export --session abc-123 --format playwright
```

---

## 9. 推荐的架构部署模式

### 9.1 预估规模

| 场景 | 预估 QPS | 并发会话 | 推荐模式 |
|------|---------|---------|---------|
| 个人/小团队探索 | 0.1-1 | 1-3 | 单进程模式 |
| CI/CD 测试集成 | 1-10 | 5-20 | 常驻 Worker 池 |
| 大规模自动化探测 | 10-100 | 20-200 | 微服务 + 分布式 |

### 9.2 推荐架构模式

**针对常见的中等规模（CI/CD + 小团队），推荐：**

```
┌─────────────┐     ┌──────────────────────────────────────┐
│  CLI / API   │────▶│          BrowserMind Server          │
│  (触发入口)   │     │                                      │
└─────────────┘     │  ┌──────────┐  ┌──────────────────┐  │
                    │  │ Session  │  │  Worker Pool      │  │
                    │  │ Manager  │──│  (Playwright)     │  │
                    │  └──────────┘  │  ├─ Browser 1     │  │
                    │                │  ├─ Browser 2     │  │
                    │  ┌──────────┐  │  ├─ Browser 3     │  │
                    │  │ Probe    │  │  └──────────────────┘  │
                    │  │ Registry │  │                        │
                    │  └──────────┘  │  ┌──────────────────┐  │
                    │                │  │  LLM Connector   │  │
                    │  ┌──────────┐  │  │  (OpenAI/Claude/ │  │
                    │  │ Safety   │  │  │   本地模型)      │  │
                    │  │ Guard    │  │  └──────────────────┘  │
                    │  └──────────┘  │                        │
                    │                │  ┌──────────────────┐  │
                    │  ┌──────────┐  │  │  Log Store       │  │
                    │  │ Log     │  │  │  (SQLite/File)   │  │
                    │  │ Service │  │  └──────────────────┘  │
                    │  └──────────┘  │                        │
                    └──────────────────────────────────────┘
```

**大规模场景，建议微服务拆分：**

```
┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐
│API     │  │Session │  │Worker  │  │Probe   │  │Log     │
│Gateway │→│Service │→│Pool    │→│Engine  │→│Service │
└────────┘  └────────┘  └────────┘  └────────┘  └────────┘
                              │
                              ▼
                        ┌────────┐
                        │LLM     │
                        │Gateway │
                        └────────┘
```

拆分理由：
- **Worker Pool**：浏览器实例是资源消耗大户，需要独立扩容
- **Probe Engine**：脚本注入逻辑变更频繁，独立部署降低影响面
- **LLM Gateway**：不同模型切换、限流、计费，独立管理
- **Log Service**：大量结构化日志写入，避免影响核心链路

---

## 10. 用户交互路径与测试路径

### 10.1 主要用户交互路径

```
路径 A: 快速探测（主要路径）
┌─────────────────────────────────────────────────────────────┐
│ User 输入: "了解这个页面"                                     │
│                                                             │
│ 1. 框架自动导航到目标 URL                                    │
│ 2. 执行泛探测脚本 (pageStructure + interactive + forms)      │
│ 3. 生成简版 Observation Report                              │
│ 4. 询问 LLM 是否需要深入特定区域                              │
│ 5. LLM 指定区域 → 深入探测 → 更新报告                         │
│ 6. 返回最终总结给 User                                       │
└─────────────────────────────────────────────────────────────┘

路径 B: 定向测试（功能验证路径）
┌─────────────────────────────────────────────────────────────┐
│ User 输入: "测试这个页面的搜索功能"                            │
│                                                             │
│ 1. 框架探测搜索表单结构                                      │
│ 2. 将结构返回 LLM 进行分析                                   │
│ 3. LLM 制定测试计划 (空搜索/有效搜索/无结果搜索)               │
│ 4. 框架依次执行各测试用例                                    │
│ 5. 返回测试通过/失败 + 截图证据                              │
└─────────────────────────────────────────────────────────────┘

路径 C: 回归巡检（持续集成路径）
┌─────────────────────────────────────────────────────────────┐
│ User 输入: "对比当前页面与上次快照的差异"                      │
│                                                             │
│ 1. 加载上次快照                                             │
│ 2. 重新探测当前页面                                         │
│ 3. 逐个区域对比 (DOM结构/文案/链接/样式)                     │
│ 4. 标记差异区域                                             │
│ 5. 生成差异报告                                             │
└─────────────────────────────────────────────────────────────┘
```

### 10.2 推荐的测试路径

```typescript
// ============================================================
// 测试路径 1: 基础探测功能
// ============================================================
describe('BrowserMind - 基础探测', () => {
  test('泛探测应返回页面骨架结构');
  test('交互元素探测应覆盖所有可见可交互元素');
  test('表单探测应完整提取字段名、类型、校验规则');
  test('网络请求捕获应包含所有 XHR/Fetch');
  test('控制台错误应捕获所有 error/warning');
  test('DOM 压缩应 ≤ 原始大小的 10%');
});

// ============================================================
// 测试路径 2: 动作执行
// ============================================================
describe('BrowserMind - 动作执行', () => {
  test('click 应支持 text/selector/坐标三种定位');
  test('type 应支持清空后输入/追加输入');
  test('导航后应自动等待页面加载完成');
  test('hover 应触发 tooltip 类交互');
  test('scroll 应支持元素滚动和页面滚动');
});

// ============================================================
// 测试路径 3: 脚本注入安全
// ============================================================
describe('BrowserMind - 安全边界', () => {
  test('禁止的 API 调用应被拦截并告警');
  test('脚本超时 (5s) 应被强制终止');
  test('返回数据超过 100KB 应被截断');
  test('敏感字段 (password/token) 应被自动掩码');
  test('跨域导航应被域白名单控制');
  test('无限循环应被步数限制终止');
});

// ============================================================
// 测试路径 4: LLM 对话链路
// ============================================================
describe('BrowserMind - LLM 交互', () => {
  test('模糊指令应触发主动澄清');
  test('多轮对话应保持上下文连贯');
  test('动作失败应有重试/降级策略');
  test('异常页面应有合理诊断报告');
});

// ============================================================
// 测试路径 5: 性能与稳定性
// ============================================================
describe('BrowserMind - 性能', () => {
  test('单次探测应 ≤ 3s (不含 LLM 响应)');
  test('10 并发会话不应出现浏览器崩溃');
  test('连续 100 步操作不应内存泄漏');
  test('日志写入不应阻塞主流程');
});
```

---

## 11. 异常与安全边界

### 11.1 异常场景处理矩阵

| 异常场景 | 触发条件 | 处理策略 | LLM 感知 |
|---------|---------|---------|---------|
| **页面加载失败** | 404 / 500 / 超时 | 重试 2 次 → 返回错误代码 + 截图 | ✅ 告知 LLM，由其决定是否继续 |
| **元素不存在** | selector 匹配不到 | 返回 DOM 快照 + 可用元素列表 | ✅ LLM 重新指定目标 |
| **弹窗遮挡** | alert / confirm / modal | 自动处理或截图让 LLM 决策 | ✅ 显示弹窗内容 |
| **动态加载慢** | 超过 wait 时间 | 增加等待 → 最终截图当前状态 | ✅ LLM 判断是否是预期状态 |
| **JS 执行异常** | 脚本报错 | 捕获错误堆栈 → 返回语义化错误 | ✅ LLM 修改脚本 |
| **浏览器崩溃** | OOM / 进程退出 | 自动重启浏览器 → 恢复会话 | ✅ 告知崩溃并重试 |
| **LLM 格式错误** | LLM 返回非法 JSON | 重试 1 次 → 使用默认降级策略 | ⬜ 不告知，内部消化 |
| **网络离线** | 浏览器断网 | 等待恢复 → 超时后暂停 | ✅ 告知并等待指令 |

### 11.2 会话级防御机制

```typescript
// 熔断器模式
const circuitBreaker = {
  failureCount: 0,
  threshold: 5,           // 连续 5 次失败触发熔断
  state: 'CLOSED',        // CLOSED / OPEN / HALF_OPEN
  resetTimeout: 30000,    // 30s 后尝试恢复
  
  recordFailure() {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
      // 通知所有挂起的操作失败
    }
  },
  
  recordSuccess() {
    this.state = 'CLOSED';
    this.failureCount = 0;
  }
};

// 死锁检测
const deadlockDetector = {
  // 如果连续 10 步页面状态无变化，触发死锁处理
  maxStaleSteps: 10,
  actionFingerprints: new Map<string, string>(),
  
  checkForDeadlock(action: Action) {
    const fingerprint = this.hashState(action);
    const matches = this.actionFingerprints.get(fingerprint) || 0;
    if (matches >= this.maxStaleSteps) {
      return { deadlocked: true, suggestion: '尝试滚动或导航到其他页面' };
    }
    return { deadlocked: false };
  }
};
```

---

## 12. 技术选型与项目结构

### 12.1 技术栈

| 组件 | 技术选型 | 选型理由 |
|------|---------|---------|
| 核心框架 | **TypeScript** | 类型安全，团队友好 |
| 浏览器自动化 | **Playwright** | 跨浏览器，API 现代，支持脚本注入 |
| LLM 集成 | 插件式（OpenAI / Anthropic / Ollama） | 灵活切换模型 |
| 日志存储 | **Pino** (结构化日志) + **SQLite** (可选的持久化) | 高性能，零依赖 |
| 测试框架 | **Vitest** | 与 TS 原生集成，速度快 |
| 配置管理 | **Zod** | 运行时类型校验 |

### 12.2 项目目录结构（草案）

```
browser-mind/
├── src/
│   ├── core/                    # 核心逻辑
│   │   ├── planning/            # 意图解析与动作编排
│   │   ├── execution/           # Playwright 执行层
│   │   ├── observation/         # 页面观察与压缩
│   │   ├── probing/             # 脚本注入引擎
│   │   └── safety/              # 安全守卫
│   ├── llm/                     # LLM 适配器
│   │   ├── adapters/            # 不同模型的适配
│   │   └── schemas/             # LLM 输入输出格式
│   ├── logging/                 # 日志与追踪
│   └── types/                   # 类型定义
├── probes/                      # 预置探测脚本 (纯 JS)
│   ├── structure.js
│   ├── forms.js
│   ├── interactive.js
│   └── accessibility.js
├── examples/                    # 使用示例
└── tests/                       # 框架自测
```

---

## 总结

**BrowserMind** 的核心价值在于：

> **把「纯语言模型」扩展为「有视力的 QA 工程师」**

通过 Playwright 脚本注入，让 LLM 能够：
1. **看见** — 结构化观测压缩为 LLM 可理解的文本
2. **动手** — 执行点击、输入、滚动等浏览器操作
3. **思考** — 多轮迭代，层层深入理解页面
4. **记忆** — 完整日志链路支持回溯与回放

使 LLM 从"只能分析静态文本"升级为"能动态探索网页的自主测试代理"。

---

> **下一步**：确认设计方案后，开始搭建项目骨架，先实现 **Probe Engine + Observation Layer** 核心部分。
