import { Router, Request, Response } from 'express';
import { prisma } from '../db/db.js';
import type { StatsResponse } from '@myby/log-shared';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const now = Date.now();
  const startTime = req.query.start_time ? Number(req.query.start_time) : now - 3600000;
  const endTime = req.query.end_time ? Number(req.query.end_time) : now;

  const where = { timestamp: { gte: startTime, lte: endTime } };

  // 并行查询
  const [totalLogs, errorCount, warnCount, events, topErrors, timeSeries] = await Promise.all([
    prisma.log.count({ where }),
    prisma.log.count({ where: { ...where, level: { in: ['error', 'fatal'] } } }),
    prisma.log.count({ where: { ...where, level: 'warn' } }),

    // 事件排名 (Top 10)
    prisma.log.groupBy({
      by: ['eventKey'],
      where: { ...where, category: 'event', eventKey: { not: null } },
      _count: { eventKey: true },
      orderBy: { _count: { eventKey: 'desc' } },
      take: 10,
    }),

    // 异常排名 (Top 5)
    prisma.$queryRawUnsafe<Array<{ message: string; count: bigint }>>(
      `SELECT message, COUNT(*) as count FROM logs 
       WHERE timestamp >= ? AND timestamp <= ? AND level IN ('error', 'fatal')
       GROUP BY message ORDER BY count DESC LIMIT 5`,
      startTime, endTime
    ),

    // 时间序列（按分钟聚合）
    prisma.$queryRawUnsafe<Array<{ time: string; count: bigint }>>(
      `SELECT 
         strftime('%Y-%m-%dT%H:%M:00Z', timestamp / 1000, 'unixepoch') as time,
         COUNT(*) as count 
       FROM logs 
       WHERE timestamp >= ? AND timestamp <= ? 
       GROUP BY strftime('%Y-%m-%dT%H:%M:00Z', timestamp / 1000, 'unixepoch')
       ORDER BY time ASC`,
      startTime, endTime
    ),
  ]);

  const result: StatsResponse = {
    total_logs: totalLogs,
    error_count: errorCount,
    warn_count: warnCount,
    events: Object.fromEntries(
      (events as Array<{ eventKey: string | null; _count: { eventKey: number } }>)
        .filter(e => e.eventKey)
        .map(e => [e.eventKey!, e._count.eventKey])
    ),
    top_errors: (topErrors as Array<{ message: string; count: bigint }>).map(e => ({
      message: e.message,
      count: Number(e.count),
    })),
    time_series: (timeSeries as Array<{ time: string; count: bigint }>).map(t => ({
      time: t.time,
      count: Number(t.count),
    })),
  };

  res.json(result);
});

export default router;
