import { Router, Request, Response } from 'express';
import { prisma } from '../db/db.js';
import type { StatsResponse } from '@myby/log-shared';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const now = Date.now();
  const startTime = req.query.start_time ? Number(req.query.start_time) : now - 3600000;
  const endTime = req.query.end_time ? Number(req.query.end_time) : now;
  const appName = req.query.app_name as string | undefined;

  // 如果传了 app_name，查出对应的 app_id 加入筛选条件
  let appIdFilter: number | undefined;
  if (appName) {
    const app = await prisma.app.findUnique({ where: { name: appName }, select: { id: true } });
    if (app) appIdFilter = app.id;
    else {
      // 应用不存在，直接返回空数据
      const empty: StatsResponse = { total_logs: 0, error_count: 0, warn_count: 0, events: {}, top_errors: [], time_series: [] };
      res.json(empty);
      return;
    }
  }

  const where: Record<string, unknown> = { timestamp: { gte: startTime, lte: endTime } };
  if (appIdFilter !== undefined) where.appId = appIdFilter;

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
       WHERE timestamp >= ? AND timestamp <= ? AND level IN ('error', 'fatal')${appIdFilter !== undefined ? ' AND app_id = ?' : ''}
       GROUP BY message ORDER BY count DESC LIMIT 5`,
      ...(appIdFilter !== undefined ? [startTime, endTime, appIdFilter] : [startTime, endTime])
    ),

    // 时间序列（按分钟聚合）
    prisma.$queryRawUnsafe<Array<{ time: string; count: bigint }>>(
      `SELECT 
         strftime('%Y-%m-%dT%H:%M:00Z', timestamp / 1000, 'unixepoch') as time,
         COUNT(*) as count 
       FROM logs 
       WHERE timestamp >= ? AND timestamp <= ?${appIdFilter !== undefined ? ' AND app_id = ?' : ''}
       GROUP BY strftime('%Y-%m-%dT%H:%M:00Z', timestamp / 1000, 'unixepoch')
       ORDER BY time ASC`,
      ...(appIdFilter !== undefined ? [startTime, endTime, appIdFilter] : [startTime, endTime])
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
