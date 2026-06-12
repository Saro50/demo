/**
 * @myby/log-shared
 * 
 * 本包定义日志系统的核心数据模型与类型契约。
 * 所有模块（SDK / Server / UI）基于此包的类型对齐数据格式。
 * 
 * 数据流向：
 *   SDK 采集 → 序列化为 LogEntry[] → HTTP POST → Server 反序列化校验
 *   → SQLite 持久化 → UI 查询反序列化为 LogEntryView 渲染
 * 
 * 链路追溯：
 *   traceID 贯穿始终，spanID/parentSpanID 构建树形结构
 */

// ==================== 日志级别 ====================

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// ==================== 日志分类 ====================

export const LOG_CATEGORIES = [
  'event',       // 业务埋点事件
  'exception',   // 异常捕获
  'request',     // 网络请求
  'page',        // 页面/路由
  'performance', // 性能指标
] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

// ==================== 日志来源 ====================

export const LOG_SOURCES = ['frontend', 'backend'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

// ==================== 核心日志条目 ====================

/**
 * 日志条目核心结构 - 前端SDK采集、后端接收、SQLite存储均使用此结构
 * 
 * 字段设计原则：
 * - trace_id / span_id / parent_span_id 构成链路追踪的基础
 * - level + category 组合用于快速筛选
 * - event_key 为业务埋点事件名，category='event' 时必填
 * - data 为灵活扩展字段，存储任意 JSON 结构
 */
export interface LogEntry {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  level: LogLevel;
  category: LogCategory;
  event_key?: string;
  message: string;
  data?: Record<string, unknown>;
  source: LogSource;
  app_name?: string;
  app_id?: number;
  user_id?: string;
  url?: string;
  user_agent?: string;
  ip?: string;
  timestamp: number; // 毫秒时间戳
}

// ==================== 日志上报 ====================

/**
 * 前端上报请求体 - 批量上报设计
 * 
 * 为什么设计为批量数组？
 * 1. 减少HTTP请求次数，合并多条日志在一次请求中发送
 * 2. 本地队列攒批发送，提高吞吐
 * 3. 后端批量写入SQLite，降低写入压力
 */
export interface LogBatchPayload {
  logs: LogEntry[];
}

/**
 * 上报响应
 */
export interface LogBatchResponse {
  accepted: number;
  errors: Array<{ index: number; reason: string }>;
}

// ==================== 日志查询 ====================

/**
 * 日志查询参数 - UI筛选栏与API查询参数对齐
 */
export interface LogQueryParams {
  level?: LogLevel | LogLevel[];
  category?: LogCategory | LogCategory[];
  event_key?: string;
  trace_id?: string;
  app_name?: string;
  user_id?: string;
  keyword?: string;
  start_time?: number;
  end_time?: number;
  page?: number;
  page_size?: number;
  sort?: 'asc' | 'desc';
}

/**
 * 日志查询响应 - 含分页信息
 */
export interface LogQueryResponse {
  total: number;
  page: number;
  page_size: number;
  items: LogEntry[];
}

// ==================== 链路追踪 ====================

/**
 * 链路汇总 - 用于链路追踪面板展示
 * 
 * spans 按 parent_span_id 构建树形结构
 * UI 端根据 parent_span_id 递归渲染缩进树
 */
export interface TraceDetail {
  trace_id: string;
  root_span_id: string;
  service_name: string;
  start_time: number;
  end_time: number | null;
  span_count: number;
  has_error: boolean;
  summary: string;
  spans: LogEntry[];
}

// ==================== 统计 ====================

export interface StatsResponse {
  total_logs: number;
  error_count: number;
  warn_count: number;
  events: Record<string, number>;
  top_errors: Array<{ message: string; count: number }>;
  time_series: Array<{ time: string; count: number }>;
}

// ==================== SDK 配置 ====================

export interface LoggerConfig {
  endpoint: string;
  appName: string;
  environment: string;
  autoCapture?: {
    error?: boolean;
    promise?: boolean;
    request?: boolean;
    route?: boolean;
    performance?: boolean;
    click?: boolean;
  };
  sampleRate?: number;
  maxQueueSize?: number;
  retryInterval?: number;
  maxRetries?: number;
  /** 脱敏开关，默认 true */
  sanitize?: boolean;
  /** 应用 token，用于服务端认证（需在后台手动创建应用获取） */
  appToken?: string;
}

export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  endpoint: '/api/logs',
  appName: 'unknown',
  environment: 'development',
  autoCapture: {
    error: true,
    promise: true,
    request: true,
    route: true,
    performance: false,
    click: false,
  },
  sampleRate: 1,
  maxQueueSize: 5000,
  retryInterval: 1000,
  maxRetries: 5,
  sanitize: true,
};
