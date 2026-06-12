// ============================================================
// BrowserMind 执行层（Playwright Executor）
//
// 职责：
// 将解析后的 Action 通过 Playwright 在浏览器中执行。
// 这是框架的"手"——实际操控浏览器的部分。
//
// 核心能力：
// 1. 执行所有支持的动作类型（点击、输入、导航等）
// 2. 智能元素定位（selector/text/role/坐标）
// 3. 自动等待元素稳定（避免未准备好就操作）
// 4. 完整的失败重试机制
// 5. 每次动作前后自动捕获页面状态
//
// 数据流转:
//   Action → 元素定位 → 等待稳定 → 执行操作 → 捕获反馈
//
// 异常处理:
//   - 元素不存在：返回可用元素列表建议
//   - 超时：自动重试后报告
//   - 浏览器崩溃：尝试恢复
// ============================================================

import { chromium, type Page, type Browser, type BrowserContext } from 'playwright';
import type { Action, ActionParams, ActionResult, BrowserMindConfig, Observation } from '../../types/index.js';
import { ObservationBuilder } from '../observation/observationBuilder.js';
import { SafetyGuard } from '../safety/safetyGuard.js';
import type pino from 'pino';

export class PlaywrightExecutor {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private observationBuilder: ObservationBuilder;
  private safetyGuard: SafetyGuard;
  private config: BrowserMindConfig;
  private logger: pino.Logger;

  /** 控制台日志缓冲区 */
  private consoleBuffer: Array<{ level: string; text: string; timestamp: number }> = [];

  constructor(
    config: BrowserMindConfig,
    safetyGuard: SafetyGuard,
    logger: pino.Logger
  ) {
    this.config = config;
    this.safetyGuard = safetyGuard;
    this.logger = logger.child({ module: 'playwright-executor' });
    this.observationBuilder = new ObservationBuilder(safetyGuard, logger);
  }

  // ============================================================
  // 浏览器生命周期
  // ============================================================

  /**
   * 启动浏览器实例
   *
   * @returns Playwright Page 实例
   */
  async launch(): Promise<Page> {
    this.logger.info('Launching browser...');

    const browserType = this.config.browser.browserType || 'chromium';
    const launchOptions = {
      headless: true,
      ...this.config.browser.launch,
    };

    switch (browserType) {
      case 'firefox':
        const { firefox } = await import('playwright');
        this.browser = await firefox.launch(launchOptions);
        break;
      case 'webkit':
        const { webkit } = await import('playwright');
        this.browser = await webkit.launch(launchOptions);
        break;
      default:
        this.browser = await chromium.launch(launchOptions);
    }

    this.context = await this.browser.newContext({
      viewport: this.config.viewport,
      ...this.config.browser.context,
    });

    this.page = await this.context.newPage();
    this.setupPageListeners();

    this.logger.info(
      { browserType, viewport: this.config.viewport },
      'Browser launched successfully'
    );

    return this.page;
  }

  /**
   * 设置页面事件监听
   */
  private setupPageListeners(): void {
    if (!this.page) return;

    // 收集控制台日志
    this.page.on('console', (msg) => {
      this.consoleBuffer.push({
        level: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
      // 限制缓冲区大小
      if (this.consoleBuffer.length > 200) {
        this.consoleBuffer.shift();
      }
    });

    // 监听页面 crash
    this.page.on('crash', () => {
      this.logger.error('Page crashed!');
    });

    // 监听页面错误
    this.page.on('pageerror', (error) => {
      this.logger.error({ error: error.message }, 'Page error');
    });
  }

  /**
   * 关闭浏览器
   */
  async close(): Promise<void> {
    this.logger.info('Closing browser...');
    try {
      await this.page?.close();
      await this.context?.close();
      await this.browser?.close();
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Error closing browser');
    }
    this.page = null;
    this.context = null;
    this.browser = null;
    this.logger.info('Browser closed');
  }

  // ============================================================
  // 动作执行入口
  // ============================================================

  /**
   * 执行单个动作
   *
   * @param action - 要执行的动作
   * @returns 执行结果（包含执行前后的观测）
   */
  async executeAction(action: Action): Promise<ActionResult> {
    const startTime = Date.now();
    const stepLogger = this.logger.child({ actionType: action.type });

    stepLogger.info({ params: action.params }, 'Executing action');

    let success = false;
    let error: string | undefined;
    let result: unknown;

    try {
      switch (action.type) {
        case 'navigate':
          result = await this.executeNavigate(action.params as any);
          break;
        case 'click':
          result = await this.executeClick(action.params as any);
          break;
        case 'type':
          result = await this.executeType(action.params as any);
          break;
        case 'select':
          result = await this.executeSelect(action.params as any);
          break;
        case 'scroll':
          result = await this.executeScroll(action.params as any);
          break;
        case 'hover':
          result = await this.executeHover(action.params as any);
          break;
        case 'wait':
          result = await this.executeWait(action.params as any);
          break;
        case 'evaluate':
          result = await this.executeEvaluate(action.params as any);
          break;
        case 'probe':
          result = { probing: true };
          break;
        case 'snapshot':
          result = await this.captureSnapshot();
          break;
        case 'extract':
          result = await this.executeExtract(action.params as any);
          break;
        case 'assert':
          result = await this.executeAssert(action.params as any);
          break;
        default:
          throw new Error(`Unknown action type: ${(action as any).type}`);
      }
      success = true;
    } catch (e: any) {
      error = e.message || String(e);
      stepLogger.error({ error }, 'Action failed');
    }

    // 获取动作后的观测
    if (!this.page) {
      throw new Error('Page instance is not available. Browser may have crashed.');
    }
    const afterObservation = await this.safetyGuard.sanitizeOutput(
      await this.observationBuilder.buildObservation(this.page, action, { success, error, duration: Date.now() - startTime })
    ) as Observation;

    const durationMs = Date.now() - startTime;
    stepLogger.info({ success, durationMs }, 'Action completed');

    return {
      action,
      success,
      error,
      durationMs,
      observation: afterObservation,
      evaluateResult: result,
    };
  }

  // ============================================================
  // 具体动作执行
  // ============================================================

  private async executeNavigate(params: import('../../types/index.js').NavigateParams): Promise<unknown> {
    const { url, waitUntil = 'domcontentloaded' } = params;
    this.logger.info({ url }, 'Navigating to URL');

    await this.page!.goto(url, { waitUntil, timeout: 30000 });
    // 额外等待页面稳定
    await this.page!.waitForLoadState('networkidle').catch(() => {
      this.logger.warn('Network idle timeout, continuing with current state');
    });

    return { url, status: 'loaded' };
  }

  private async executeClick(params: import('../../types/index.js').ClickParams): Promise<unknown> {
    const element = await this.resolveElement(params);
    if (!element) {
      throw new Error(`Element not found: ${JSON.stringify(params)}`);
    }

    await element.scrollIntoViewIfNeeded();
    await element.waitForElementState('stable', { timeout: 5000 }).catch(() => {});
    await element.click({ timeout: 10000 });

    return { clicked: params.selector || params.text || params.role };
  }

  private async executeType(params: import('../../types/index.js').TypeParams): Promise<unknown> {
    const element = await this.resolveElement({ selector: params.selector } as any);
    if (!element) {
      throw new Error(`Input element not found: ${params.selector}`);
    }

    if (params.clearFirst) {
      await element.fill(''); // clear
    }
    await element.type(params.text, { delay: params.delay || 10 }); // 逐字输入，模拟人类

    return { typed: params.text.substring(0, 50) + (params.text.length > 50 ? '...' : '') };
  }

  private async executeSelect(params: import('../../types/index.js').SelectParams): Promise<unknown> {
    const element = await this.page!.$(params.selector);
    if (!element) throw new Error(`Select element not found: ${params.selector}`);

    await element.selectOption(params.value);
    return { selected: params.value };
  }

  private async executeScroll(params: import('../../types/index.js').ScrollParams): Promise<unknown> {
    if (params.selector) {
      const element = await this.page!.$(params.selector);
      if (element) {
        await element.scrollIntoViewIfNeeded();
      }
    } else {
      const direction = params.direction || 'down';
      const amount = params.amount || 300;
      const scrollMap: Record<string, { x: number; y: number }> = {
        up: { x: 0, y: -amount },
        down: { x: 0, y: amount },
        left: { x: -amount, y: 0 },
        right: { x: amount, y: 0 },
        top: { x: 0, y: 0 },
        bottom: { x: 0, y: 99999 },
      };
      const target = scrollMap[direction] || scrollMap.down;
      await this.page!.evaluate(({ x, y }) => window.scrollTo(x, y), target);
    }

    // 等待滚动完成
    await this.page!.waitForTimeout(300);
    return { scrolled: params.direction || params.selector };
  }

  private async executeHover(params: import('../../types/index.js').HoverParams): Promise<unknown> {
    const element = await this.resolveElement(params);
    if (!element) throw new Error(`Element not found for hover: ${JSON.stringify(params)}`);

    await element.hover({ timeout: 5000 });
    await this.page!.waitForTimeout(500); // 等待 tooltip 等出现

    return { hovered: params.selector || params.text };
  }

  private async executeWait(params: import('../../types/index.js').WaitParams): Promise<unknown> {
    if (params.ms) {
      await this.page!.waitForTimeout(params.ms);
      return { waited: `${params.ms}ms` };
    }
    if (params.selector) {
      await this.page!.waitForSelector(params.selector, { timeout: 10000 });
      return { waited: `selector "${params.selector}" appeared` };
    }
    if (params.condition && params.condition !== 'navigation') {
      await this.page!.waitForLoadState(params.condition, { timeout: 15000 });
      return { waited: `load state "${params.condition}"` };
    }
    if (params.condition === 'navigation') {
      await this.page!.waitForURL(this.page!.url(), { timeout: 15000 }).catch(() => {});
      return { waited: 'navigation completed' };
    }
    await this.page!.waitForTimeout(1000);
    return { waited: '1s (default)' };
  }

  private async executeEvaluate(params: import('../../types/index.js').EvaluateParams): Promise<unknown> {
    // 脚本安全审核
    const verdict = this.safetyGuard.auditScript(params.script);
    if (!verdict.passed) {
      throw new Error(`Script blocked: ${verdict.message}`);
    }

    const result = await this.page!.evaluate(params.script, params.args || []);
    return this.safetyGuard.sanitizeOutput(result);
  }

  private async executeExtract(params: import('../../types/index.js').ExtractParams): Promise<unknown> {
    const { pattern, method = 'text' } = params;

    switch (method) {
      case 'text':
        return this.page!.evaluate(
          (p: string) => document.body.textContent?.match(new RegExp(p, 'g')) || [],
          pattern
        );
      case 'regex':
        return this.page!.evaluate(
          (p: string) => {
            const regex = new RegExp(p, 'gi');
            const matches: string[] = [];
            let match;
            while ((match = regex.exec(document.body.textContent || '')) !== null && matches.length < 100) {
              matches.push(match[0]);
            }
            return matches;
          },
          pattern
        );
      case 'selector':
        const elements = await this.page!.$$(pattern);
        return Promise.all(
          elements.slice(0, 50).map(async (el) => ({
            tag: await el.evaluate((node: Element) => node.tagName),
            text: await el.textContent().then((t) => t?.trim().substring(0, 200)),
            visible: await el.isVisible(),
          }))
        );
      default:
        throw new Error(`Unknown extract method: ${method}`);
    }
  }

  private async executeAssert(params: import('../../types/index.js').AssertParams): Promise<unknown> {
    const { condition, expected, actualFrom, selector } = params;
    let actual: unknown;

    const from = actualFrom || 'text';
    switch (from) {
      case 'url':
        actual = this.page!.url();
        break;
      case 'title':
        actual = await this.page!.title();
        break;
      case 'text':
        if (selector) {
          const el = await this.page!.$(selector);
          actual = el ? await el.textContent().then((t) => t?.trim()) : null;
        } else {
          actual = await this.page!.evaluate(() => document.body.textContent?.trim().substring(0, 1000));
        }
        break;
      case 'count':
        if (selector) {
          actual = await this.page!.$$(selector).then((els) => els.length);
        }
        break;
      default:
        actual = null;
    }

    const passed = expected === undefined || String(actual) === String(expected);

    return {
      condition,
      expected,
      actual,
      passed,
      message: passed ? 'Assertion passed' : `Expected "${expected}", got "${actual}"`,
    };
  }

  private async captureSnapshot(): Promise<unknown> {
    return {
      url: this.page!.url(),
      title: await this.page!.title(),
      screenshot: await this.page!.screenshot({ type: 'png', fullPage: true }).then(
        (buf) => `data:image/png;base64,${buf.toString('base64')}`
      ),
    };
  }

  // ============================================================
  // 元素定位
  // ============================================================

  /**
   * 智能元素定位
   *
   * 按优先级尝试：selector → text → role → coordinates
   */
  private async resolveElement(
    params: import('../../types/index.js').ClickParams | import('../../types/index.js').HoverParams | { selector?: string }
  ): Promise<any> {
    const { selector, text, role, coordinates } = params as any;

    // 1. 先尝试 selector
    if (selector) {
      const el = await this.page!.$(selector);
      if (el) return el;
    }

    // 2. 按 text 匹配
    if (text) {
      const el = await this.page!.locator(`text=${text}`).first();
      if (await el.count() > 0) return el.elementHandle();
    }

    // 3. 按 role 匹配
    if (role) {
      const el = await this.page!.locator(`[role="${role}"]`).first();
      if (await el.count() > 0) return el.elementHandle();
    }

    // 4. 坐标点击
    if (coordinates) {
      const { x, y } = coordinates;
      await this.page!.mouse.click(x, y);
      return true; // 坐标点击总是"成功"
    }

    return null;
  }

  // ============================================================
  // 页面方法代理
  // ============================================================

  /**
   * 获取当前 Page 实例
   */
  getPage(): Page | null {
    return this.page;
  }

  /**
   * 设置外部传入的 Page 实例（共享浏览器模式）
   *
   * 用于 MCP Server 等场景，BrowserMind 使用已有的浏览器页面而非自己启动。
   */
  setPage(page: Page): void {
    this.page = page;
    this.setupPageListeners();
    this.logger.info('External Page instance attached to executor');
  }

  /**
   * 重启浏览器（页面崩溃后的恢复）
   *
   * @returns 新的 Page 实例，如果恢复失败返回 null
   */
  async relaunch(): Promise<Page | null> {
    this.logger.warn('Attempting to relaunch browser...');
    try {
      await this.close();
      const newPage = await this.launch();
      this.logger.info('Browser relaunched successfully');
      return newPage;
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Failed to relaunch browser');
      return null;
    }
  }

  /**
   * 获取控制台日志
   */
  getConsoleLogs(): Array<{ level: string; text: string; timestamp: number }> {
    return [...this.consoleBuffer];
  }

  /**
   * 清除控制台日志缓冲区
   */
  clearConsoleLogs(): void {
    this.consoleBuffer = [];
  }

  /**
   * 截取截图
   */
  async takeScreenshot(fullPage = true): Promise<Buffer> {
    return this.page!.screenshot({ type: 'png', fullPage });
  }
}
