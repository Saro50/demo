#!/usr/bin/env node
// ============================================================
// BrowserMind CLI 入口
//
// 使用方式:
//   npx browser-mind-mcp                           # stdio 模式（默认）
//   npx browser-mind-mcp --transport sse --port 3100  # SSE 模式
//   npx browser-mind-mcp --help                        # 帮助
// ============================================================

// 优先加载 .env 文件（必须放在所有业务 import 之前）
import 'dotenv/config';

import { main } from './mcp/mcpServer.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
BrowserMind MCP Server — Web 页面智能探测工具

Usage:
  browser-mind-mcp                          # stdio 模式（默认，适配 Claude Desktop）
  browser-mind-mcp --transport sse --port 3100  # SSE 模式
  browser-mind-mcp --help                        # 显示帮助

Options:
  --transport <stdio|sse>  传输模式（默认: stdio）
  --port <number>          SSE 端口（默认: 3100）
  --help                   显示帮助信息

环境变量:
  OPENAI_API_KEY   OpenAI API 密钥（LLM 探索功能需要）
  DATABASE_URL     Prisma 数据库连接（默认: file:./dev.db）

示例:
  # 在 Claude Desktop 中配置:
  # {
  #   "mcpServers": {
  #     "browser-mind": {
  #       "command": "npx",
  #       "args": ["browser-mind-mcp"]
  #     }
  #   }
  # }
  `);
  process.exit(0);
}

main().catch((error) => {
  console.error('BrowserMind MCP Server failed:', error);
  process.exit(1);
});
