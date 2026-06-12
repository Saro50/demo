/**
 * HTTP 上报器 - 将日志通过批量 POST 发送到后端
 * 
 * 重试策略（指数退避）：
 * - 首次失败后等待 retryInterval (默认1s)
 * - 每次重试间隔翻倍: 1s → 2s → 4s → 8s → 16s
 * - 达到 maxRetries 后丢弃日志，记录丢弃事件
 * 
 * 为什么用 fetch 而不是 navigator.sendBeacon？
 * - sendBeacon 无法读取响应，无法确认成功/失败
 * - sendBeacon 只能 POST 简单数据，无法自定义 Header
 * - fetch 可以获取响应码做重试判断
 * 
 * 注意：
 * - 上报是异步的，不阻塞业务主流程
 * - 批量上报合并多条日志减少 HTTP 请求
 */

import type { LogEntry, LogBatchResponse } from '@myby/log-shared';

export interface ReporterOptions {
  endpoint: string;
  retryInterval: number;
  maxRetries: number;
  appToken?: string;
}

export class Reporter {
  private endpoint: string;
  private retryInterval: number;
  private maxRetries: number;
  private appToken: string;

  constructor(options: ReporterOptions) {
    this.endpoint = options.endpoint;
    this.retryInterval = options.retryInterval;
    this.maxRetries = options.maxRetries;
    this.appToken = options.appToken || '';
  }

  /**
   * 上报一批日志
   * @returns 成功上报的日志 ID 列表，用于从队列中移除
   */
  async send(logs: LogEntry[]): Promise<{ success: boolean; acceptedIds: string[] }> {
    if (logs.length === 0) {
      return { success: true, acceptedIds: [] };
    }

    const logIds = logs.map((l) => l.trace_id + '-' + l.span_id);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10s 超时

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-trace-id': logs[0].trace_id,
      };
      if (this.appToken) {
        headers['x-app-token'] = this.appToken;
      }

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ logs }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        const result: LogBatchResponse = await response.json();
        // 部分成功：用 errors 中记录的索引反推哪些日志被接受
        // 例如 result.accepted=3, errors=[{index:1},{index:3}] 表示第1、3条失败
        // 则真正被接受的是索引 [0, 2, 4...] 的日志
        const errorIndexes = new Set(result.errors.map(e => e.index));
        const acceptedIds = logIds.filter((_, i) => !errorIndexes.has(i));
        return { success: true, acceptedIds };
      }

      // 服务端错误，需要重试
      console.warn(`[LogSystem] Report failed with status ${response.status}, will retry`);
      return { success: false, acceptedIds: [] };
    } catch (err) {
      // 网络错误 / 超时，需要重试
      console.warn('[LogSystem] Report network error, will retry:', err);
      return { success: false, acceptedIds: [] };
    }
  }

  /** 计算下次重试的等待时间（指数退避 + 随机抖动） */
  getRetryDelay(retryCount: number): number {
    const baseDelay = this.retryInterval * Math.pow(2, retryCount);
    // 随机抖动 ±20%，防止多个客户端同时重试造成雪崩
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.min(baseDelay * jitter, 30000); // 最大 30s
  }

  getMaxRetries(): number {
    return this.maxRetries;
  }
}
