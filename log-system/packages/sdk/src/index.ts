/**
 * @log-system/sdk - 前端日志采集 SDK
 * 
 * 使用方式：
 * ```typescript
 * import { Logger } from '@log-system/sdk';
 * 
 * // 初始化
 * Logger.init({ appName: 'my-app', environment: 'production' });
 * 
 * // 主动上报
 * Logger.track('pay_success', { amount: 99.9 });
 * Logger.error('请求失败', { code: 500 });
 * Logger.info('用户注册');
 * 
 * // 设置用户
 * Logger.setUserId('user_xxx');
 * ```
 * 
 * 被动上报（自动，无需业务代码）：
 * - JS 运行时错误 → exception
 * - Promise 未捕获异常 → exception
 * - 网络请求 (fetch) → request
 * - 路由变化 → page
 * - 性能指标 (FCP/LCP/CLS/TTFB) → performance（需配置开启）
 * 
 * 架构说明：
 * - Logger 是全局单例静态外观
 * - 内部使用 IndexedDB 做本地队列，即使断网也不丢日志
 * - 每 2s 批量上报，最多合并 20 条/次
 * - 失败后指数退避重试，最多 5 次
 */

export { Logger } from './logger';
export type { LoggerInstance } from './logger';
export { LocalQueue } from './queue';
export { Reporter } from './reporter';
export { setupPassiveCapture } from './capture';
export { getOrCreateTraceId, generateSpanId, generateId, setTraceId } from './id';
export { sanitizeData } from './sanitizer';
export type { LogEntry, LoggerConfig, LogBatchPayload, LogBatchResponse, LogLevel, LogCategory } from '@myby/log-shared';

// 方便使用方只 import @myby/log-sdk 就能拿到所有类型
// 类型实际定义在 @myby/log-shared 中，通过 workspace 解析
