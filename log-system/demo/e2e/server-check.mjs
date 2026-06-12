/**
 * 服务状态检查 — 验证后端服务是否正常运行
 *
 * 使用方式：
 *   node e2e/server-check.mjs              # 检查默认地址 localhost:3100
 *   API_BASE=http://my-server.com node e2e/server-check.mjs
 *
 * 返回码：
 *   0 = 服务正常
 *   1 = 服务异常
 */

const BASE = process.env.API_BASE || 'http://localhost:3100';

async function main() {
  const url = `${BASE}/api/health`;
  console.log(`检查服务: ${url}`);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.error(`❌ HTTP ${res.status}: ${res.statusText}`);
      process.exit(1);
    }
    const data = await res.json();
    if (data.status !== 'ok') {
      console.error(`❌ 服务状态异常: ${JSON.stringify(data)}`);
      process.exit(1);
    }
    console.log(`✅ 服务正常 (${new Date(data.timestamp).toLocaleString()})`);
    process.exit(0);
  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.error(`❌ 连接超时 (5s)`);
    } else if (err.code === 'ECONNREFUSED') {
      console.error(`❌ 连接被拒绝 — 服务未启动`);
      console.error(`   请先在另一个终端启动: cd packages/server && npm run dev`);
    } else {
      console.error(`❌ ${err.message}`);
    }
    process.exit(1);
  }
}

main();
