// ============================================================
// BrowserMind 核心类型定义
//
// 本文件定义了框架所有模块的共享类型。类型按以下维度组织：
//
// 1. Config — 框架配置（日志级别、安全策略、模型选择等）
// 2. Action — LLM 意图解析后生成的可执行动作
// 3. Observation — 页面状态的结构化观测报告
// 4. Probe — 探测脚本的输入/输出
// 5. LLM — 与语言模型通信的协议格式
// 6. Session — 会话相关的运行时状态
// 7. Safety — 安全策略配置和审核结果
//
// 数据扭转示意:
//   LLM Intent → Action[] → Execution → Observation → LLM
// ============================================================

import { BrowserContextOptions, LaunchOptions } from 'playwright';

// ============================================================
// 1. 框架配置
// ============================================================

export interface BrowserMindConfig {
  /** 浏览器启动配置 */
  browser: {
    launch?: LaunchOptions;
    context?: BrowserContextOptions;
    /** 浏览器类型，默认 chromium */
    browserType?: 'chromium' | 'firefox' | 'webkit';
  };

  /** LLM 配置 */
  llm: {
    /** 模型提供商: openai | anthropic | ollama | custom */
    provider: string;
    /** API Key (通过环境变量传入更安全) */
    apiKey?: string;
    /** 模型名称 */
    model: string;
    /** API 端点（自定义模型时需指定） */
    baseUrl?: string;
    /** 温度参数 */
    temperature?: number;
    /** 最大 token 数 */
    maxTokens?: number;
  };

  /** 安全策略 */
  safety: SafetyConfig;

  /** 日志配置 */
  logging: {
    /** 日志级别: trace | debug | info | warn | error | fatal */
    level: string;
    /** 是否写入数据库 */
    persistToDb: boolean;
    /** 日志文件路径（可选） */
    filePath?: string;
    /** 是否同时输出到控制台 */
    prettyPrint: boolean;
  };

  /** 会话默认配置 */
  session: {
    /** 最大步数 */
    maxSteps: number;
    /** 会话超时 (ms) */
    timeoutMs: number;
    /** 单步超时 (ms) */
    stepTimeoutMs: number;
    /** 失败重试次数 */
    maxRetries: number;
  };

  /** 视口设置 */
  viewport: {
    width: number;
    height: number;
  };
}

// ============================================================
// 2. 动作类型
// ============================================================

/** LLM 意图经解析后生成的可执行动作 */
export type ActionType =
  | 'navigate'
  | 'click'
  | 'type'
  | 'select'
  | 'scroll'
  | 'hover'
  | 'wait'
  | 'evaluate'
  | 'probe'
  | 'snapshot'
  | 'extract'
  | 'assert';

export interface Action {
  /** 动作类型 */
  type: ActionType;
  /** 动作参数（各类型不同） */
  params: ActionParams;
  /** 动作描述（用于日志和 LLM 反馈） */
  description: string;
  /** 步骤序号 */
  stepNumber?: number;
}

export type ActionParams =
  | NavigateParams
  | ClickParams
  | TypeParams
  | SelectParams
  | ScrollParams
  | HoverParams
  | WaitParams
  | EvaluateParams
  | ProbeParams
  | SnapshotParams
  | ExtractParams
  | AssertParams;

export interface NavigateParams {
  url: string;
  /** 等待策略 */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

export interface ClickParams {
  /** 支持多种定位方式 */
  selector?: string;
  text?: string;
  role?: string;
  /** 坐标点击 */
  coordinates?: { x: number; y: number };
}

export interface TypeParams {
  selector?: string;
  text: string;
  /** 输入前是否清空 */
  clearFirst?: boolean;
  /** 模拟逐字输入延迟 (ms) */
  delay?: number;
}

export interface SelectParams {
  selector: string;
  value: string | string[];
}

export interface ScrollParams {
  /** 滚动方向或目标选择器 */
  direction?: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom';
  selector?: string;
  /** 像素量 */
  amount?: number;
}

export interface HoverParams {
  selector?: string;
  text?: string;
}

export interface WaitParams {
  /** 等待时间 (ms) 或条件 */
  ms?: number;
  condition?: 'navigation' | 'load' | 'networkidle' | 'domcontentloaded';
  /** 等待特定选择器出现 */
  selector?: string;
}

export interface EvaluateParams {
  /** 要执行的 JavaScript 代码 */
  script: string;
  /** 传递给脚本的参数 */
  args?: unknown[];
}

export interface ProbeParams {
  /** 探针名称 */
  probeName: string;
  /** 自定义参数（传递给探针脚本） */
  args?: Record<string, unknown>;
}

export interface SnapshotParams {
  /** 快照类型 */
  type?: 'full' | 'visual' | 'dom' | 'accessibility';
}

export interface ExtractParams {
  /** 提取模式/规则 */
  pattern: string;
  /** 提取方式 */
  method?: 'regex' | 'selector' | 'xpath' | 'text';
}

export interface AssertParams {
  /** 断言条件描述 */
  condition: string;
  /** 期望值 */
  expected?: unknown;
  /** 实际值获取方式 */
  actualFrom?: 'url' | 'title' | 'text' | 'count' | 'attribute';
  selector?: string;
}

// ============================================================
// 3. 观察层类型（Observation）
// ============================================================

/** 压缩后的 DOM 节点 */
export interface CompressedNode {
  tag: string;
  role: string;
  text?: string;
  attributes: {
    href?: string;
    src?: string;
    alt?: string;
    'aria-label'?: string;
    'data-testid'?: string;
    type?: string;
    name?: string;
    disabled?: boolean;
    required?: boolean;
    placeholder?: string;
    value?: string;
  };
  rect?: { x: number; y: number; w: number; h: number };
  children?: CompressedNode[];
  interactive: boolean;
  visible: boolean;
}

/** 交互热点区域 */
export interface HotSpot {
  /** 热区坐标 */
  rect: { x: number; y: number; w: number; h: number };
  /** 包含的交互元素数量 */
  elementCount: number;
  /** 热区描述 */
  description: string;
}

/** 控制台日志条目 */
export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  timestamp: number;
}

/** 网络请求记录 */
export interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  type: string;
  duration: number;
  size: number;
}

/** 页面摘要信息 */
export interface PageSummary {
  title: string;
  description?: string;
  language?: string;
  interactiveElements: number;
  forms: number;
  links: number;
  images: number;
  iframes: number;
  scripts: number;
  stylesheets: number;
  totalElements: number;
}

/** 完整的观测报告 */
export interface Observation {
  timestamp: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };

  summary: PageSummary;
  pageStructure: CompressedNode;
  hotSpots: HotSpot[];

  network: {
    pending: NetworkEntry[];
    completed: NetworkEntry[];
    errors: NetworkEntry[];
    totalRequests: number;
  };

  console: {
    errors: ConsoleEntry[];
    warnings: ConsoleEntry[];
    logs: ConsoleEntry[];
  };

  screenshot?: string;
  pageSourceHash?: string;

  lastActionFeedback?: {
    action: string;
    success: boolean;
    error?: string;
    duration: number;
    pageChanged: boolean;
  };
}

// ============================================================
// 4. 探针类型
// ============================================================

/** 探针定义 */
export interface Probe {
  /** 探针名称（唯一标识） */
  name: string;
  /** 探针描述 */
  description: string;
  /** 探针脚本（纯 JavaScript 函数体或完整脚本） */
  script: string;
  /** 预期输出类型 */
  outputType: 'json' | 'text' | 'number' | 'boolean';
  /** 超时 (ms) */
  timeout?: number;
  /** 是否只读（默认为 true） */
  readonly?: boolean;
}

/** 探针执行请求 */
export interface ProbeRequest {
  probeName: string;
  args?: Record<string, unknown>;
  /** 是否强制重新探测（跳过缓存） */
  force?: boolean;
}

/** 探针执行结果 */
export interface ProbeResult {
  probeName: string;
  rawResult: unknown;
  size: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

// ============================================================
// 5. LLM 通信类型
// ============================================================

/** 发送给 LLM 的消息 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** LLM 的响应 */
export interface LLMResponse {
  /** 原始文本内容 */
  content: string;
  /** 解析后的操作（如果有） */
  actions?: Action[];
  /** 使用的 tokens */
  usage?: {
    prompt: number;
    completion: number;
    total: number;
  };
  /** 模型信息 */
  model?: string;
}

/** LLM 提供商的通用接口 */
export interface LLMProvider {
  /** 发送消息并获取响应 */
  chat(messages: LLMMessage[], options?: Record<string, unknown>): Promise<LLMResponse>;
  /** 获取模型信息 */
  getModelInfo(): { name: string; provider: string };
}

// ============================================================
// 6. 会话类型
// ============================================================

/** 会话状态 */
export type SessionStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/** 会话运行时上下文 */
export interface SessionContext {
  sessionId: string;
  status: SessionStatus;
  config: BrowserMindConfig;
  stepNumber: number;
  startTime: number;
  lastActivity: number;
  actionHistory: Action[];
  observationHistory: Observation[];
  /** 自定义上下文数据（LLM 可读写） */
  metadata: Record<string, unknown>;
}

// ============================================================
// 7. 安全策略类型
// ============================================================

export interface SafetyConfig {
  /** 最大步数 */
  maxStepsPerSession: number;
  /** 最大并发会话 */
  maxConcurrentSessions: number;
  /** 动作超时 (ms) */
  actionTimeoutMs: number;
  /** 只读模式（禁止修改操作） */
  readonlyMode: boolean;
  /** 允许的 DOM API 白名单 */
  allowedApis: string[];
  /** 禁止的 API */
  blockedApis: string[];
  /** 脚本返回最大字节 */
  maxScriptReturnSize: number;
  /** 敏感数据脱敏正则 */
  sensitivePatterns: string[];
  /** 脱敏字段名 */
  maskFields: string[];
  /** 允许导航的域名白名单 */
  allowedOrigins: string[];
  /** 阻止跨域导航 */
  blockCrossOrigin: boolean;
  /** 脚本超时 (ms) */
  scriptTimeoutMs: number;
  /** 最大字符串长度 */
  maxStringLength: number;
}

// ============================================================
// 8. 框架核心接口
// ============================================================

/** 动作执行结果 */
export interface ActionResult {
  action: Action;
  success: boolean;
  error?: string;
  durationMs: number;
  /** 执行后的观测快照 */
  observation?: Observation;
  /** 探针结果（如果动作是 probe） */
  probeResults?: ProbeResult[];
  /** 脚本输出（如果动作是 evaluate） */
  evaluateResult?: unknown;
}
