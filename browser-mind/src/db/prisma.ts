// ============================================================
// BrowserMind 数据库客户端
//
// 基于 Prisma 封装，提供：
// 1. 类型安全的数据库操作
// 2. 单例模式（复用同一个 PrismaClient 实例）
// 3. 优雅关闭（监听进程退出信号）
//
// 数据模型说明见 prisma/schema.prisma
//
// 使用示例:
//   import { db } from './db/prisma.js';
//   const session = await db.session.create({ data: { goal: '...' } });
// ============================================================

import { PrismaClient } from '@prisma/client';
import type pino from 'pino';
import { getLogger } from '../logging/logger.js';

// 全局单例（防止开发环境热重载创建多个实例）
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

let prismaLogger: pino.Logger | null = null;

/**
 * 创建并配置 PrismaClient 实例
 *
 * 配置策略：
 * - log: 将 Prisma 的查询、警告、错误代理到 Pino
 * - 生产环境关闭查询日志以提升性能
 */
function createPrismaClient(): PrismaClient {
  prismaLogger = getLogger().child({ module: 'prisma' });

  const client = new PrismaClient({
    log: [
      { level: 'warn', emit: 'event' },
      { level: 'error', emit: 'event' },
      { level: 'info', emit: 'event' },
    ],
  });

  // 将 Prisma 日志代理到 Pino
  client.$on('warn' as never, (e: any) => {
    prismaLogger?.warn({ prismaEvent: e }, 'Prisma warning');
  });
  client.$on('error' as never, (e: any) => {
    prismaLogger?.error({ prismaEvent: e }, 'Prisma error');
  });
  client.$on('info' as never, (e: any) => {
    prismaLogger?.info({ prismaEvent: e }, 'Prisma info');
  });

  return client;
}

/**
 * 数据库客户端单例
 *
 * 全局复用同一个 PrismaClient 实例，避免连接池耗尽。
 * 在测试环境中，每次测试应创建独立的客户端。
 */
export const db: PrismaClient =
  globalForPrisma.prisma ?? (globalForPrisma.prisma = createPrismaClient());

/**
 * 断开数据库连接（应用退出时调用）
 */
export async function disconnectDatabase(): Promise<void> {
  prismaLogger?.info('Disconnecting from database...');
  await db.$disconnect();
  prismaLogger?.info('Database disconnected');
}

/**
 * 清除全局单例（主要用于测试环境）
 */
export function resetPrismaClient(): void {
  delete globalForPrisma.prisma;
}
