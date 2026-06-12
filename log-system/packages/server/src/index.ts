/**
 * @log-system/server - 后端日志服务
 * 
 * 启动方式：
 *   npm run dev    # 开发模式，tsx watch 自动重启
 *   npm start      # 生产模式，需先编译
 * 
 * 环境变量：
 *   PORT          - 监听端口，默认 3100
 *   LOG_DB_PATH   - SQLite 数据库路径
 *   CORS_ORIGIN   - CORS 允许的来源
 * 
 * 架构说明：
 * 本服务是一个轻量级的日志接收和查询服务，不依赖外部中间件。
 * 通过内存缓冲区批量写入 SQLite，兼顾写入性能和持久化。
 * 
 * 路由组织：
 *   POST /api/logs    - 日志上报（前端 SDK 调用）
 *   GET  /api/logs    - 日志查询（日志看板调用）
 *   GET  /api/logs/:id - 单条日志
 *   GET  /api/traces/:traceID - 链路详情
 *   GET  /api/stats    - 统计聚合
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { traceMiddleware } from './middleware/trace.js';
import logsRouter from './routes/logs.js';
import tracesRouter from './routes/traces.js';
import statsRouter from './routes/stats.js';
import { getDb, closeDb } from './db/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT) || 3100;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// ==================== 中间件 ====================

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '1mb' })); // 限制请求体大小
app.use(traceMiddleware);

// 请求日志（非日志系统的业务日志，而是服务自身的访问日志）
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ==================== 静态文件服务（UI 看板） ====================
// 开发时路径: ../ui/dist（相对于 src/）
// 生产时路径: ../../ui/dist（相对于 dist/）
const uiDistPath = path.resolve(__dirname, '../../ui/dist');
app.use(express.static(uiDistPath));

// SPA 兜底：未匹配 API 的路由返回 index.html
app.get('/', (_req, res) => {
  res.sendFile(path.join(uiDistPath, 'index.html'));
});

// ==================== 路由 ====================

app.use('/api/logs', logsRouter);
app.use('/api/traces', tracesRouter);
app.use('/api/stats', statsRouter);

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ==================== 启动 ====================

async function main() {
  // 初始化数据库（确保表存在）
  getDb();

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║        @log-system/server                ║
║                                          ║
║  Log Service running at:                 ║
║    http://localhost:${PORT}                 ║
║                                          ║
║  Endpoints:                              ║
║    POST /api/logs     - Report logs      ║
║    GET  /api/logs     - Query logs       ║
║    GET  /api/traces   - Trace detail     ║
║    GET  /api/stats    - Statistics       ║
║    GET  /api/health   - Health check     ║
║                                          ║
║  DB: ${process.env.LOG_DB_PATH || './data/logs.db'}  ║
╚══════════════════════════════════════════╝
    `);
  });
}

// 优雅关闭
process.on('SIGINT', () => {
  console.log('[LogServer] Shutting down...');
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[LogServer] Shutting down...');
  closeDb();
  process.exit(0);
});

main().catch((err) => {
  console.error('[LogServer] Fatal error:', err);
  process.exit(1);
});
