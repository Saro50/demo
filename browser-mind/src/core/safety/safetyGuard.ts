// ============================================================
// BrowserMind 安全守卫（Safety Guard）
//
// 职责：
// 安全层是框架的"守门人"，所有进出数据都要经过它审核。
// 它保护两方面：1) 被测页面不被破坏 2) LLM 不接收敏感信息
//
// 核心能力：
// 1. 脚本审核 — 禁止危险 API（eval、innerHTML 等）
// 2. 动作审核 — 只读模式下禁止修改操作
// 3. 数据脱敏 — 自动掩码密码、Token、密钥等敏感字段
// 4. 域白名单 — 控制可导航的域名范围
// 5. 熔断器 — 连续失败自动熔断
// 6. 死锁检测 — 页面状态无变化时告警
//
// 异常影响：
// - 任何安全违规都会阻断当前操作并记录详细告警
// - 严重违规（如跨域脚本注入）会终止整个会话
// ============================================================

import type { SafetyConfig, Action, SessionContext } from '../../types/index.js';
import type pino from 'pino';

/** 安全审核结果 */
export interface SafetyVerdict {
  /** 是否通过安全审核 */
  passed: boolean;
  /** 违规级别: info | warn | error | critical */
  level: 'info' | 'warn' | 'error' | 'critical';
  /** 违规描述 */
  message: string;
  /** 违规详情 */
  details?: string;
  /** 建议的处理方式: allow | block | terminate */
  action: 'allow' | 'block' | 'terminate';
}

/** 熔断器状态 */
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  threshold: number;
  resetTimeoutMs: number;
}

/** 死锁检测状态 */
interface DeadlockState {
  /** 最近 N 步的页面特征快照 */
  snapshots: Array<{
    summary: string;
    /** URL 是否变化 */
    urlChanged: boolean;
    /** 是否有交互热点变化 */
    hotSpotChanged: boolean;
  }>;
  maxStaleSteps: number;
}

export class SafetyGuard {
  private config: SafetyConfig;
  private logger: pino.Logger;
  private circuitBreaker: CircuitBreakerState;
  private deadlockDetector: DeadlockState;

  constructor(config: SafetyConfig, logger: pino.Logger) {
    this.config = config;
    this.logger = logger.child({ module: 'safety-guard' });
    this.circuitBreaker = {
      state: 'CLOSED',
      failureCount: 0,
      lastFailureTime: 0,
      threshold: 5,
      resetTimeoutMs: 30000,
    };
    this.deadlockDetector = {
      snapshots: [],
      maxStaleSteps: 10,
    };
  }

  // ============================================================
  // 1. 动作审核
  // ============================================================

  /**
   * 审核单个动作是否允许执行
   *
   * @param action - 待审核的动作
   * @param context - 当前会话上下文
   * @returns 审核结果
   */
  auditAction(action: Action, context: SessionContext): SafetyVerdict {
    // 检查熔断器
    if (this.circuitBreaker.state === 'OPEN') {
      const elapsed = Date.now() - this.circuitBreaker.lastFailureTime;
      if (elapsed < this.circuitBreaker.resetTimeoutMs) {
        return {
          passed: false,
          level: 'error',
          message: 'Circuit breaker is OPEN. Too many consecutive failures.',
          details: `Retry after ${this.circuitBreaker.resetTimeoutMs - elapsed}ms`,
          action: 'block',
        };
      }
      // 进入半开状态
      this.circuitBreaker.state = 'HALF_OPEN';
    }

    // 检查只读模式
    if (this.config.readonlyMode) {
      const writeActions: string[] = ['type', 'click', 'select', 'evaluate'];
      if (writeActions.includes(action.type)) {
        return {
          passed: false,
          level: 'warn',
          message: `Action "${action.type}" blocked by readonly mode`,
          details: `Readonly mode is enabled. Only read actions are allowed.`,
          action: 'block',
        };
      }
    }

    // 检查步数限制
    if (context.stepNumber >= this.config.maxStepsPerSession) {
      return {
        passed: false,
        level: 'warn',
        message: `Session reached max steps (${this.config.maxStepsPerSession})`,
        action: 'terminate',
      };
    }

    // 检查导航目的地
    if (action.type === 'navigate') {
      const urlVerdict = this.auditUrl((action.params as any).url);
      if (!urlVerdict.passed) return urlVerdict;
    }

    return {
      passed: true,
      level: 'info',
      message: 'Action passed safety audit',
      action: 'allow',
    };
  }

  // ============================================================
  // 2. URL 审核
  // ============================================================

  /**
   * 审核目标 URL 是否允许访问
   */
  private auditUrl(url: string): SafetyVerdict {
    try {
      const parsed = new URL(url);
      const origin = parsed.origin;

      // 检查白名单
      if (this.config.allowedOrigins.length > 0) {
        const allowed = this.config.allowedOrigins.some((allowedOrigin) => {
          return origin.startsWith(allowedOrigin);
        });
        if (!allowed) {
          return {
            passed: false,
            level: 'error',
            message: `URL origin "${origin}" not in allowed origins`,
            details: `Allowed: ${this.config.allowedOrigins.join(', ')}`,
            action: 'block',
          };
        }
      }

      // 检查协议安全
      if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) {
        return {
          passed: false,
          level: 'error',
          message: `URL protocol "${parsed.protocol}" is not allowed`,
          action: 'block',
        };
      }
    } catch {
      return {
        passed: false,
        level: 'error',
        message: `Invalid URL: "${url}"`,
        action: 'block',
      };
    }

    return { passed: true, level: 'info', message: 'URL allowed', action: 'allow' };
  }

  // ============================================================
  // 3. 脚本审核
  // ============================================================

  /**
   * 审核 JavaScript 脚本是否安全
   *
   * 检查项：
   * - 是否包含禁止的 API 调用
   * - 脚本长度是否超限
   * - 是否包含无限循环风险
   */
  auditScript(script: string): SafetyVerdict {
    // 检查脚本长度
    if (script.length > this.config.maxScriptReturnSize) {
      return {
        passed: false,
        level: 'warn',
        message: `Script exceeded max length (${script.length} > ${this.config.maxScriptReturnSize})`,
        action: 'block',
      };
    }

    // 检查禁止的 API
    const blockedPatterns = this.config.blockedApis.map((api) => {
      // 支持模糊匹配和精确匹配
      const escaped = api.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'gi');
    });

    for (const pattern of blockedPatterns) {
      const match = script.match(pattern);
      if (match) {
        return {
          passed: false,
          level: 'error',
          message: `Script contains blocked API: "${match[0]}"`,
          details: `Blocked APIs: ${this.config.blockedApis.join(', ')}`,
          action: 'block',
        };
      }
    }

    // 检查常见的危险模式
    const dangerousPatterns = [
      { pattern: /innerHTML\s*=/, message: 'innerHTML assignment' },
      { pattern: /document\.write/, message: 'document.write' },
      { pattern: /new\s+Function\s*\(/, message: 'new Function()' },
      { pattern: /setTimeout\s*\(\s*["']/, message: 'eval-like setTimeout' },
    ];

    for (const { pattern, message } of dangerousPatterns) {
      if (pattern.test(script)) {
        return {
          passed: false,
          level: 'error',
          message: `Script contains dangerous pattern: ${message}`,
          action: 'block',
        };
      }
    }

    // 检查死循环风险
    const loopCount = (script.match(/\b(for|while)\s*\(/g) || []).length;
    if (loopCount > 3) {
      return {
        passed: false,
        level: 'warn',
        message: `Script has ${loopCount} loops, possible infinite loop risk`,
        action: 'block',
      };
    }

    return { passed: true, level: 'info', message: 'Script allowed', action: 'allow' };
  }

  // ============================================================
  // 4. 数据脱敏
  // ============================================================

  /**
   * 对输出数据做脱敏处理
   *
   * 匹配敏感字段名并替换为 [REDACTED]
   */
  sanitizeOutput(data: unknown): unknown {
    if (typeof data === 'string') {
      return this.sanitizeString(data);
    }
    if (Array.isArray(data)) {
      return data.map((item) => this.sanitizeOutput(item));
    }
    if (data && typeof data === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        const isSensitive = this.config.maskFields.some(
          (field) => key.toLowerCase().includes(field.toLowerCase())
        );
        sanitized[key] = isSensitive ? '[REDACTED]' : this.sanitizeOutput(value);
      }
      return sanitized;
    }
    return data;
  }

  /**
   * 对字符串做正则脱敏
   */
  private sanitizeString(text: string): string {
    let sanitized = text;
    for (const pattern of this.config.sensitivePatterns) {
      try {
        const regex = new RegExp(pattern, 'gi');
        sanitized = sanitized.replace(regex, '[REDACTED]');
      } catch {
        // 忽略无效正则
      }
    }
    return sanitized;
  }

  // ============================================================
  // 5. 熔断器
  // ============================================================

  /**
   * 记录动作失败（供熔断器使用）
   */
  recordFailure(): void {
    this.circuitBreaker.failureCount++;
    this.circuitBreaker.lastFailureTime = Date.now();

    if (this.circuitBreaker.failureCount >= this.circuitBreaker.threshold) {
      this.circuitBreaker.state = 'OPEN';
      this.logger.warn(
        { failureCount: this.circuitBreaker.failureCount },
        'Circuit breaker OPENED due to consecutive failures'
      );
    }
  }

  /**
   * 记录动作成功（重置熔断器）
   */
  recordSuccess(): void {
    this.circuitBreaker.failureCount = 0;
    if (this.circuitBreaker.state === 'HALF_OPEN') {
      this.circuitBreaker.state = 'CLOSED';
      this.logger.info('Circuit breaker CLOSED after successful action');
    }
  }

  // ============================================================
  // 6. 死锁检测
  // ============================================================

  /**
   * 检测是否陷入页面状态死锁
   *
   * 如果连续 N 步页面状态摘要没有变化，认为进入死锁。
   */
  /**
   * 检测是否陷入页面状态死锁
   *
   * 使用多维特征检测：
   * 1. 摘要一致性 — 交互元素数/表单数/热区数是否连续不变
   * 2. URL 是否固化 — 页面地址是否连续多步不变
   * 3. 热区是否固化 — 交互热区数量和位置是否不变
   *
   * @param summary - 格式: "交互元素数|表单数|热区数" (兼容旧格式)
   * @param url - 可选的当前页面 URL（用于检测 URL 固化）
   * @param hotSpotCount - 可选的当前热区数量（用于检测交互固化）
   */
  checkDeadlock(
    summary: string,
    url?: string,
    hotSpotCount?: number
  ): { deadlocked: boolean; suggestion?: string } {
    // 构建特征快照
    const snapshot = {
      summary,
      urlChanged: url ? !this._lastUrl || url !== this._lastUrl : true,
      hotSpotChanged: hotSpotCount !== undefined ? this._lastHotSpotCount === undefined || hotSpotCount !== this._lastHotSpotCount : true,
    };

    if (url) this._lastUrl = url;
    if (hotSpotCount !== undefined) this._lastHotSpotCount = hotSpotCount;

    this.deadlockDetector.snapshots.push(snapshot);
    if (this.deadlockDetector.snapshots.length > this.deadlockDetector.maxStaleSteps) {
      this.deadlockDetector.snapshots.shift();
    }

    // 检查最近 5 步：特征一致 + URL 未变化 + 热区未变化 → 判定死锁
    const recent = this.deadlockDetector.snapshots.slice(-5);
    if (recent.length >= 5) {
      const summaryConsistent = recent.every((s) => s.summary === recent[0].summary);
      const urlStale = recent.every((s) => !s.urlChanged);
      const hotSpotStale = recent.every((s) => !s.hotSpotChanged);

      if (summaryConsistent && (urlStale || hotSpotStale)) {
        return {
          deadlocked: true,
          suggestion: '页面状态连续 5 步无实质变化。建议尝试：1) 滚动页面 2) 点击链接导航 3) 结束会话',
        };
      }
    }

    return { deadlocked: false };
  }

  /** 记录上一个 URL（用于死锁检测） */
  private _lastUrl?: string;
  /** 记录上一个热区数量（用于死锁检测） */
  private _lastHotSpotCount?: number;

  // ============================================================
  // 7. 配置更新
  // ============================================================

  /**
   * 动态更新安全配置
   */
  updateConfig(partial: Partial<SafetyConfig>): void {
    this.config = { ...this.config, ...partial };
    this.logger.info({ updatedFields: Object.keys(partial) }, 'Safety config updated');
  }

  /**
   * 获取当前安全配置（只读副本）
   */
  getConfig(): Readonly<SafetyConfig> {
    return { ...this.config };
  }
}
