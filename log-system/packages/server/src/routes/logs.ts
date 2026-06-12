/**
 * 日志上报与查询路由 — 基于 Prisma
 *
 * POST /api/logs  - 批量日志上报（需要 x-app-token 认证）
 * GET  /api/logs  - 日志查询与筛选
 * GET  /api/logs/:id - 单条日志详情
 *
 * 写入策略：
 * 1. 内存缓冲区合并写入，每 100ms 或满 100 条刷入
 * 2. 使用 Prisma $transaction 保证一批日志要么全写入要么全不写
 * 3. trace 汇总用 upsert 累加
 * 4. 幂等性：主键冲突时静默忽略（同一条日志不会重复）
 */

import { Router, Request, Response } from 'express';
import { prisma, validateAppToken } from '../db/db.js';
import type { LogEntry, LogBatchPayload, LogBatchResponse, LogQueryResponse } from '@myby/log-shared';

const router = Router();

// ==================== 内存缓冲区（批量写入） ====================
const BATCH_INTERVAL = 100;
const BATCH_MAX_SIZE = 100;
const buffer: LogEntry[] = [];
let bufferTimer: ReturnType<typeof setTimeout> | null = null;

async function flushBuffer(): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0);

  try {
    await prisma.$transaction(async (tx) => {
      for (const log of batch) {
        const id = log.trace_id + '-' + log.span_id;

        // INSERT OR IGNORE 等效：主键冲突时静默忽略
        await tx.log.create({ data: {
          id,
          traceId: log.trace_id,
          spanId: log.span_id,
          parentSpanId: log.parent_span_id || null,
          level: log.level,
          category: log.category,
          eventKey: log.event_key || null,
          message: log.message || null,
          data: log.data ? JSON.stringify(log.data) : null,
          source: log.source,
          appId: log.app_id || null,
          userId: log.user_id || null,
          url: log.url || null,
          userAgent: log.user_agent || null,
          ip: log.ip || null,
          timestamp: log.timestamp,
        }}).catch(() => {
          // 主键冲突（同一条日志已存在），静默忽略
        });

        // UPSERT 链路汇总
        await tx.trace.upsert({
          where: { traceId: log.trace_id },
          create: {
            traceId: log.trace_id,
            rootSpanId: log.span_id,
            serviceName: 'web',
            startTime: log.timestamp,
            spanCount: 1,
            hasError: (log.level === 'error' || log.level === 'fatal') ? 1 : 0,
          },
          update: {
            spanCount: { increment: 1 },
            hasError: (log.level === 'error' || log.level === 'fatal') ? 1 : undefined,
            endTime: log.timestamp,
          },
        });
      }
    });
    console.log(`[LogServer] Flushed ${batch.length} logs`);
  } catch (err) {
    console.error('[LogServer] Batch flush failed:', err);
    buffer.unshift(...batch);
  }
}

function scheduleFlush(): void {
  if (bufferTimer) return;
  bufferTimer = setTimeout(() => {
    bufferTimer = null;
    flushBuffer();
  }, BATCH_INTERVAL);
}

// ==================== 路由定义 ====================

/**
 * POST /api/logs - 批量上报日志
 * 需要 x-app-token 认证，无效 token 返回 403
 */
router.post('/', async (req: Request, res: Response) => {
  console.log('req.headers:',JSON.stringify(req.headers))
  // Token 认证
  const token = (req.headers['x-app-token'] as string) || '';
  console.log('req.headers: token', token)
  const app = await validateAppToken(token);

  if (!app) {
    res.status(403).json({ accepted: 0, errors: [{ index: 0, reason: 'Forbidden: invalid or missing x-app-token' }] });
    return;
  }

  const body = req.body as LogBatchPayload;
  if (!body || !Array.isArray(body.logs)) {
    res.status(400).json({ accepted: 0, errors: [{ index: 0, reason: 'Invalid payload: logs array required' }] });
    return;
  }

  const accepted: string[] = [];
  const errors: Array<{ index: number; reason: string }> = [];

  for (let i = 0; i < body.logs.length; i++) {
    const log = body.logs[i];

    if (!log.trace_id || !log.span_id || !log.level || !log.category) {
      errors.push({ index: i, reason: 'Missing required fields (trace_id, span_id, level, category)' });
      continue;
    }
    if (!['debug', 'info', 'warn', 'error', 'fatal'].includes(log.level)) {
      errors.push({ index: i, reason: `Invalid level: ${log.level}` });
      continue;
    }

    // 补全字段
    if (!log.source) log.source = 'frontend';
    log.app_id = app.id;
    if (!log.timestamp) log.timestamp = Date.now();
    if (!log.ip) log.ip = req.ip || req.socket.remoteAddress || undefined;

    const id = log.trace_id + '-' + log.span_id;
    buffer.push(log as LogEntry);
    accepted.push(id);
  }

  // 缓冲区满则立即刷入
  if (buffer.length >= BATCH_MAX_SIZE) {
    if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = null; }
    await flushBuffer();
  } else {
    scheduleFlush();
  }

  res.json({ accepted: accepted.length, errors } as LogBatchResponse);

  if (buffer.length > 0) scheduleFlush();
});

/**
 * GET /api/logs - 查询日志列表
 */
router.get('/', async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 50));
  const sort = (req.query.sort as string) === 'asc' ? 'asc' : 'desc';
  const level = req.query.level as string | undefined;
  const category = req.query.category as string | undefined;
  const eventKey = req.query.event_key as string | undefined;
  const traceId = req.query.trace_id as string | undefined;
  const appName = req.query.app_name as string | undefined;
  const userId = req.query.user_id as string | undefined;
  const keyword = req.query.keyword as string | undefined;
  const startTime = req.query.start_time ? Number(req.query.start_time) : undefined;
  const endTime = req.query.end_time ? Number(req.query.end_time) : undefined;

  // 构建 Prisma where
  const where: Record<string, unknown> = {};
  if (level) where.level = { in: level.split(',') };
  if (category) where.category = { in: category.split(',') };
  if (eventKey) where.eventKey = eventKey;
  if (traceId) where.traceId = traceId;
  if (userId) where.userId = userId;
  if (keyword) where.OR = [
    { message: { contains: keyword } },
    { data: { contains: keyword } },
  ];
  if (startTime || endTime) {
    where.timestamp = {};
    if (startTime) (where.timestamp as Record<string, unknown>).gte = startTime;
    if (endTime) (where.timestamp as Record<string, unknown>).lte = endTime;
  }

  // app_name 筛选：通过 apps 表查找 app_id
  if (appName) {
    const app = await prisma.app.findUnique({ where: { name: appName }, select: { id: true } });
    if (app) where.appId = app.id;
    else { res.json({ total: 0, page, page_size: pageSize, items: [] }); return; }
  }

  const [items, total] = await Promise.all([
    prisma.log.findMany({
      where: where as any,
      orderBy: { timestamp: sort },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { app: { select: { name: true } } },
    }),
    prisma.log.count({ where: where as any }),
  ]);

  const result: LogQueryResponse = {
    total,
    page,
    page_size: pageSize,
    items: items.map((row) => ({
      id: row.id,
      trace_id: row.traceId,
      span_id: row.spanId,
      parent_span_id: row.parentSpanId,
      level: row.level,
      category: row.category,
      event_key: row.eventKey,
      message: row.message || '',
      data: row.data ? tryParseJSON(row.data) : undefined,
      source: row.source,
      app_name: row.app?.name || null,
      user_id: row.userId,
      url: row.url,
      user_agent: row.userAgent,
      ip: row.ip,
      timestamp: row.timestamp,
    })) as any,
  };

  res.json(result);
});

/**
 * GET /api/logs/:id - 单条日志详情
 */
router.get('/:id', async (req: Request, res: Response) => {
  const row = await prisma.log.findUnique({
    where: { id: req.params.id },
    include: { app: { select: { name: true } } },
  });

  if (!row) { res.status(404).json({ error: 'Log not found' }); return; }

  res.json({
    id: row.id,
    trace_id: row.traceId,
    span_id: row.spanId,
    parent_span_id: row.parentSpanId,
    level: row.level,
    category: row.category,
    event_key: row.eventKey,
    message: row.message || '',
    data: row.data ? tryParseJSON(row.data) : undefined,
    source: row.source,
    app_name: row.app?.name || null,
    user_id: row.userId,
    url: row.url,
    user_agent: row.userAgent,
    ip: row.ip,
    timestamp: row.timestamp,
  });
});

function tryParseJSON(str: string): Record<string, unknown> | string {
  try { return JSON.parse(str); } catch { return str; }
}

export default router;
