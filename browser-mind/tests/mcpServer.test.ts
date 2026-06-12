// ============================================================
// BrowserMind 核心单元测试
//
// 测试路径：
// 1. MCP Server 启动和工具注册
// 2. SafetyGuard 安全审核（动作审核、脚本审核、数据脱敏、死锁检测）
// 3. ObservationBuilder DOM 压缩
// 4. ProbeEngine 注册和执行
// 5. ActionPlanner 意图解析
// 6. 基础浏览器操作（navigate / click / type / extract / scroll）
// ============================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { chromium } from 'playwright';
import type { Page, Browser } from 'playwright';
import { SafetyGuard } from '../src/core/safety/safetyGuard.js';
import { ObservationBuilder } from '../src/core/observation/observationBuilder.js';
import { ProbeEngine } from '../src/core/probing/probeEngine.js';
import { ActionPlanner } from '../src/core/planning/actionPlanner.js';
import type { Action, SessionContext, SafetyConfig } from '../src/types/index.js';
import pino from 'pino';

// ---------- 共享测试数据 ----------
const testLogger = pino({ level: 'silent' });

const defaultSafetyConfig: SafetyConfig = {
  maxStepsPerSession: 30,
  maxConcurrentSessions: 3,
  actionTimeoutMs: 15000,
  readonlyMode: true,
  allowedApis: ['document.querySelector'],
  blockedApis: ['eval', 'innerHTML', 'document.write'],
  maxScriptReturnSize: 102400,
  sensitivePatterns: ['sk-[a-zA-Z0-9]{20,}'],
  maskFields: ['password', 'token', 'secret'],
  allowedOrigins: [],
  blockCrossOrigin: true,
  scriptTimeoutMs: 5000,
  maxStringLength: 5000,
};

function createMockContext(overrides?: Partial<SessionContext>): SessionContext {
  return {
    sessionId: 'test-session',
    status: 'RUNNING',
    config: {} as any,
    stepNumber: 0,
    startTime: Date.now(),
    lastActivity: Date.now(),
    actionHistory: [],
    observationHistory: [],
    metadata: {},
    ...overrides,
  } as SessionContext;
}

// ============================================================
// SafetyGuard 测试
// ============================================================
describe('SafetyGuard', () => {
  let guard: SafetyGuard;

  beforeEach(() => {
    guard = new SafetyGuard(defaultSafetyConfig, testLogger);
  });

  describe('auditAction', () => {
    it('should allow read actions in readonly mode', () => {
      const action: Action = {
        type: 'snapshot',
        params: { type: 'full' },
        description: 'take snapshot',
      };
      const result = guard.auditAction(action, createMockContext());
      expect(result.passed).toBe(true);
      expect(result.action).toBe('allow');
    });

    it('should block write actions in readonly mode', () => {
      const action: Action = {
        type: 'type',
        params: { selector: 'input', text: 'hello' },
        description: 'type text',
      };
      const result = guard.auditAction(action, createMockContext());
      expect(result.passed).toBe(false);
      expect(result.action).toBe('block');
    });

    it('should block click in readonly mode', () => {
      const action: Action = {
        type: 'click',
        params: { text: 'button' },
        description: 'click button',
      };
      const result = guard.auditAction(action, createMockContext());
      expect(result.passed).toBe(false);
      expect(result.action).toBe('block');
    });

    it('should terminate when maxSteps exceeded', () => {
      const action: Action = {
        type: 'snapshot',
        params: {},
        description: 'snapshot',
      };
      const context = createMockContext({ stepNumber: 999 });
      const result = guard.auditAction(action, context);
      expect(result.passed).toBe(false);
      expect(result.action).toBe('terminate');
    });

    it('should block navigation to disallowed protocol', () => {
      const action: Action = {
        type: 'navigate',
        params: { url: 'javascript:alert(1)' },
        description: 'xss attempt',
      };
      const result = guard.auditAction(action, createMockContext());
      expect(result.passed).toBe(false);
      expect(result.action).toBe('block');
    });
  });

  describe('auditScript', () => {
    it('should allow safe scripts', () => {
      const result = guard.auditScript('document.querySelectorAll("a")');
      expect(result.passed).toBe(true);
    });

    it('should block scripts with eval', () => {
      const result = guard.auditScript('eval("alert(1)")');
      expect(result.passed).toBe(false);
      expect(result.action).toBe('block');
    });

    it('should block innerHTML assignment', () => {
      const result = guard.auditScript('el.innerHTML = "<script>alert(1)</script>"');
      expect(result.passed).toBe(false);
    });

    it('should block document.write', () => {
      const result = guard.auditScript('document.write("hello")');
      expect(result.passed).toBe(false);
    });

    it('should block scripts with too many loops', () => {
      const result = guard.auditScript(`
        for (let i = 0; i < 10; i++) {}
        for (let j = 0; j < 10; j++) {}
        for (let k = 0; k < 10; k++) {}
        for (let l = 0; l < 10; l++) {}
      `);
      expect(result.passed).toBe(false);
      expect(result.action).toBe('block');
    });
  });

  describe('sanitizeOutput', () => {
    it('should mask sensitive fields in objects', () => {
      const data = { username: 'admin', password: 'supersecret', token: 'abc123' };
      const sanitized = guard.sanitizeOutput(data) as Record<string, unknown>;
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.token).toBe('[REDACTED]');
      expect(sanitized.username).toBe('admin');
    });

    it('should mask sensitive patterns in strings', () => {
      const result = guard.sanitizeOutput('my api key is sk-12345678901234567890');
      expect(result).not.toContain('sk-12345678901234567890');
    });

    it('should recursively sanitize arrays', () => {
      const data = [{ password: 'secret1' }, { password: 'secret2' }];
      const sanitized = guard.sanitizeOutput(data) as Array<Record<string, unknown>>;
      expect(sanitized[0].password).toBe('[REDACTED]');
      expect(sanitized[1].password).toBe('[REDACTED]');
    });

    it('should handle primitives', () => {
      expect(guard.sanitizeOutput(42)).toBe(42);
      expect(guard.sanitizeOutput('hello')).toBe('hello');
      expect(guard.sanitizeOutput(null)).toBe(null);
    });
  });

  describe('circuit breaker', () => {
    it('should open after threshold failures', () => {
      for (let i = 0; i < 5; i++) {
        guard.recordFailure();
      }
      const action: Action = { type: 'snapshot', params: {}, description: 'test' };
      const result = guard.auditAction(action, createMockContext());
      expect(result.passed).toBe(false);
      expect(result.message).toContain('Circuit breaker');
    });

    it('should close after successful action', () => {
      for (let i = 0; i < 4; i++) guard.recordFailure();
      guard.recordSuccess();
      const action: Action = { type: 'snapshot', params: {}, description: 'test' };
      const result = guard.auditAction(action, createMockContext());
      expect(result.passed).toBe(true);
    });
  });

  describe('deadlock detection', () => {
    it('should not detect deadlock on first steps', () => {
      const result = guard.checkDeadlock('10|2|3', 'https://example.com', 3);
      expect(result.deadlocked).toBe(false);
    });

    it('should detect deadlock when state is unchanged for enough steps', () => {
      // 前 5 步：第 1 步 urlChanged=true，从第 2 步起稳定
      for (let i = 0; i < 5; i++) {
        const result = guard.checkDeadlock('10|2|3', 'https://example.com', 3);
        expect(result.deadlocked).toBe(false);
      }
      // 第 6 步：最近 5 步全部 urlChanged=false，应判定死锁
      const result = guard.checkDeadlock('10|2|3', 'https://example.com', 3);
      expect(result.deadlocked).toBe(true);
    });

    it('should not detect deadlock when URL changes', () => {
      const states = [
        { summary: '10|2|3', url: 'https://example.com/page1', hotSpots: 3 },
        { summary: '10|2|3', url: 'https://example.com/page2', hotSpots: 3 },
        { summary: '10|2|3', url: 'https://example.com/page3', hotSpots: 3 },
        { summary: '10|2|3', url: 'https://example.com/page4', hotSpots: 3 },
        { summary: '10|2|3', url: 'https://example.com/page5', hotSpots: 3 },
      ];
      for (const s of states) {
        const result = guard.checkDeadlock(s.summary, s.url, s.hotSpots);
        expect(result.deadlocked).toBe(false);
      }
    });
  });
});

// ============================================================
// ActionPlanner 测试
// ============================================================
describe('ActionPlanner', () => {
  let planner: ActionPlanner;

  beforeEach(() => {
    planner = new ActionPlanner(testLogger);
  });

  it('should detect completion intent', () => {
    const result = planner.parseIntent('完成', createMockContext({ stepNumber: 1 }));
    expect(result.isComplete).toBe(true);
  });

  it('should generate exploration plan on first step', () => {
    const result = planner.parseIntent('探索页面结构', createMockContext({ stepNumber: 0 }));
    expect(result.isComplete).toBe(false);
    expect(result.actions.length).toBeGreaterThan(0);
  });

  it('should mark complete when max depth reached', () => {
    const result = planner.parseIntent('探索', createMockContext({ stepNumber: 10 }));
    expect(result.isComplete).toBe(true);
  });

  it('should parse single commands with / prefix', () => {
    const result = planner.parseIntent('/click #button', createMockContext({ stepNumber: 0 }));
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].type).toBe('click');
  });

  it('should detect assertion intent', () => {
    const result = planner.parseIntent('assert 标题包含Hello', createMockContext({ stepNumber: 1 }));
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].type).toBe('assert');
  });
});

// ============================================================
// ObservationBuilder + Playwright 集成测试
// ============================================================
describe('ObservationBuilder (Playwright)', () => {
  let browser: Browser;
  let page: Page;
  let builder: ObservationBuilder;
  let guard: SafetyGuard;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
    guard = new SafetyGuard(defaultSafetyConfig, testLogger);
    builder = new ObservationBuilder(guard, testLogger);
  });

  afterAll(async () => {
    await browser.close();
  });

  it('should build minimal observation on blank page', async () => {
    await page.goto('about:blank');
    const obs = await builder.buildObservation(page);
    expect(obs.url).toBe('about:blank');
    expect(obs.title).toBe('');
    expect(obs.summary).toBeDefined();
    expect(obs.pageStructure).toBeDefined();
    expect(obs.pageStructure.tag).toBe('body');
  });

  it('should detect interactive elements on a form page', async () => {
    await page.setContent(`
      <html><body>
        <form>
          <input name="user" required />
          <button type="submit">Submit</button>
          <a href="/">Home</a>
        </form>
      </body></html>
    `);
    const obs = await builder.buildObservation(page);
    expect(obs.summary.interactiveElements).toBeGreaterThanOrEqual(3);
    expect(obs.summary.forms).toBe(1);
    expect(obs.summary.links).toBe(1);
  });

  it('should detect hot spots in dense interactive areas', async () => {
    await page.setContent(`
      <html><body>
        <nav>
          <a href="/a">A</a>
          <a href="/b">B</a>
          <a href="/c">C</a>
          <a href="/d">D</a>
          <button>Menu</button>
        </nav>
      </body></html>
    `);
    const obs = await builder.buildObservation(page);
    // nav 区域应被识别为热点（包含多个交互元素）
    expect(obs.hotSpots.length).toBeGreaterThanOrEqual(1);
    expect(obs.hotSpots[0].elementCount).toBeGreaterThanOrEqual(4);
  });
});

// ============================================================
// ProbeEngine 测试
// ============================================================
describe('ProbeEngine', () => {
  let engine: ProbeEngine;
  let guard: SafetyGuard;

  beforeEach(() => {
    guard = new SafetyGuard(defaultSafetyConfig, testLogger);
    engine = new ProbeEngine(guard, testLogger);
  });

  it('should register and list probes', () => {
    engine.register({
      name: 'testProbe',
      description: 'A test probe',
      script: '() => ({ result: "ok" })',
      outputType: 'json',
      readonly: true,
    });
    const probes = engine.listProbes();
    expect(probes.length).toBe(1);
    expect(probes[0].name).toBe('testProbe');
  });

  it('should report error for unknown probe', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('about:blank');

    const result = await engine.execute(page, { probeName: 'nonexistent' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown probe');

    await browser.close();
  });

  it('should block probes with unsafe scripts', async () => {
    engine.register({
      name: 'unsafeProbe',
      description: 'Unsafe probe',
      script: '() => { eval("alert(1)"); }',
      outputType: 'json',
      readonly: true,
    });

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('about:blank');

    const result = await engine.execute(page, { probeName: 'unsafeProbe' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Safety guard blocked');

    await browser.close();
  });

  it('should register multiple probes at once', () => {
    engine.registerMany([
      { name: 'p1', description: 'p1', script: '() => 1', outputType: 'json', readonly: true },
      { name: 'p2', description: 'p2', script: '() => 2', outputType: 'json', readonly: true },
    ]);
    expect(engine.listProbes().length).toBe(2);
  });
});

// ============================================================
// MCP Server 元信息测试
// ============================================================
describe('MCP Server Metadata', () => {
  it('should create an MCP server with correct metadata', () => {
    const server = new McpServer(
      { name: 'browser-mind', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    expect(server).toBeDefined();
    // 验证 server 有 registerTool 方法（SDK v1.29+）
    expect(typeof (server as any).registerTool).toBe('function');
  });
});

// ============================================================
// Playwright 集成测试（保留原有测试）
// ============================================================
describe('Playwright Integration', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('should navigate to a page and capture snapshot', async () => {
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    const url = page.url();
    expect(url).toBe('about:blank');
  });

  it('should handle click and type actions', async () => {
    await page.setContent(`
      <html>
      <body>
        <input id="search" type="text" placeholder="搜索..." />
        <button id="btn">搜索</button>
        <div id="result"></div>
        <script>
          document.getElementById('btn')?.addEventListener('click', () => {
            const val = document.getElementById('search').value;
            document.getElementById('result').textContent = '搜索: ' + val;
          });
        </script>
      </body>
      </html>
    `);

    const input = await page.$('#search');
    expect(input).toBeTruthy();
    await input!.fill('BrowserMind');

    const btn = await page.$('#btn');
    expect(btn).toBeTruthy();
    await btn!.click();

    const result = await page.$('#result');
    const text = await result?.textContent();
    expect(text).toBe('搜索: BrowserMind');
  });

  it('should extract data from page', async () => {
    await page.setContent(`
      <html>
      <body>
        <table>
          <tr><td>Alice</td><td>30</td></tr>
          <tr><td>Bob</td><td>25</td></tr>
          <tr><td>Charlie</td><td>35</td></tr>
        </table>
        <div class="price">$19.99</div>
        <div class="price">$29.99</div>
      </body>
      </html>
    `);

    const rows = await page.$$('table tr');
    expect(rows.length).toBe(3);

    const prices = await page.$$('.price');
    expect(prices.length).toBe(2);
    const firstPrice = await prices[0]?.textContent();
    expect(firstPrice?.trim()).toBe('$19.99');
  });

  it('should handle page scroll', async () => {
    await page.setContent(`
      <html><body style="height: 3000px">
        <div id="top" style="position:absolute;top:0">TOP</div>
        <div id="bottom" style="position:absolute;top:2900px">BOTTOM</div>
      </body></html>
    `);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(100);

    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeGreaterThan(0);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);

    const scrollY2 = await page.evaluate(() => window.scrollY);
    expect(scrollY2).toBe(0);
  });
});
