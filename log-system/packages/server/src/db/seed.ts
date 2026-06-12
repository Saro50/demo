/**
 * 数据库种子脚本 — 创建初始应用和 token
 *
 * 使用方式：
 *   npx tsx src/db/seed.ts
 *
 * 只会插入不存在的应用，已存在的跳过。
 * 应用只能通过此脚本或 Prisma Studio 手动创建。
 */

import { prisma } from './db.js';
import { v4 as uuidv4 } from 'uuid';

// 允许通过环境变量覆盖 token（方便 e2e 测试）
const TEST_TOKEN = process.env.LOG_DEFAULT_TOKEN;

const DEFAULT_APPS = [
  { name: 'default', token: TEST_TOKEN || 'tok_default_' + uuidv4() },
  { name: 'web-app', token: 'tok_web_' + uuidv4() },
  { name: 'admin',   token: 'tok_admin_' + uuidv4() },
  { name: 'dash-boards',     token: 'tok_api_' + uuidv4() },
];

let inserted = 0;
for (const app of DEFAULT_APPS) {
  const existing = await prisma.app.findUnique({ where: { name: app.name } });
  if (existing) {
    console.log(`  ⏭️  已存在: ${app.name}  token: ${existing.token}`);
  } else {
    const created = await prisma.app.create({ data: app });
    console.log(`  ✅ 创建应用: ${created.name}  token: ${created.token}`);
    inserted++;
  }
}

const total = await prisma.app.count();
console.log(`\n完成: 新增 ${inserted} 个应用，共 ${total} 个`);

await prisma.$disconnect();
