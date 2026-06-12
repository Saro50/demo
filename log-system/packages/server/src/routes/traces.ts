/**
 * 链路追踪路由
 * 
 * GET /api/traces/:traceID - 获取链路完整详情
 * 
 * 链路图的构建：
 * 1. 查询 traces 表获取链路汇总信息
 * 2. 查询 logs 表获取该 traceID 下所有日志
 * 3. 按 parent_span_id 构建树形结构
 * 4. UI 端根据树形结构渲染缩进时间线
 * 
 * 性能考虑：
 * - 每次查询都会扫描该 traceID 下的所有日志（通常不超过 100 条）
 * - 如果链路日志过多（>1000条），后续考虑分页返回 spans
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db/db.js';
import type { TraceDetail } from '@myby/log-shared';

const router = Router();

/**
 * GET /api/traces/:traceID
 */
router.get('/:traceID', (req: Request, res: Response) => {
  const { traceID } = req.params;
  const db = getDb();

  // 查询链路汇总
  const trace = db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(traceID) as Record<string, unknown> | undefined;

  if (!trace) {
    // 即使 traces 表没有汇总，也尝试从 logs 表查询
    const logs = db.prepare('SELECT * FROM logs WHERE trace_id = ? ORDER BY timestamp ASC').all(traceID) as Array<Record<string, unknown>>;
    if (logs.length === 0) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }

    // 动态构建汇总
    const parsedLogs = logs.map((row) => ({
      ...row,
      data: row.data ? tryParseJSON(row.data as string) : undefined,
    }));

    const result: TraceDetail = {
      trace_id: traceID,
      root_span_id: (logs[0].span_id as string) || '',
      service_name: 'web',
      start_time: logs[0].timestamp as number,
      end_time: logs[logs.length - 1].timestamp as number | null,
      span_count: logs.length,
      has_error: logs.some((l) => l.level === 'error' || l.level === 'fatal'),
      summary: `${logs.length} spans, ${logs.filter((l) => l.level === 'error').length} errors`,
      spans: parsedLogs as any,
    };

    res.json(result);
    return;
  }

  // 查询该链路下的所有 spans
  const logs = db.prepare('SELECT * FROM logs WHERE trace_id = ? ORDER BY timestamp ASC').all(traceID) as Array<Record<string, unknown>>;

  const parsedLogs = logs.map((row) => ({
    ...row,
    data: row.data ? tryParseJSON(row.data as string) : undefined,
  }));

  const result: TraceDetail = {
    trace_id: trace.trace_id as string,
    root_span_id: trace.root_span_id as string,
    service_name: trace.service_name as string,
    start_time: trace.start_time as number,
    end_time: trace.end_time as number | null,
    span_count: trace.span_count as number,
    has_error: (trace.has_error as number) === 1,
    summary: trace.summary as string || `${logs.length} spans`,
    spans: parsedLogs as any,
  };

  res.json(result);
});

function tryParseJSON(str: string): Record<string, unknown> | string {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

export default router;
