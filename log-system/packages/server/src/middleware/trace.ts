/**
 * 链路追踪中间件
 * 
 * 从请求头中提取 traceID / spanID，注入到 req 对象中，
 * 后续所有路由和业务代码可直接使用。
 * 
 * 如果请求头中没有 traceID（例如直接调用 API 而非前端 SDK 上报），
 * 则生成新的 traceID，保证链路完整性。
 * 
 * 传递链路：
 * 前端 SDK → x-trace-id header → 本中间件 → req.traceContext → 路由处理器 → 日志写入
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

// 扩展 Express Request 类型
declare global {
  namespace Express {
    interface Request {
      traceContext: {
        traceId: string;
        spanId: string;
        parentSpanId: string | null;
      };
    }
  }
}

/**
 * 链路追踪中间件
 *
 * 行为说明：
 * - 如果请求头中已有 x-trace-id（由前端 SDK 注入），直接沿用，不生成新 ID
 * - 如果无链路头（如直接 curl 调用），则生成新的 traceId/spanId
 * - SDK 自身的上报请求（POST /api/logs）应由 SDK 控制链路，中间件只透传
 */
export function traceMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const traceId = (req.headers['x-trace-id'] as string) || uuidv4();
  const spanId = (req.headers['x-span-id'] as string) || uuidv4();
  const parentSpanId = (req.headers['x-parent-span-id'] as string) || null;

  // 如果请求已有 traceID（由前端 SDK 注入），不做额外处理
  // 如果没有，则新生成（例如直接 API 调用）
  const hasIncomingTrace = !!req.headers['x-trace-id'];

  req.traceContext = {
    traceId,
    spanId,
    parentSpanId,
  };

  // 仅为非 SDK 上报的请求记录访问日志
  if (!hasIncomingTrace) {
    console.log(`[Trace] Generated new trace: ${traceId.slice(0, 8)}... for ${req.method} ${req.path}`);
  }

  next();
}
