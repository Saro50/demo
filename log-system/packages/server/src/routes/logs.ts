/**
 * 日志上报与查询路由
 * 
 * POST /api/logs  - 批量日志上报（前端 SDK 调用）
 * GET  /api/logs  - 日志查询与筛选（日志看板调用）
 * GET  /api/logs/:id - 单条日志详情
 * 
 * 上报写入策略：
 * 1. 批量写入：每次最多接收 100 条
 * 2. 幂等性：使用 INSERT OR IGNORE，重复 ID 的日志不会重复写入
 * 3. 异步批量：收到日志后先存入内存缓冲区，每 100ms 或满 100 条刷入 SQLite
 * 
 * 查询筛选支持：
 * - level / category / event_key 精确匹配
 * - keyword 全文搜索（LIKE 匹配 message 和 data）
 * - trace_id 查看特定链路
 * - 时间范围、分页、排序
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/db.js';
import type { LogEntry, LogBatchPayload, LogBatchResponse, LogQueryResponse } from '@myby/log-shared';

const router = Router();

// ==================== 内存缓冲区（批量写入） ====================
const BATCH_INTERVAL = 100; // 100ms
const BATCH_MAX_SIZE = 100;
const buffer: LogEntry[] = [];
let bufferTimer: ReturnType<typeof setTimeout> | null = null;

function flushBuffer(): void {
  if (buffer.length === 0) return;

  const batch = buffer.splice(0);
  const db = getDb();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO logs 
      (id, trace_id, span_id, parent_span_id, level, category, event_key, 
       message, data, source, user_id, url, user_agent, ip, timestamp)
    VALUES 
      (@id, @trace_id, @span_id, @parent_span_id, @level, @category, @event_key,
       @message, @data, @source, @user_id, @url, @user_agent, @ip, @timestamp)
  `);

  // 使用 UPSERT（INSERT ... ON CONFLICT DO UPDATE）更新链路汇总
  // 首次插入：创建 trace 记录
  // 后续插入：增加 span_count，标记 has_error，更新 end_time
  const updateTraceStmt = db.prepare(`
    INSERT INTO traces (trace_id, root_span_id, service_name, start_time, span_count, has_error)
    VALUES (@trace_id, @span_id, 'web', @timestamp, 1, @is_error)
    ON CONFLICT(trace_id) DO UPDATE SET
      span_count = span_count + 1,
      has_error = MAX(has_error, @is_error),
      end_time = MAX(end_time, @timestamp)
  `);

  const transaction = db.transaction(() => {
    for (const log of batch) {
      const id = log.trace_id + '-' + log.span_id;
      insertStmt.run({
        id,
        trace_id: log.trace_id,
        span_id: log.span_id,
        parent_span_id: log.parent_span_id || null,
        level: log.level,
        category: log.category,
        event_key: log.event_key || null,
        message: log.message || null,
        data: log.data ? JSON.stringify(log.data) : null,
        source: log.source,
        user_id: log.user_id || null,
        url: log.url || null,
        user_agent: log.user_agent || null,
        ip: log.ip || null,
        timestamp: log.timestamp,
      });

      // 更新 traces 表（UPSERT：累加 span_count，记录是否含错误）
      updateTraceStmt.run({
        trace_id: log.trace_id,
        span_id: log.span_id,
        timestamp: log.timestamp,
        is_error: (log.level === 'error' || log.level === 'fatal') ? 1 : 0,
      });
    }
  });

  try {
    transaction();
    console.log(`[LogServer] Flushed ${batch.length} logs`);
  } catch (err) {
    console.error('[LogServer] Batch flush failed:', err);
    // 写入失败时，将日志追加回缓冲区头部，下次重试
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
 * 前端 SDK 调用，支持部分成功
 */
router.post('/', (req: Request, res: Response) => {
  const body = req.body as LogBatchPayload;

  if (!body || !Array.isArray(body.logs)) {
    res.status(400).json({ accepted: 0, errors: [{ index: 0, reason: 'Invalid payload: logs array required' }] });
    return;
  }

  const accepted: string[] = [];
  const errors: Array<{ index: number; reason: string }> = [];

  for (let i = 0; i < body.logs.length; i++) {
    const log = body.logs[i];

    // 基本校验
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
    if (!log.timestamp) log.timestamp = Date.now();
    if (!log.ip) log.ip = req.ip || req.socket.remoteAddress || undefined;

    // 加入缓冲区
    const id = log.trace_id + '-' + log.span_id;
    buffer.push(log as LogEntry);
    accepted.push(id);
  }

  // 缓冲区满则立即同步刷入（确保响应返回前数据已持久化）
  // 不满则等待定时调度，先返回响应（减少客户端等待）
  let flushSync = false;
  if (buffer.length >= BATCH_MAX_SIZE) {
    if (bufferTimer) {
      clearTimeout(bufferTimer);
      bufferTimer = null;
    }
    try {
      flushBuffer();
      flushSync = true;
    } catch (flushErr) {
      console.error('[LogServer] Sync flush failed:', flushErr);
      // 刷入失败，响应中包含减少后的 accepted 数
      // 从 accepted 中移除本次这批日志
      const batchAccepted = accepted.length;
      accepted.length = Math.max(0, accepted.length - (buffer.length > 0 ? buffer.length : 0));
    }
  } else {
    scheduleFlush();
  }

  const response: LogBatchResponse = {
    accepted: accepted.length,
    errors,
  };

  res.json(response);

  // 如果刚才是同步刷入但 buffer 中又有新日志（来自并发请求），安排下次调度
  if (flushSync && buffer.length > 0) {
    scheduleFlush();
  }
});

/**
 * GET /api/logs - 查询日志列表
 * 支持多维度筛选与分页
 */
router.get('/', (req: Request, res: Response) => {
  const params = {
    level: req.query.level as string | undefined,
    category: req.query.category as string | undefined,
    event_key: req.query.event_key as string | undefined,
    trace_id: req.query.trace_id as string | undefined,
    user_id: req.query.user_id as string | undefined,
    keyword: req.query.keyword as string | undefined,
    start_time: req.query.start_time ? Number(req.query.start_time) : undefined,
    end_time: req.query.end_time ? Number(req.query.end_time) : undefined,
    page: req.query.page ? Math.max(1, Number(req.query.page)) : 1,
    page_size: req.query.page_size ? Math.min(200, Math.max(1, Number(req.query.page_size))) : 50,
    sort: (req.query.sort as string) === 'asc' ? 'asc' : 'desc',
  };

  const db = getDb();
  
  // 构建 WHERE 子句
  // 注意：better-sqlite3 在使用对象传参时，SQL 中必须使用 @name 命名参数
  // 对于 IN 子句，由于数量动态，需要使用 ? 位置参数
  // 因此这里区分命名参数和位置参数两种方式
  const conditions: string[] = [];
  const namedParams: Record<string, unknown> = {};
  const positionalParams: unknown[] = [];

  if (params.level) {
    const levels = Array.isArray(params.level) ? params.level : params.level.split(',');
    const placeholders = levels.map(() => '?').join(',');
    conditions.push(`level IN (${placeholders})`);
    positionalParams.push(...levels);
  }

  if (params.category) {
    const categories = Array.isArray(params.category) ? params.category : params.category.split(',');
    const placeholders = categories.map(() => '?').join(',');
    conditions.push(`category IN (${placeholders})`);
    positionalParams.push(...categories);
  }

  if (params.event_key) {
    conditions.push('event_key = ?');
    positionalParams.push(params.event_key);
  }

  if (params.trace_id) {
    conditions.push('trace_id = ?');
    positionalParams.push(params.trace_id);
  }

  if (params.user_id) {
    conditions.push('user_id = ?');
    positionalParams.push(params.user_id);
  }

  if (params.keyword) {
    conditions.push('(message LIKE ? OR data LIKE ?)');
    const kw = `%${params.keyword}%`;
    positionalParams.push(kw, kw);
  }

  if (params.start_time) {
    conditions.push('timestamp >= ?');
    positionalParams.push(params.start_time);
  }

  if (params.end_time) {
    conditions.push('timestamp <= ?');
    positionalParams.push(params.end_time);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderClause = `ORDER BY timestamp ${params.sort === 'asc' ? 'ASC' : 'DESC'}`;
  
  // 分页参数
  const pageSize = params.page_size || 50;
  const offset = ((params.page || 1) - 1) * pageSize;

  // 查总数
  const countRow = db.prepare(`SELECT COUNT(*) as total FROM logs ${whereClause}`).get(...positionalParams) as { total: number };

  // 查列表（带分页）
  const allParams = [...positionalParams, pageSize, offset];
  const items = db.prepare(`SELECT * FROM logs ${whereClause} ${orderClause} LIMIT ? OFFSET ?`).all(...allParams) as Array<Record<string, unknown>>;

  // 解析 data 字段
  const parsedItems = items.map((row) => ({
    ...row,
    data: row.data ? tryParseJSON(row.data as string) : undefined,
  }));

  const response = {
    total: countRow.total,
    page: params.page || 1,
    page_size: params.page_size || 50,
    items: parsedItems as unknown as LogEntry[],
  };

  res.json(response);
});

/**
 * GET /api/logs/:id - 单条日志详情
 */
router.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM logs WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;

  if (!row) {
    res.status(404).json({ error: 'Log not found' });
    return;
  }

  res.json({
    ...row,
    data: row.data ? tryParseJSON(row.data as string) : undefined,
  });
});

function tryParseJSON(str: string): Record<string, unknown> | string {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

export default router;
