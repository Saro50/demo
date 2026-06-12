import { Router, Request, Response } from 'express';
import { prisma } from '../db/db.js';
import type { TraceDetail } from '@myby/log-shared';

const router = Router();

router.get('/:traceID', async (req: Request, res: Response) => {
  const { traceID } = req.params;

  // 查 traces 表获取汇总
  const trace = await prisma.trace.findUnique({ where: { traceId: traceID } });

  // 查 logs 表获取所有 span
  const logs = await prisma.log.findMany({
    where: { traceId: traceID },
    orderBy: { timestamp: 'asc' },
    include: { app: { select: { name: true } } },
  });

  if (logs.length === 0) {
    res.status(404).json({ error: 'Trace not found' });
    return;
  }

  const spans = logs.map((row) => ({
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
    user_id: row.userId,
    url: row.url,
    timestamp: row.timestamp,
  }));

  const result: TraceDetail = {
    trace_id: traceID,
    root_span_id: trace?.rootSpanId || logs[0].spanId,
    service_name: trace?.serviceName || 'web',
    start_time: trace?.startTime || logs[0].timestamp,
    end_time: trace?.endTime || logs[logs.length - 1].timestamp || null,
    span_count: trace?.spanCount || logs.length,
    has_error: trace ? trace.hasError === 1 : logs.some((l) => l.level === 'error' || l.level === 'fatal'),
    summary: trace?.summary || `${logs.length} spans`,
    spans: spans as any,
  };

  res.json(result);
});

function tryParseJSON(str: string): Record<string, unknown> | string {
  try { return JSON.parse(str); } catch { return str; }
}

export default router;
