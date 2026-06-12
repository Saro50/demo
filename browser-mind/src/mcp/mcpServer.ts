// ============================================================
// BrowserMind MCP Server
//
// 将 BrowserMind 的智能探测能力包装为 MCP Server，
// 让任何 MCP 兼容的 LLM 客户端可以直接使用。
//
// 工具集：
//   基础操作: browser_navigate, browser_click, browser_type,
//             browser_snapshot, browser_evaluate, browser_scroll
//
//   高级探针: probe_page_structure, probe_interactive_elements,
//             probe_forms, probe_navigation, extract_data,
//             assert_state, explore_page
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import type { BrowserMindConfig, Probe } from '../types/index.js';
import { BrowserMind } from '../core/browserMind.js';
import { ProbeEngine } from '../core/probing/probeEngine.js';
import { ObservationBuilder } from '../core/observation/observationBuilder.js';
import { SafetyGuard } from '../core/safety/safetyGuard.js';
import { initLogger, closeLogger } from '../logging/logger.js';
import { disconnectDatabase } from '../db/prisma.js';
import { DEFAULT_CONFIG } from '../defaultConfig.js';
import http from 'node:http';
import type pino from 'pino';
import type { Page } from 'playwright';
import { chromium } from 'playwright';

export type TransportMode = 'stdio' | 'sse';

export interface MCPServerConfig {
  transport?: TransportMode;
  port?: number;
  host?: string;
  browserMind?: Partial<BrowserMindConfig>;
  enableBaseTools?: boolean;
  enableProbeTools?: boolean;
  enableExploreTools?: boolean;
}

// ============================================================
// 启动 MCP Server
// ============================================================

export async function startMCPServer(config: MCPServerConfig = {}): Promise<void> {
  const baseConfig = { ...DEFAULT_CONFIG, ...config.browserMind } as BrowserMindConfig;
  const logger = initLogger(baseConfig);
  logger.info({ transport: config.transport || 'stdio' }, 'Starting BrowserMind MCP Server');

  // 共享浏览器实例
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  // BrowserMind 核心组件
  const safetyGuard = new SafetyGuard(baseConfig.safety, logger);
  const observationBuilder = new ObservationBuilder(safetyGuard, logger);
  const probeEngine = new ProbeEngine(safetyGuard, logger);
  const bmConfig = baseConfig;

  // 注册内置探针
  registerBuiltinProbes(probeEngine);

  const server = new McpServer(
    { name: 'browser-mind', version: '1.0.0' },
    {
      capabilities: { tools: {}, logging: {} },
      instructions: [
        `BrowserMind MCP Server — Web 页面智能探测工具。`,
        ``,
        `你拥有两类工具：`,
        `1. **基础浏览器操作**（browser_*）— 导航、点击、输入、快照、执行JS`,
        `2. **高级探针工具**（probe_*）— 智能页面分析`,
        ``,
        `建议工作流：`,
        `1. browser_snapshot → 页面概览`,
        `2. probe_page_structure → 深入结构`,
        `3. probe_forms / probe_interactive_elements → 分析交互区域`,
        `4. browser_click / browser_type → 操作页面`,
        `5. assert_state → 验证结果`,
      ].join('\n'),
    }
  );

  // 注册工具
  if (config.enableBaseTools !== false) registerBaseTools(server, page, logger);
  if (config.enableProbeTools !== false) registerProbeTools(server, page, probeEngine, observationBuilder, logger);
  if (config.enableExploreTools !== false) registerExploreTools(server, bmConfig, safetyGuard, logger, page);

  // 根据配置选择传输模式
  const transportMode = config.transport || 'stdio';
  const port = config.port || 3100;

  if (transportMode === 'sse') {
    // SSE 模式：启动 HTTP 服务器
    const httpServer = http.createServer(async (req, res) => {
      const url = req.url || '';
      
      if (req.method === 'GET' && url === '/sse') {
        // SSE 端点：建立 Server-Sent Events 连接
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        const sseTransport = new SSEServerTransport('/message', res);
        await server.connect(sseTransport);
        await sseTransport.start();
        logger.info('SSE client connected');
        
        req.on('close', () => {
          logger.info('SSE client disconnected');
        });
      } else if (req.method === 'POST' && url.startsWith('/message')) {
        // 消息端点：接收来自客户端的 JSON-RPC 消息
        try {
          let body = '';
          req.on('data', (chunk: string) => { body += chunk; });
          req.on('end', async () => {
            try {
              const message = JSON.parse(body);
              // 查找对应的 SSE transport 并处理消息
              // 注意：简化实现，实际需要管理多个 transport 实例
              res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify({ status: 'ok' }));
            } catch {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
          });
        } catch (error: any) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: error.message }));
        }
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    httpServer.listen(port, () => {
      logger.info({ port, endpoint: '/sse' }, 'BrowserMind MCP Server (SSE) started');
      logger.info('Connect with: curl -N http://localhost:%d/sse', port);
    });

    // 优雅关闭（SSE 模式）
    const shutdownSSE = async () => {
      logger.info('Shutting down HTTP server...');
      await browser.close();
      httpServer.close();
      await closeLogger();
      await disconnectDatabase();
      process.exit(0);
    };
    process.on('SIGINT', shutdownSSE);
    process.on('SIGTERM', shutdownSSE);
  } else {
    // stdio 模式（默认）
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('BrowserMind MCP Server (stdio) started');

    // 优雅关闭（stdio 模式）
    const shutdownStdio = async () => {
      logger.info('Shutting down...');
      await browser.close();
      await closeLogger();
      await disconnectDatabase();
      process.exit(0);
    };
    process.on('SIGINT', shutdownStdio);
    process.on('SIGTERM', shutdownStdio);
  }
}

// ============================================================
// 基础浏览器工具
// ============================================================

function registerBaseTools(server: McpServer, page: Page, logger: pino.Logger): void {
  const log = logger.child({ group: 'base' });

  // browser_navigate
  server.registerTool('browser_navigate', {
    description: '导航到指定 URL',
    inputSchema: { url: z.string() },
  }, async ({ url }: { url: string }) => {
    log.info({ url }, 'Navigating');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    return { content: [{ type: 'text', text: `✅ 导航到 ${url} 成功` }] };
  });

  // browser_click
  server.registerTool('browser_click', {
    description: '点击页面元素，支持 selector / text / role / coordinates 四种定位方式',
    inputSchema: {
      selector: z.string().optional(),
      text: z.string().optional(),
      role: z.string().optional(),
      coordinates: z.object({ x: z.number(), y: z.number() }).optional(),
    },
  }, async (params: { selector?: string; text?: string; role?: string; coordinates?: { x: number; y: number } }) => {
    log.info({ params }, 'Clicking');
    const el = await resolveElement(page, params);
    if (!el) {
      return { content: [{ type: 'text', text: `❌ 未找到元素: ${JSON.stringify(params)}` }], isError: true };
    }
    // 坐标点击已由 resolveElement 直接执行，无需再操作元素
    if ((el as any).__coordinateClick) {
      const { x, y } = (el as any).__coordinateClick;
      return { content: [{ type: 'text', text: `✅ 坐标点击成功 (${x}, ${y})` }] };
    }
    await el.scrollIntoViewIfNeeded();
    await el.click({ timeout: 10000 });
    await page.waitForTimeout(500);
    return { content: [{ type: 'text', text: `✅ 点击成功` }] };
  });

  // browser_type
  server.registerTool('browser_type', {
    description: '在输入框中输入文本',
    inputSchema: {
      selector: z.string(),
      text: z.string(),
      clearFirst: z.boolean().optional().default(true),
    },
  }, async (params: { selector: string; text: string; clearFirst?: boolean }) => {
    const el = await page.$(params.selector);
    if (!el) {
      return { content: [{ type: 'text', text: `❌ 未找到输入框: ${params.selector}` }], isError: true };
    }
    if (params.clearFirst !== false) await el.fill('');
    await el.type(params.text, { delay: 10 });
    return { content: [{ type: 'text', text: `✅ 已输入: ${params.text.substring(0, 50)}${params.text.length > 50 ? '...' : ''}` }] };
  });

  // browser_snapshot
  server.registerTool('browser_snapshot', {
    description: '获取当前页面快照（截图 + 页面摘要）',
    inputSchema: {},
  }, async () => {
    const url = page.url();
    const title = await page.title();
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    const summary = await page.evaluate(() => ({
      interactiveElements: document.querySelectorAll('a, button, input, select, textarea').length,
      forms: document.querySelectorAll('form').length,
      links: document.querySelectorAll('a[href]').length,
      buttons: document.querySelectorAll('button, [role="button"]').length,
      inputs: document.querySelectorAll('input, textarea, select').length,
      images: document.querySelectorAll('img').length,
      visibleText: document.body.textContent?.trim().substring(0, 500) || '',
    }));
    return {
      content: [
        { type: 'text', text: `URL: ${url}\n标题: ${title}\n\n交互元素: ${summary.interactiveElements}\n表单: ${summary.forms}\n链接: ${summary.links}\n按钮: ${summary.buttons}\n输入框: ${summary.inputs}\n图片: ${summary.images}` },
        { type: 'image', data: screenshot.toString('base64'), mimeType: 'image/png' },
      ],
    };
  });

  // browser_evaluate
  server.registerTool('browser_evaluate', {
    description: '在页面中执行 JavaScript 代码（只读模式）',
    inputSchema: { script: z.string() },
  }, async (params: { script: string }) => {
    try {
      const result = await page.evaluate(params.script);
      const serialized = JSON.stringify(result, null, 2);
      const MAX_OUTPUT = 5000;
      if (serialized.length > MAX_OUTPUT) {
        return { content: [{ type: 'text', text: `执行结果 (已截断: ${serialized.length} > ${MAX_OUTPUT}):
${serialized.substring(0, MAX_OUTPUT)}` }] };
      }
      return { content: [{ type: 'text', text: `执行结果:
${serialized}` }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `❌ 执行错误: ${error.message}` }], isError: true };
    }
  });

  // browser_scroll
  server.registerTool('browser_scroll', {
    description: '滚动页面',
    inputSchema: {
      direction: z.enum(['up', 'down', 'left', 'right', 'top', 'bottom']).default('down'),
      amount: z.number().optional().default(300),
    },
  }, async (params: { direction: string; amount?: number }) => {
    const positions: Record<string, { x: number; y: number }> = {
      up: { x: 0, y: -(params.amount || 300) },
      down: { x: 0, y: params.amount || 300 },
      left: { x: -(params.amount || 300), y: 0 },
      right: { x: params.amount || 300, y: 0 },
      top: { x: 0, y: 0 },
      bottom: { x: 0, y: 99999 },
    };
    const target = positions[params.direction] || positions.down;
    await page.evaluate(({ x, y }) => window.scrollTo(x, y), target);
    await page.waitForTimeout(300);
    return { content: [{ type: 'text', text: `✅ 已滚动: ${params.direction}` }] };
  });
}

// ============================================================
// 高级探针工具
// ============================================================

function registerProbeTools(
  server: McpServer,
  page: Page,
  probeEngine: ProbeEngine,
  observationBuilder: ObservationBuilder,
  logger: pino.Logger
): void {
  const log = logger.child({ group: 'probe' });

  // probe_page_structure
  server.registerTool('probe_page_structure', {
    description: '获取页面的语义化 DOM 结构。返回压缩后的 DOM 树，包含语义标签、交互元素、可见性等。比原始 HTML 更适合 LLM 理解页面布局。',
    inputSchema: {},
  }, async () => {
    const obs = await observationBuilder.buildObservation(page);
    return {
      content: [{
        type: 'text',
        text: [
          `## 页面结构`,
          `URL: ${obs.url}`,
          `标题: ${obs.title}`,
          ``,
          `### 页面摘要`,
          JSON.stringify(obs.summary, null, 2),
          ``,
          `### 交互热点`,
          ...obs.hotSpots.map((h, i) => `${i + 1}. [${h.rect.x},${h.rect.y} - ${h.rect.w}x${h.rect.h}] ${h.description} (${h.elementCount}个元素)`),
          ``,
          `### DOM 结构`,
          JSON.stringify(obs.pageStructure, null, 2).substring(0, 8000),
        ].join('\n'),
      }],
    };
  });

  // probe_interactive_elements
  server.registerTool('probe_interactive_elements', {
    description: '获取页面所有可交互元素（按钮、链接、输入框等）的详细信息',
    inputSchema: { maxResults: z.number().optional().default(50) },
  }, async (params: { maxResults?: number }) => {
    const result = await probeEngine.execute(page, { probeName: 'getInteractiveElements', args: { maxResults: params.maxResults || 50 } });
    if (!result.success) return { content: [{ type: 'text', text: `❌ 探测失败: ${result.error}` }], isError: true };
    const items = Array.isArray(result.rawResult) ? result.rawResult : [];
    return { content: [{ type: 'text', text: `## 可交互元素 (${items.length}个)\n\n${JSON.stringify(items, null, 2).substring(0, 8000)}` }] };
  });

  // probe_forms
  server.registerTool('probe_forms', {
    description: '探测页面所有表单的字段结构、校验规则、提交按钮等详细信息',
    inputSchema: {},
  }, async () => {
    const result = await probeEngine.execute(page, { probeName: 'getForms' });
    if (!result.success) return { content: [{ type: 'text', text: `❌ 探测失败: ${result.error}` }], isError: true };
    const forms = Array.isArray(result.rawResult) ? result.rawResult : [];
    if (forms.length === 0) return { content: [{ type: 'text', text: '页面未发现表单' }] };
    const report = forms.map((f: any, i: number) => [
      `### 表单 ${i + 1}`,
      `操作: ${f.action}`,
      `方法: ${f.method}`,
      `字段:`,
      ...(f.fields || []).map((fd: any) =>
        `  - ${fd.name || '(未命名)'} [${fd.type}]${fd.required ? ' *必填' : ''}${fd.disabled ? ' [禁用]' : ''}${fd.placeholder ? ` 提示: "${fd.placeholder}"` : ''}`
      ),
      `提交按钮: ${f.submitButton ? f.submitButton.text : '未发现'}`,
    ].join('\n'));
    return { content: [{ type: 'text', text: `## 表单结构 (${forms.length}个)\n\n${report.join('\n\n')}` }] };
  });

  // probe_navigation
  server.registerTool('probe_navigation', {
    description: '获取页面导航菜单结构',
    inputSchema: {},
  }, async () => {
    const result = await probeEngine.execute(page, { probeName: 'getNavigation' });
    if (!result.success) return { content: [{ type: 'text', text: `❌ 探测失败: ${result.error}` }], isError: true };
    return { content: [{ type: 'text', text: `## 导航结构\n\n${JSON.stringify(result.rawResult, null, 2).substring(0, 8000)}` }] };
  });

  // extract_data
  server.registerTool('extract_data', {
    description: '智能提取页面数据，支持 text(全文搜索)/regex(正则)/selector(CSS选择器) 三种方式',
    inputSchema: {
      pattern: z.string(),
      method: z.enum(['text', 'regex', 'selector']).default('text'),
    },
  }, async (params: { pattern: string; method: string }) => {
    try {
      let result: unknown;
      if (params.method === 'text') {
        result = await page.evaluate((p: string) => {
          const regex = new RegExp(p, 'gi');
          return Array.from(new Set((document.body.textContent || '').match(regex) || [])).slice(0, 100);
        }, params.pattern);
      } else if (params.method === 'regex') {
        result = await page.evaluate((p: string) => {
          const regex = new RegExp(p, 'gi');
          const matches: string[] = [];
          let m;
          while ((m = regex.exec(document.body.textContent || '')) !== null && matches.length < 100) {
            matches.push(m[0]);
          }
          return matches;
        }, params.pattern);
      } else {
        const elements = await page.$$(params.pattern);
        result = await Promise.all(elements.slice(0, 50).map(async (el) => ({
          tag: await el.evaluate((node) => node.tagName),
          text: await el.textContent().then((t) => t?.trim().substring(0, 200)),
        })));
      }
      return { content: [{ type: 'text', text: `## 提取结果 (${params.method})\n模式: ${params.pattern}\n\n${JSON.stringify(result, null, 2).substring(0, 5000)}` }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `❌ 提取失败: ${error.message}` }], isError: true };
    }
  });

  // assert_state
  server.registerTool('assert_state', {
    description: '断言页面当前状态是否满足指定条件',
    inputSchema: {
      condition: z.string(),
      actualFrom: z.enum(['url', 'title', 'text', 'count']).default('text'),
      selector: z.string().optional(),
      expected: z.string().optional(),
    },
  }, async (params: { condition: string; actualFrom: string; selector?: string; expected?: string }) => {
    let actual: unknown;
    if (params.actualFrom === 'url') actual = page.url();
    else if (params.actualFrom === 'title') actual = await page.title();
    else if (params.actualFrom === 'count') actual = params.selector ? await page.$$(params.selector).then(e => e.length) : 0;
    else {
      if (params.selector) {
        const el = await page.$(params.selector);
        actual = el ? await el.textContent().then(t => t?.trim()) : null;
      } else {
        actual = await page.evaluate(() => document.body.textContent?.trim().substring(0, 1000));
      }
    }
    const passed = !params.expected || String(actual) === params.expected;
    const icon = passed ? '✅' : '❌';
    return {
      content: [{
        type: 'text',
        text: `## 断言结果: ${icon}\n条件: ${params.condition}\n实际值: ${actual}\n期望值: ${params.expected || '(未指定)'}`,
      }],
    };
  });
}

// ============================================================
// 探索工具
// ============================================================

function registerExploreTools(
  server: McpServer,
  config: BrowserMindConfig,
  safetyGuard: SafetyGuard,
  logger: pino.Logger,
  sharedPage?: Page  // 可选共享页面，避免创建新浏览器
): void {
  server.registerTool('explore_page', {
    description: '自动多步探索当前页面，分析页面功能结构，返回完整探索报告。使用共享浏览器实例，避免资源泄漏。',
    inputSchema: {
      goal: z.string().default('全面了解当前页面'),
      url: z.string().optional(),
      maxSteps: z.number().optional().default(10),
    },
  }, async (params: { goal: string; url?: string; maxSteps?: number }) => {
    const sessionConfig = {
      ...config,
      session: { ...config.session, maxSteps: params.maxSteps || 10 },
      llm: { ...config.llm },
    } as BrowserMindConfig;
    const mind = new BrowserMind(sessionConfig);
    try {
      // 使用共享页面（避免每次创建新浏览器实例）
      const result = await mind.run(params.goal, params.url, sharedPage);
      const report = [
        `# 探索报告`,
        `目标: ${params.goal}`,
        `状态: ${result.status}`,
        `步数: ${result.totalSteps}`,
        `耗时: ${(result.totalDuration / 1000).toFixed(1)}s`,
        ``,
        `## 总结`,
        result.summary || '无总结',
        ``,
        `## 观测记录`,
        ...result.observations.map((obs, i) => {
          const fb = obs.lastActionFeedback;
          return `### 第${i + 1}次 ${fb ? (fb.success ? '✅' : '❌') : '📋'}\nURL: ${obs.url}\n交互元素: ${obs.summary.interactiveElements} | 表单: ${obs.summary.forms} | 链接: ${obs.summary.links}`;
        }),
      ].join('\n');
      return { content: [{ type: 'text', text: report }] };
    } finally {
      // 注意：不使用 mind.shutdown()，因为 run() 的 finally 已调用 cleanup()，
      // 且 shutdown() 会断开全局 logger/database 连接（其他工具仍需使用）。
      // BrowserMind 实例会由 GC 回收。
    }
  });
}

// ============================================================
// 辅助函数
// ============================================================

async function resolveElement(page: Page, params: { selector?: string; text?: string; role?: string; coordinates?: { x: number; y: number } }): Promise<any> {
  // 坐标点击优先处理（直接执行点击并返回标记对象而非 null）
  if (params.coordinates) {
    const { x, y } = params.coordinates;
    await page.mouse.click(x, y);
    await page.waitForTimeout(300);
    // 返回一个特殊标记，调用方据此跳过 scrollIntoView/click
    return { __coordinateClick: true, x, y };
  }

  // 按 selector 查找
  if (params.selector) {
    const el = await page.$(params.selector);
    if (el) return el;
  }

  // 按 text 匹配
  if (params.text) {
    const loc = page.locator(`text=${params.text}`).first();
    if (await loc.count() > 0) return loc.elementHandle();
  }

  // 按 role 匹配
  if (params.role) {
    const loc = page.locator(`[role="${params.role}"]`).first();
    if (await loc.count() > 0) return loc.elementHandle();
  }

  return null;
}

function registerBuiltinProbes(probeEngine: ProbeEngine): void {
  const probes: Probe[] = [
    {
      name: 'getInteractiveElements',
      description: '获取所有可交互元素',
      outputType: 'json',
      readonly: true,
      script: `(args) => {
        const max = args?.maxResults || 50;
        const all = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])');
        return Array.from(all).slice(0, max).map(el => ({
          tag: el.tagName,
          type: el.getAttribute('type'),
          text: el.textContent?.trim().substring(0, 100),
          href: el.getAttribute('href'),
          name: el.getAttribute('name'),
          placeholder: el.getAttribute('placeholder'),
          disabled: el.disabled || false,
          visible: el.offsetWidth > 0 && el.offsetHeight > 0,
          rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
        }));
      }`,
    },
    {
      name: 'getForms',
      description: '获取页面表单结构',
      outputType: 'json',
      readonly: true,
      script: `(args) => {
        const forms = document.querySelectorAll('form');
        return Array.from(forms).slice(0, 10).map(form => ({
          action: form.action,
          method: form.method,
          id: form.id,
          fields: Array.from(form.querySelectorAll('input, select, textarea')).slice(0, 20).map(f => ({
            name: f.getAttribute('name'),
            type: f.getAttribute('type') || f.tagName.toLowerCase(),
            required: f.hasAttribute('required'),
            placeholder: f.getAttribute('placeholder'),
            value: f.value ? f.value.substring(0, 50) : undefined,
            disabled: f.disabled || false,
            options: f.tagName === 'SELECT' ? Array.from(f.querySelectorAll('option')).map(o => ({ value: o.value, text: o.textContent })) : undefined,
          })),
          submitButton: (() => {
            const btn = form.querySelector('button[type="submit"], input[type="submit"]');
            return btn ? { text: btn.textContent?.trim(), type: btn.getAttribute('type') } : undefined;
          })(),
        }));
      }`,
    },
    {
      name: 'getNavigation',
      description: '获取页面导航结构',
      outputType: 'json',
      readonly: true,
      script: `(args) => {
        const navs = document.querySelectorAll('nav, [role="navigation"], header nav, .nav, .navbar, .menu');
        return Array.from(navs).slice(0, 5).map(nav => ({
          tag: nav.tagName,
          role: nav.getAttribute('role'),
          links: Array.from(nav.querySelectorAll('a')).slice(0, 30).map(a => ({
            text: a.textContent?.trim().substring(0, 50),
            href: a.href,
            active: a.classList.contains('active') || a.getAttribute('aria-current') === 'page',
          })),
        }));
      }`,
    },
  ];
  probeEngine.registerMany(probes);
}

// ============================================================
// CLI 入口
// ============================================================

/**
 * 解析 CLI 参数并启动 MCP Server
 *
 * 支持参数:
 *   --transport <stdio|sse>  传输模式（默认: stdio）
 *   --port <number>          SSE 端口（默认: 3100）
 *   --help                   显示帮助
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  // 解析参数
  const transportIdx = args.indexOf('--transport');
  const portIdx = args.indexOf('--port');
  
  await startMCPServer({
    transport: transportIdx >= 0 ? (args[transportIdx + 1] as TransportMode || 'stdio') : 'stdio',
    port: portIdx >= 0 ? parseInt(args[portIdx + 1] || '3100', 10) : 3100,
  });
}

if (process.argv[1]?.includes('mcpServer') || process.argv[1]?.includes('cli')) {
  main().catch((error) => {
    console.error('BrowserMind MCP Server failed:', error);
    process.exit(1);
  });
}
