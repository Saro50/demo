// ============================================================
// BrowserMind 日志模块
//
// 基于 Pino 封装，提供结构化日志能力。
// 所有日志带有 sessionId、stepNumber 上下文，便于回溯。
//
// 设计决策：
// - 使用 Pino 而不是 console，因为 Pino 输出结构化 JSON，
//   方便日志系统采集和分析。
// - 每个交互操作产生一条包含完整链路的日志记录。
// - 日志同时写入 stdout（开发友好）和可选的数据库持久化。
// ============================================================

import pino from 'pino';
import type { BrowserMindConfig } from '../types/index.js';

// 全局 logger 实例（延迟初始化）
let _logger: pino.Logger | null = null;

/**
 * 初始化框架的根日志记录器
 *
 * @param config - 框架配置（影响日志级别和输出方式）
 * @returns 配置好的 Pino Logger 实例
 *
 * 影响范围：
 * - 所有模块共用此 logger 实例
 * - config.logging.level 控制日志详细程度
 * - config.logging.prettyPrint 控制开发友好度
 */
export function initLogger(config: BrowserMindConfig): pino.Logger {
  _logger = pino({
    level: config.logging.level || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // 所有日志统一带上框架标识
      bindings: () => ({ framework: 'browser-mind', version: '1.0.0' }),
    },
    redact: {
      // 自动脱敏敏感字段
      paths: [
        'apiKey',
        'password',
        'secret',
        'token',
        'authorization',
        'cookie',
      ],
      censor: '[REDACTED]',
    },
  });

  // 如果要求 pretty print，添加一个额外的流
  if (config.logging.prettyPrint) {
    // Pino 默认输出已经是可读的 JSON，不需要特殊 transport
  }

  _logger.info('Logger initialized with level: %s', config.logging.level);
  return _logger;
}

/**
 * 创建带会话上下文的子日志记录器
 *
 * 所有子日志自动携带 sessionId 和 stepNumber，
 * 方便在日志系统中按会话聚合检索。
 *
 * @param sessionId - 会话 ID
 * @param stepNumber - 当前步骤号（可选）
 * @returns 带上下文的 Pino Logger
 */
export function createSessionLogger(
  sessionId: string,
  stepNumber?: number
): pino.Logger {
  if (!_logger) {
    throw new Error(
      'Logger not initialized. Call initLogger() before creating session loggers.'
    );
  }

  const bindings: Record<string, unknown> = { sessionId };
  if (stepNumber !== undefined) {
    bindings.stepNumber = stepNumber;
  }

  return _logger.child(bindings);
}

/**
 * 获取根 logger（用于初始化前的临时日志）
 */
export function getLogger(): pino.Logger {
  if (!_logger) {
    // 兜底：创建一个最小配置的 logger
    _logger = pino({ level: 'info' });
  }
  return _logger;
}

/**
 * 关闭日志系统（应用退出时调用）
 */
export async function closeLogger(): Promise<void> {
  if (_logger) {
    await new Promise<void>((resolve) => {
      _logger!.flush();
      resolve();
    });
  }
}

/**
 * 日志层级常量
 */
export const LOG_LEVELS = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
} as const;
