/**
 * 数据库连接管理 — 基于 Prisma Client
 *
 * 运行时：Prisma Client（异步、类型安全、ORM 自动建表）
 * 可视化管理：npx prisma studio（基于 prisma/schema.prisma）
 *
 * 切换为 PostgreSQL 的步骤：
 *   1. 改 prisma/schema.prisma provider → "postgresql"
 *   2. 改连接字符串环境变量 DATABASE_URL
 *   3. 无需改动此文件
 *
 * 架构说明：
 * 所有路由层统一通过 db.ts 导出的 prisma 实例访问数据库，
 * 切换数据库源时只需改 schema 和连接字符串，路由层代码零改动。
 */

import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.LOG_DB_PATH || path.join(__dirname, '../../data/logs.db');

import fs from 'fs';
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

/**
 * 初始化数据库 Schema：用原生 SQL 创建表（幂等，CREATE TABLE IF NOT EXISTS）
 *
 * 为什么不用 prisma db push？
 * 1. 子进程方式与 Prisma Client 冲突（数据库文件被占用）
 * 2. 在 Prisma 接管前用原生 SQL 建表，简单可靠
 * 3. Schema 与 prisma/schema.prisma 保持同步即可
 */
function initSchema(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      token       TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS logs (
      id              TEXT PRIMARY KEY,
      trace_id        TEXT NOT NULL,
      span_id         TEXT NOT NULL,
      parent_span_id  TEXT,
      level           TEXT NOT NULL DEFAULT 'info',
      category        TEXT NOT NULL,
      event_key       TEXT,
      message         TEXT,
      data            TEXT,
      source          TEXT NOT NULL,
      app_id          INTEGER,
      user_id         TEXT,
      url             TEXT,
      user_agent      TEXT,
      ip              TEXT,
      timestamp       INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (app_id) REFERENCES apps(id)
    );

    CREATE TABLE IF NOT EXISTS traces (
      trace_id        TEXT PRIMARY KEY,
      root_span_id    TEXT NOT NULL,
      service_name    TEXT NOT NULL DEFAULT 'web',
      start_time      INTEGER NOT NULL,
      end_time        INTEGER,
      span_count      INTEGER DEFAULT 0,
      has_error       INTEGER DEFAULT 0,
      summary         TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_logs_trace_id ON logs(trace_id);
    CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
    CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_app_id ON logs(app_id);
  `);
  console.log('[LogServer] Schema initialized (tables created if not exist)');
}

/**
 * 预配置数据库：创建表 + 设置 WAL 模式 + busy_timeout
 * 在 Prisma Client 初始化之前执行，避免连接冲突
 * WAL / synchronous 持久化到数据库文件头，后续所有连接自动继承
 */
function prepareDatabase(): void {
  const conn = new Database(DB_PATH);
  initSchema(conn);
  conn.pragma('journal_mode = WAL');
  conn.pragma('busy_timeout = 5000');
  conn.pragma('synchronous = NORMAL');
  conn.close();
}

let prisma!: PrismaClient;

/**
 * 获取 Prisma Client 单例
 * 首次调用时初始化，后续复用同一实例
 * 使用 @prisma/adapter-better-sqlite3 作为数据库驱动适配器
 */
export function getPrisma(): PrismaClient {
  if (!prisma) {
    // 在 Prisma 接管前用原生 better-sqlite3 建表 + 设置 WAL
    prepareDatabase();

    const adapter = new PrismaBetterSqlite3({
      url: DB_PATH,
      timeout: 5000,
    });
    prisma = new PrismaClient({
      adapter,
      log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
    console.log(`[LogServer] Prisma Client initialized (DB: ${DB_PATH})`);
  }
  return prisma;
}

// 模块级单例，供所有路由直接使用
const db = getPrisma();
export { db as prisma };

export default prisma;

/** 验证 app token，返回对应的 app 信息，无效返回 null */
export async function validateAppToken(token: string): Promise<{ id: number; name: string } | null> {
  if (!token) return null;
  const app = await prisma.app.findUnique({
    where: { token },
    select: { id: true, name: true },
  });
  console.log('validateAppToken: token', token, 'app:', app);
  return app;
}

/** 获取所有应用列表（不暴露 token） */
export async function getAllApps(): Promise<Array<{ id: number; name: string }>> {
  return prisma.app.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}

/** 关闭数据库连接 */
export async function closeDb(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    console.log('[LogServer] Prisma Client disconnected');
  }
}

/**
 * 确保数据库就绪：表已由 getPrisma() 中的 prepareDatabase() 创建
 * 此函数检查是否有 app，没有则自动创建默认 demo 应用
 *
 * 首次启动自动执行，后续幂等。用户无需手动运行 seed。
 */
export async function ensureDbReady(): Promise<{ demoToken?: string }> {
  // 检查是否有 app，没有则创建默认 demo 应用
  const count = await prisma.app.count();
  if (count === 0) {
    const { v4: uuidv4 } = await import('uuid');
    const demoToken = 'tok_demo_' + uuidv4();
    await prisma.app.create({
      data: { name: 'demo', token: demoToken },
    });
    console.log(`[LogServer] Created default app: demo  token: ${demoToken}`);
    return { demoToken };
  }

  // 返回第一个 app 的 token 供启动信息展示
  const first = await prisma.app.findFirst({ orderBy: { id: 'asc' } });
  return { demoToken: first?.token };
}
