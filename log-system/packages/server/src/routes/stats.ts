/**
 * 统计路由 - 为日志看板提供聚合数据
 * 
 * GET /api/stats - 获取统计概览
 * 
 * 数据分类：
 * - 总数 / 异常数 / 警告数
 * - 事件排名（Top 10）
 * - 异常排名（Top 5）
 * - 时间序列（按分钟聚合）
 * 
 * 性能考虑：
 * - 默认统计最近 1 小时数据
 * - 时间范围越大，扫描行数越多
 * - 大数据量时考虑预聚合或物化视图
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db/db.js';
import type { StatsResponse } from '@myby/log-shared';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const now = Date.now();
  const startTime = req.query.start_time ? Number(req.query.start_time) : now - 3600000; // 默认最近1小时
  const endTime = req.query.end_time ? Number(req.query.end_time) : now;

  const db = getDb();

  // 总数
  const totalRow = db.prepare(
    'SELECT COUNT(*) as count FROM logs WHERE timestamp >= ? AND timestamp <= ?'
  ).get(startTime, endTime) as { count: number };

  // 错误数
  const errorRow = db.prepare(
    "SELECT COUNT(*) as count FROM logs WHERE timestamp >= ? AND timestamp <= ? AND level IN ('error', 'fatal')"
  ).get(startTime, endTime) as { count: number };

  // 警告数
  const warnRow = db.prepare(
    "SELECT COUNT(*) as count FROM logs WHERE timestamp >= ? AND timestamp <= ? AND level = 'warn'"
  ).get(startTime, endTime) as { count: number };

  // 事件排名 (Top 10)
  const events = db.prepare(
    `SELECT event_key, COUNT(*) as count FROM logs 
     WHERE timestamp >= ? AND timestamp <= ? AND category = 'event' AND event_key IS NOT NULL 
     GROUP BY event_key ORDER BY count DESC LIMIT 10`
  ).all(startTime, endTime) as Array<{ event_key: string; count: number }>;

  // 异常排名 (Top 5)
  const topErrors = db.prepare(
    `SELECT message, COUNT(*) as count FROM logs 
     WHERE timestamp >= ? AND timestamp <= ? AND level IN ('error', 'fatal') 
     GROUP BY message ORDER BY count DESC LIMIT 5`
  ).all(startTime, endTime) as Array<{ message: string; count: number }>;

  // 时间序列 (按分钟聚合)
  const timeSeries = db.prepare(
    `SELECT 
       strftime('%Y-%m-%dT%H:%M:00Z', timestamp / 1000, 'unixepoch') as time,
       COUNT(*) as count 
     FROM logs 
     WHERE timestamp >= ? AND timestamp <= ? 
     GROUP BY strftime('%Y-%m-%dT%H:%M:00Z', timestamp / 1000, 'unixepoch') 
     ORDER BY time ASC`
  ).all(startTime, endTime) as Array<{ time: string; count: number }>;

  const result: StatsResponse = {
    total_logs: totalRow.count,
    error_count: errorRow.count,
    warn_count: warnRow.count,
    events: Object.fromEntries(events.map((e) => [e.event_key, e.count])),
    top_errors: topErrors,
    time_series: timeSeries,
  };

  res.json(result);
});

export default router;
