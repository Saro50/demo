/**
 * 数据库初始化与连接管理
 * 
 * 使用 better-sqlite3（同步 API）而不是 sqlite3（回调 API）的原因：
 * - 同步 API 代码更简洁，避免回调地狱
 * - 日志写入是高频操作，同步 API 在单线程 Node.js 中反而更可控
 * - better-sqlite3 性能优于 sqlite3（直接绑定 C 库，无中间层）
 * 
 * 并发策略：
 * - SQLite WAL 模式，支持读写并发
 * - 写入时使用 IMMEDIATE 事务，避免多进程竞争
 * - 批量写入合并为单条 INSERT，减少事务开销
 * 
 * 表结构说明：
 * - logs：日志明细表，所有查询基于此表
 * - traces：链路汇总表，加速 traceID 查询
 *   每次写入 logs 时，检查 traces 是否存在，不存在则插入
 *   这样 traces 表是 logs 的聚合缓存，不影响主写入路径性能
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.LOG_DB_PATH || path.join(__dirname, '../../data/logs.db');

// 确保 data 目录存在
import fs from 'fs';
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH, {
      // WAL 模式：读写不互斥，显著提升并发性能
      // 适合读多写多的日志场景
    });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    initSchema(db);
    console.log(`[LogServer] DB opened: ${DB_PATH}`);
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
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
      user_id         TEXT,
      url             TEXT,
      user_agent      TEXT,
      ip              TEXT,
      timestamp       INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
    CREATE INDEX IF NOT EXISTS idx_logs_event_key ON logs(event_key);
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
  `);
}

/** 关闭数据库连接 */
export function closeDb(): void {
  if (db) {
    db.close();
    console.log('[LogServer] DB closed');
  }
}
