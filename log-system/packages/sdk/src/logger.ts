/**
 * Logger 核心类 - 面向业务的前端日志 SDK
 * 
 * 使用方式（极简集成）：
 * ```typescript
 * import { Logger } from '@log-system/sdk';
 * 
 * // 初始化 (建议在应用入口处调用)
 * Logger.init({
 *   endpoint: '/api/logs',
 *   appName: 'my-app',
 *   environment: 'production',
 * });
 * 
 * // 业务埋点 - 一行代码
 * Logger.track('pay_success', { amount: 99.9 });
 * 
 * // 自定义异常
 * Logger.error('请求失败', { status: 500 });
 * ```
 * 
 * 内部架构：
 *   Logger (静态外观)
 *     ├── LoggerInstance (单例实现)
 *     │     ├── LocalQueue (IndexedDB 队列，断网时缓存)
 *     │     ├── Reporter (HTTP 上报，含重试逻辑)
 *     │     ├── Scheduler (定时批量上报，每 2s 检查一次)
 *     │     └── PassiveCapture (自动捕获异常/请求/路由)
 *     └── 静态 API (track / error / info / setUserId)
 * 
 * 关键设计决策：
 * - 单例模式：全局只维护一个 LoggerInstance，避免重复初始化
 * - 批量上报：队列攒批 2s 或满 20 条后上报，减少 HTTP 请求
 * - 异步非阻塞：所有操作（队列写入、上报）都是异步的，不阻塞业务
 * - 静默失败：任何内部错误都不抛出到业务层，仅 console.warn 提示
 */

import type { LogEntry, LoggerConfig, LogLevel, LogCategory } from '@myby/log-shared';
import { DEFAULT_LOGGER_CONFIG } from '@myby/log-shared';
import { getOrCreateTraceId, generateSpanId } from './id';
import { sanitizeData } from './sanitizer';
import { LocalQueue } from './queue';
import { Reporter } from './reporter';
import { setupPassiveCapture } from './capture';

export interface LoggerInstance {
  config: LoggerConfig;
  _capture(partial: Partial<LogEntry> & { message: string; level: LogLevel; category: LogCategory }): void;
}

class LoggerImpl implements LoggerInstance {
  public config: LoggerConfig;
  private queue: LocalQueue;
  private reporter: Reporter;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupPassive: (() => void) | null = null;
  private userId: string | undefined;
  private userAgent: string;
  private _initialized = false;
  /** 上一步的 span_id，用于自动填充被动捕获的 parent_span_id */
  private lastSpanId: string | null = null;
  /** 按需刷新的定时器（有日志时才存在，空队列时 null） */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.config = { ...DEFAULT_LOGGER_CONFIG };
    this.queue = new LocalQueue(this.config.maxQueueSize);
    this.reporter = new Reporter({
      endpoint: this.config.endpoint,
      retryInterval: this.config.retryInterval!,
      maxRetries: this.config.maxRetries!,
      appToken: this.config.appToken,
    });
    this.userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';

    // 页面关闭前尝试上报剩余日志
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this._flushImmediate();
      });
    }
  }

  /** 初始化配置 + 启动被动捕获 + 启动调度器 */
  init(config: Partial<LoggerConfig>): void {
    if (this._initialized) {
      console.warn('[LogSystem] Already initialized, destroying previous instance first...');
      this.destroy();
    }

    this.config = { ...DEFAULT_LOGGER_CONFIG, ...config };
    this.queue = new LocalQueue(this.config.maxQueueSize);
    this.reporter = new Reporter({
      endpoint: this.config.endpoint,
      retryInterval: this.config.retryInterval!,
      maxRetries: this.config.maxRetries!,
      appToken: this.config.appToken,
    });

    // 启动被动捕获
    this.cleanupPassive = setupPassiveCapture(this.config, this);

    // 调度器改为按需触发：有日志入队时才启动定时器
    // 空队列时无任何定时器运行，零开销
    this._initialized = true;

    console.log(`[LogSystem] Initialized: app=${this.config.appName} env=${this.config.environment}`);
  }

  /** 设置用户 ID，后续日志自动携带 */
  setUserId(userId: string): void {
    this.userId = userId;
  }

  /** 核心日志采集方法 - SDK 内部和被动捕获共用 */
  _capture(partial: Partial<LogEntry> & { message: string; level: LogLevel; category: LogCategory }): void {
    // 采样率判断
    if (this.config.sampleRate! < 1 && Math.random() > this.config.sampleRate!) {
      return; // 被采样丢弃
    }

    const traceId = getOrCreateTraceId();
    const spanId = generateSpanId();

    const entry: LogEntry = {
      trace_id: partial.trace_id || traceId,
      span_id: partial.span_id || spanId,
      // 未指定 parent_span_id（undefined）时，自动沿用上一步的 span_id（lastSpan 追踪）
      // 显式传入 null 表示强制作为根节点，不会被 lastSpan 覆盖
      parent_span_id: partial.parent_span_id !== undefined ? partial.parent_span_id : this.lastSpanId,
      level: partial.level,
      category: partial.category,
      event_key: partial.event_key,
      message: partial.message,
      data: this.config.sanitize !== false && partial.data
        ? sanitizeData(partial.data)
        : (partial.data || {}),
      source: 'frontend',
      app_name: partial.app_name || this.config.appName,
      user_id: partial.user_id || this.userId,
      url: partial.url || (typeof window !== 'undefined' ? window.location.href : undefined),
      user_agent: this.userAgent,
      timestamp: partial.timestamp || Date.now(),
    };

    // 记录当前 span_id 作为下一步的 parent_span_id（lastSpan 追踪）
    this.lastSpanId = entry.span_id;

    // 写入本地队列（异步）
    const queueItem = {
      id: entry.trace_id + '-' + entry.span_id,
      traceId: entry.trace_id,
      data: entry,
      retryCount: 0,
      createdAt: Date.now(),
    };

    this.queue.push(queueItem).then(() => {
      this._scheduleFlush();
    }).catch((err) => {
      console.warn('[LogSystem] Queue push failed:', err);
    });
  }

  /** 主动上报 - 埋点事件 */
  track(eventKey: string, data?: Record<string, unknown>): void {
    this._capture({
      level: 'info',
      category: 'event',
      event_key: eventKey,
      message: `Event: ${eventKey}`,
      data,
    });
  }

  /** 主动上报 - 错误 */
  error(message: string, data?: Record<string, unknown>): void {
    this._capture({
      level: 'error',
      category: 'exception',
      message,
      data,
    });
  }

  /** 主动上报 - 信息 */
  info(message: string, data?: Record<string, unknown>): void {
    this._capture({
      level: 'info',
      category: 'event',
      message,
      data,
    });
  }

  /** 按需调度刷新：有日志入队后延迟 2s 执行，多次入队会重置计时（防抖） */
  private _scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this._flushBatch();
    }, 2000);
  }

  /** 批量刷新 - 从队列取数据上报，成功后递归调度直到队列清空 */
  private async _flushBatch(): Promise<void> {
    try {
      const count = await this.queue.count();
      if (count === 0) return;

      // 每次最多取 20 条
      const batchSize = Math.min(count, 20);
      const items = await this.queue.popBatch(batchSize);

      if (items.length === 0) return;

      const logs = items.map((i) => i.data);

      // 采样 traceID 去重：同一个 traceID 的多条日志合并上报
      const { acceptedIds } = await this.reporter.send(logs);

      // 上报成功，从队列中删除
      if (acceptedIds.length > 0) {
        await this.queue.remove(acceptedIds);
      }

      // 处理失败的日志 - 增加重试计数
      const failedItems = items.filter((i) => !acceptedIds.includes(i.id));
      for (const item of failedItems) {
        if (item.retryCount >= this.reporter.getMaxRetries()) {
          // 超过最大重试次数，丢弃
          await this.queue.remove([item.id]);
          console.warn('[LogSystem] Drop log after max retries:', item.id);
        } else {
          // 更新重试次数
          await this.queue.updateRetry(item.id, item.retryCount + 1);
        }
      }

      // 如果队列中还有剩余数据，继续调度下一批
      const remaining = await this.queue.count();
      if (remaining > 0) {
        this._scheduleFlush();
      }
    } catch (err) {
      // 静默失败，下次调度继续
      console.warn('[LogSystem] Flush error:', err);
      // 发生错误时也重试，避免丢日志
      this._scheduleFlush();
    }
  }

  /** 立即刷新所有日志 - 页面关闭前调用 */
  private async _flushImmediate(): Promise<void> {
    try {
      const items = await this.queue.popBatch(500);
      if (items.length === 0) return;
      const logs = items.map((i) => i.data);

      // 页面关闭时使用 sendBeacon 更可靠
      // 注意：必须用 Blob 设置 Content-Type: application/json
      // 否则 sendBeacon 默认以 text/plain 发送，服务端 express.json() 无法解析
      const payload = JSON.stringify({ logs });
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(this.config.endpoint, blob);
    } catch {
      // 页面关闭，静默处理
    }
  }

  /** 销毁 - 清理定时器和被动捕获 */
  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.cleanupPassive) {
      this.cleanupPassive();
      this.cleanupPassive = null;
    }
    this._initialized = false;
    this.lastSpanId = null;
  }
}

// ==================== 全局单例 ====================

const globalInstance = new LoggerImpl();

/**
 * 日志器 - 全局静态 API
 * 
 * 使用示例：
 * ```typescript
 * import { Logger } from '@log-system/sdk';
 * 
 * // 初始化（必须）
 * Logger.init({ appName: 'my-app', environment: 'production' });
 * 
 * // 业务埋点
 * Logger.track('signup_complete', { method: 'email' });
 * ```
 */
export const Logger = {
  init(config: Partial<LoggerConfig>): void {
    globalInstance.init(config);
  },

  track(eventKey: string, data?: Record<string, unknown>): void {
    globalInstance.track(eventKey, data);
  },

  error(message: string, data?: Record<string, unknown>): void {
    globalInstance.error(message, data);
  },

  info(message: string, data?: Record<string, unknown>): void {
    globalInstance.info(message, data);
  },

  setUserId(userId: string): void {
    globalInstance.setUserId(userId);
  },

  /** 获取内部实例，用于被动捕获引擎 */
  _getInstance(): LoggerInstance {
    return globalInstance;
  },
};
