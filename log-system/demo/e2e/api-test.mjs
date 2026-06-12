/**
 * API 端点测试 — 验证后端日志服务各接口是否正常
 *
 * 使用方式：
 *   1. 先启动后端：cd packages/server && npm run dev
 *   2. 运行本脚本：cd demo && node e2e/api-test.mjs
 *
 * 测试内容：
 *   ✓ POST /api/logs — 批量日志上报
 *   ✓ GET  /api/logs — 日志查询（含筛选）
 *   ✓ GET  /api/traces/:traceID — 链路详情
 *   ✓ GET  /api/stats — 统计聚合
 *   ✓ GET  /api/health — 健康检查
 */

import path from 'path';

const BASE = process.env.API_BASE || 'http://localhost:3100';
const API = urlPath => `${BASE}${urlPath}`;

// 测试用 token
// 优先级：1. 环境变量 LOG_DEFAULT_TOKEN  2. 从数据库读取（服务器自动 seed 的 demo app）
const TEST_TOKEN = process.env.LOG_DEFAULT_TOKEN || await (async () => {
  const Database = (await import('better-sqlite3')).default;
  const dbPath = process.env.LOG_DB_PATH || path.resolve(import.meta.dirname, '../../packages/server/data/logs.db');
  const db = new Database(dbPath);
  const row = db.prepare('SELECT token FROM apps ORDER BY id ASC LIMIT 1').get();
  db.close();
  if (!row) throw new Error('No apps found in database. Start the server first.');
  return row.token;
})();

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${label}: ${err.message}`);
    failed++;
  }
}

function expect(actual, label) {
  return {
    toBe(expected) {
      if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toMatch(pattern) {
      if (!pattern.test(String(actual))) throw new Error(`${label}: ${JSON.stringify(actual)} doesn't match ${pattern}`);
    },
    toBeDefined() {
      if (actual === undefined || actual === null) throw new Error(`${label}: expected defined, got ${actual}`);
    },
  };
}

// ============================================================
// 健康检查
// ============================================================
async function testHealth() {
  const res = await fetch(API('/api/health'));
  expect(res.status, 'health status').toBe(200);
  const data = await res.json();
  expect(data.status, 'health status field').toBe('ok');
  expect(typeof data.timestamp, 'health timestamp').toBe('number');
}

// ============================================================
// 日志上报 + 查询
// ============================================================
async function testLogCrud() {
  const traceId = `demo-${Date.now()}`;
  const now = Date.now();

  // 上报 4 条不同级别/分类的日志
  const payload = {
    logs: [
      {
        trace_id: traceId,
        span_id: `${traceId}-page`,
        parent_span_id: null,
        level: 'info',
        category: 'page',
        message: '页面加载: /home',
        source: 'frontend',
        timestamp: now,
      },
      {
        trace_id: traceId,
        span_id: `${traceId}-click`,
        parent_span_id: `${traceId}-page`,
        level: 'info',
        category: 'event',
        event_key: 'button_click',
        message: '用户点击提交按钮',
        data: { button_id: 'submit-order', page: '/home' },
        source: 'frontend',
        timestamp: now + 500,
      },
      {
        trace_id: traceId,
        span_id: `${traceId}-api`,
        parent_span_id: `${traceId}-click`,
        level: 'warn',
        category: 'request',
        message: '200 OK',
        source: 'frontend',
        timestamp: now + 1000,
      },
      {
        trace_id: traceId,
        span_id: `${traceId}-err`,
        parent_span_id: `${traceId}-api`,
        level: 'error',
        category: 'exception',
        message: 'TypeError: undefined is not an object',
        data: { stack: 'at Object.submit (order.js:45)' },
        source: 'frontend',
        timestamp: now + 1500,
      },
    ],
  };

  // POST /api/logs（需携带 x-app-token 认证）
  const postRes = await fetch(API('/api/logs'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-token': TEST_TOKEN },
    body: JSON.stringify(payload),
  });
  expect(postRes.status, 'POST status').toBe(200);
  const postData = await postRes.json();
  expect(postData.accepted, 'POST accepted count').toBe(4);
  expect(postData.errors.length, 'POST errors count').toBe(0);

  // 等缓冲区刷入
  await new Promise(r => setTimeout(r, 500));

  // GET /api/logs — 按 trace_id 查询
  const qRes = await fetch(API(`/api/logs?trace_id=${traceId}&page_size=10`));
  const qData = await qRes.json();
  expect(qData.total, 'query total').toBe(4);

  // GET /api/logs — 按级别筛选
  const errorRes = await fetch(API(`/api/logs?level=error&trace_id=${traceId}`));
  const errorData = await errorRes.json();
  expect(errorData.total, 'error filter').toBe(1);
  expect(errorData.items[0].level, 'error level').toBe('error');

  // GET /api/logs — 按分类筛选
  const eventRes = await fetch(API(`/api/logs?category=event&trace_id=${traceId}`));
  const eventData = await eventRes.json();
  expect(eventData.total, 'event filter').toBe(1);
  expect(eventData.items[0].event_key, 'event key').toBe('button_click');

  // GET /api/logs — 关键词搜索
  const kwRes = await fetch(API(`/api/logs?keyword=TypeError&trace_id=${traceId}`));
  const kwData = await kwRes.json();
  expect(kwData.total, 'keyword search').toBe(1);

  // GET /api/traces/:traceID
  const tRes = await fetch(API(`/api/traces/${traceId}`));
  const tData = await tRes.json();
  expect(tData.trace_id, 'trace id').toBe(traceId);
  expect(tData.span_count, 'trace span_count').toBe(4);
  expect(tData.has_error, 'trace has_error').toBe(true);
  expect(tData.spans.length, 'trace spans length').toBe(4);

  // 验证链路树：根节点 parent_span_id 应为 null
  const rootSpan = tData.spans.find(s => s.parent_span_id === null);
  expect(rootSpan ? true : false, 'root span exists').toBe(true);

  return traceId;
}

// ============================================================
// 统计接口
// ============================================================
async function testStats() {
  const now = Date.now();
  const res = await fetch(API(`/api/stats?start_time=${now - 86400000}&end_time=${now}`));
  expect(res.status, 'stats status').toBe(200);
  const data = await res.json();
  expect(typeof data.total_logs, 'stats total_logs').toBe('number');
  expect(typeof data.error_count, 'stats error_count').toBe('number');
  expect(Array.isArray(data.top_errors), 'stats top_errors').toBe(true);
  expect(Array.isArray(data.time_series), 'stats time_series').toBe(true);
}

// ============================================================
// 错误场景：缺字段校验
// ============================================================
async function testValidation() {
  const res = await fetch(API('/api/logs'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-token': TEST_TOKEN },
    body: JSON.stringify({
      logs: [
        { level: 'info', message: 'missing trace_id and span_id' },
        { trace_id: 't1', span_id: 's1', level: 'invalid_level', category: 'event', message: 'bad' },
      ],
    }),
  });
  expect(res.status, 'validation status').toBe(200);
  const data = await res.json();
  expect(data.accepted, 'validation accepted').toBe(0);
  expect(data.errors.length, 'validation errors count').toBe(2);
}

// ============================================================
// 主流程
// ============================================================
console.log('\n🔍 日志服务 API 测试\n');

console.log('1️⃣  健康检查');
await check('/api/health 返回 ok', testHealth);

console.log('\n2️⃣  日志 CRUD（上报 → 查询 → 链路）');
await check('完整 CRUD 流程', testLogCrud);

console.log('\n3️⃣  统计接口');
await check('/api/stats 返回格式正确', testStats);

console.log('\n4️⃣  参数校验');
await check('缺失字段和非法值被正确拒绝', testValidation);

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  结果: ${passed} 通过, ${failed} 失败`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
process.exit(failed > 0 ? 1 : 0);
