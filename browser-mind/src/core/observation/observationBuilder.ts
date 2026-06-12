// ============================================================
// BrowserMind 观察层（Observation Builder）
//
// 职责：
// 将浏览器页面的实时状态转化为 LLM 可理解的结构化观测报告。
// 核心挑战是 DOM 压缩——原始 DOM 可能 150KB+，远超 LLM 窗口。
//
// 压缩策略：
// 1. 语义优先 — 保留语义标签（header/nav/main/form），丢弃布局 div
// 2. 交互聚焦 — 只保留可交互元素的详细信息
// 3. 深度限制 — DOM 树深度 ≤ 5 层
// 4. 文本截断 — 长文本截断到 100 字符
// 5. 属性过滤 — 只保留关键属性（href/src/aria-label/name/type）
//
// 数据流转:
//   page.evaluate(probe) → raw DOM → CompressedNode → Observation
//
// 影响范围:
//   观测报告的质量直接决定了 LLM 对页面的理解程度。
//   压缩过狠会丢失信息，压缩不够会撑爆上下文。
// ============================================================

import type { Page } from 'playwright';
import type {
  Observation,
  CompressedNode,
  PageSummary,
  HotSpot,
  ConsoleEntry,
  NetworkEntry,
  Action,
} from '../../types/index.js';
import { SafetyGuard } from '../safety/safetyGuard.js';
import type pino from 'pino';

/**
 * 观察构建器
 */
export class ObservationBuilder {
  private safetyGuard: SafetyGuard;
  private logger: pino.Logger;

  constructor(safetyGuard: SafetyGuard, logger: pino.Logger) {
    this.safetyGuard = safetyGuard;
    this.logger = logger.child({ module: 'observation' });
  }

  // ============================================================
  // 核心方法
  // ============================================================

  /**
   * 构建当前页面的完整观测报告
   *
   * 调用多个探测脚本，汇总为一份结构化的 Observation。
   *
   * @param page - Playwright Page 实例
   * @param lastAction - 上一个执行的动作（用于反馈）
   * @param lastActionResult - 上一个动作的执行结果
   * @returns 完整的观测报告
   */
  async buildObservation(
    page: Page,
    lastAction?: Action,
    lastActionResult?: { success: boolean; error?: string; duration: number }
  ): Promise<Observation> {
    const startTime = Date.now();
    this.logger.info('Building observation');

    try {
      // 并行执行多个探测任务（提升性能）
      const [pageInfo, structure, summary, network, consoleLogs, storage] = await Promise.all([
        this.getPageInfo(page),
        this.getPageStructure(page),
        this.getPageSummary(page),
        this.getNetworkState(page),
        this.getConsoleLogs(page),
        this.getStorageState(page),
      ]);

      // 构建热区
      const hotSpots = this.buildHotSpots(structure);

      // 计算页面源 hash (用于快速比对)
      const pageSourceHash = await this.computePageHash(page);

      const observation: Observation = {
        timestamp: new Date().toISOString(),
        url: pageInfo.url,
        title: pageInfo.title,
        viewport: pageInfo.viewport,

        summary,
        pageStructure: structure,
        hotSpots,

        network,
        console: consoleLogs,

        screenshot: undefined,
        pageSourceHash,

        lastActionFeedback: lastAction
          ? {
              action: lastAction.description || lastAction.type,
              success: lastActionResult?.success ?? true,
              error: lastActionResult?.error,
              duration: lastActionResult?.duration ?? 0,
              pageChanged: true, // 首次观测或动作后默认认为有变化
            }
          : undefined,
      };

      const duration = Date.now() - startTime;
      this.logger.debug(
        { duration, summarySize: JSON.stringify(summary).length },
        'Observation built successfully'
      );

      return observation;
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Failed to build observation');
      // 返回最小观测（保底）
      return this.buildMinimalObservation(page, error.message);
    }
  }

  // ============================================================
  // 页元信息
  // ============================================================

  private async getPageInfo(page: Page): Promise<{
    url: string;
    title: string;
    viewport: { width: number; height: number };
  }> {
    const [url, title, viewportSize] = await Promise.all([
      page.url(),
      page.title(),
      page.viewportSize(),
    ]);

    return {
      url: this.safetyGuard.sanitizeOutput(url) as string,
      title: title || '',
      viewport: viewportSize || { width: 1280, height: 720 },
    };
  }

  // ============================================================
  // DOM 压缩核心算法
  // ============================================================

  /**
   * 获取压缩后的页面 DOM 结构
   *
   * 通过 page.evaluate 在浏览器端执行压缩逻辑，
   * 避免将原始 DOM 传到 Node.js 端再处理（节省传输带宽）。
   */
  private async getPageStructure(page: Page): Promise<CompressedNode> {
    // 该脚本在浏览器端执行，直接操作真实 DOM
    const compressScript = `
      (function compressDOM(root, depth) {
        const MAX_DEPTH = 5;
        const MAX_CHILDREN = 50;
        const TEXT_MAX_LENGTH = 100;

        if (!root || !root.tagName || depth > MAX_DEPTH) return null;

        const tag = root.tagName.toLowerCase();
        const role = root.getAttribute('role') || tag;

        // 判断是否应该跳过该节点（纯布局元素且无交互内容）
        const skipTags = ['script', 'style', 'link', 'meta', 'noscript'];
        if (skipTags.includes(tag)) return null;

        const isInteractive = checkInteractive(root);
        // 始终捕获 rect，用于热区检测和元素定位
        const rect = getRect(root);

        const node = {
          tag,
          role,
          text: getMeaningfulText(root, TEXT_MAX_LENGTH),
          attributes: extractKeyAttributes(root),
          rect,
          interactive: isInteractive,
          visible: isVisible(root),
          children: []
        };

        // 递归处理子节点
        let childrenCount = 0;
        for (const child of root.children) {
          if (childrenCount >= MAX_CHILDREN) break;
          const compressed = compressDOM(child, depth + 1);
          if (compressed) {
            node.children.push(compressed);
            childrenCount++;
          }
        }

        return node;

        // ---------- 辅助函数 ----------
        function checkInteractive(el) {
          const interactiveTags = ['a', 'button', 'input', 'select', 'textarea', 'option', 'label'];
          const interactiveRoles = ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem',
            'slider', 'switch', 'textbox', 'combobox', 'listbox'];
          const interactiveAttrs = ['onclick', 'onmousedown', 'onmouseup', 'onkeydown'];

          if (interactiveTags.includes(el.tagName.toLowerCase())) return true;
          const role = el.getAttribute('role');
          if (role && interactiveRoles.includes(role)) return true;
          if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;
          if (el.tagName === 'A' && el.getAttribute('href')) return true;
          for (const attr of interactiveAttrs) {
            if (el.hasAttribute(attr)) return true;
          }
          return false;
        }

        function getRect(el) {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        }

        function isVisible(el) {
          if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
          if (el.hidden) return false;
          if (el.getAttribute('aria-hidden') === 'true') return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          return true;
        }

        function getMeaningfulText(el, maxLen) {
          const text = el.textContent?.trim();
          if (!text || text.length === 0) return undefined;
          // 过滤纯空白/装饰性文本
          if (/^[\\s\\n\\r\\t.,;:!?()\\[\\]{}<>"']+$/.test(text)) return undefined;
          return text.substring(0, maxLen);
        }

        function extractKeyAttributes(el) {
          const attrs = {};
          const keepAttrs = ['href', 'src', 'alt', 'aria-label', 'aria-describedby',
            'data-testid', 'type', 'name', 'disabled', 'required', 'placeholder',
            'value', 'for', 'id', 'class'];
          for (const attr of keepAttrs) {
            const val = el.getAttribute(attr);
            if (val !== null && val !== undefined) {
              attrs[attr] = val.substring(0, 200);
            }
          }
          // 提取 class 的语义部分（只保留 BEM 类名）
          if (attrs['class']) {
            const classes = attrs['class'].split(/\\s+/)
              .filter(c => /^(js-|is-|has-|data-)/.test(c));
            if (classes.length > 0) {
              attrs['class'] = classes.join(' ');
            } else {
              delete attrs['class'];
            }
          }
          return attrs;
        }
      })(document.body, 0)
    `;

    try {
      const result = await page.evaluate(compressScript);
      if (!result) {
        // 兜底：返回 body 标签
        return {
          tag: 'body',
          role: 'document',
          interactive: false,
          visible: true,
          attributes: {},
          children: [],
        };
      }
      return result as CompressedNode;
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Failed to compress DOM');
      return {
        tag: 'body',
        role: 'document',
        interactive: false,
        visible: true,
        attributes: {},
        children: [],
      };
    }
  }

  // ============================================================
  // 页面摘要
  // ============================================================

  private async getPageSummary(page: Page): Promise<PageSummary> {
    const summaryScript = `
      (function() {
        const all = document.querySelectorAll('*');
        const visible = Array.from(all).filter(el => 
          el.offsetWidth > 0 && el.offsetHeight > 0 && !el.hidden
        );

        return {
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.getAttribute('content'),
          language: document.documentElement.lang || undefined,
          interactiveElements: visible.filter(el => {
            const t = el.tagName.toLowerCase();
            return ['a', 'button', 'input', 'select', 'textarea'].includes(t) || 
              el.getAttribute('role') === 'button';
          }).length,
          forms: document.querySelectorAll('form').length,
          links: document.querySelectorAll('a[href]').length,
          images: document.querySelectorAll('img').length,
          iframes: document.querySelectorAll('iframe').length,
          scripts: document.querySelectorAll('script').length,
          stylesheets: document.querySelectorAll('link[rel="stylesheet"]').length,
          totalElements: all.length,
        };
      })()
    `;

    try {
      const result = await page.evaluate(summaryScript);
      return result as PageSummary;
    } catch {
      return {
        title: '',
        interactiveElements: 0,
        forms: 0,
        links: 0,
        images: 0,
        iframes: 0,
        scripts: 0,
        stylesheets: 0,
        totalElements: 0,
      };
    }
  }

  // ============================================================
  // 网络状态
  // ============================================================

  private async getNetworkState(page: Page): Promise<Observation['network']> {
    try {
      // 通过 Playwright 的 CDP 获取网络信息
      const client = await page.context().newCDPSession(page);
      const result = await client.send('Network.getAllCookies');
      // 注意：这里简化实现，实际可以通过 Performance API 获取
      return {
        pending: [],
        completed: [],
        errors: [],
        totalRequests: 0,
      };
    } catch {
      return { pending: [], completed: [], errors: [], totalRequests: 0 };
    }
  }

  // ============================================================
  // 控制台日志
  // ============================================================

  private async getConsoleLogs(page: Page): Promise<Observation['console']> {
    // 注意：实际运行时，控制台日志应通过 page.on('console') 持续收集
    // 这里返回空集合，实际数据由 ExecutionLayer 注入
    return { errors: [], warnings: [], logs: [] };
  }

  // ============================================================
  // 存储状态
  // ============================================================

  private async getStorageState(page: Page): Promise<string | null> {
    try {
      const storageScript = `
        (function() {
          const cookies = document.cookie ? document.cookie.split(';').map(c => c.trim().split('=')[0]) : [];
          const localKeys = Object.keys(localStorage).slice(0, 20);
          const sessionKeys = Object.keys(sessionStorage).slice(0, 10);
          return JSON.stringify({
            cookies: cookies.length > 0 ? cookies : undefined,
            localStorage: localKeys.length > 0 ? localKeys : undefined,
            sessionStorage: sessionKeys.length > 0 ? sessionKeys : undefined,
          });
        })()
      `;
      const result = await page.evaluate(storageScript);
      return result as string;
    } catch {
      return null;
    }
  }

  // ============================================================
  // 热区构建
  // ============================================================

  /**
   * 从压缩的 DOM 结构构建交互热区
   *
   * 热区帮助 LLM 了解页面哪些区域交互密度高。
   */
  private buildHotSpots(structure: CompressedNode): HotSpot[] {
    const hotSpots: HotSpot[] = [];
    this.findInteractiveClusters(structure, hotSpots, 0);
    // 按元素数量排序，取前 5 个热区
    return hotSpots
      .sort((a, b) => b.elementCount - a.elementCount)
      .slice(0, 5);
  }

  /**
   * 递归查找交互密集区域
   */
  private findInteractiveClusters(
    node: CompressedNode,
    results: HotSpot[],
    depth: number
  ): number {
    if (!node.children || node.children.length === 0) {
      return node.interactive ? 1 : 0;
    }

    let interactiveCount = 0;
    for (const child of node.children) {
      interactiveCount += this.findInteractiveClusters(child, results, depth + 1);
    }

    // 如果当前节点交互元素较多且已有位置信息，标记为热区
    if (interactiveCount >= 3 && node.rect) {
      results.push({
        rect: node.rect,
        elementCount: interactiveCount,
        description: `${node.tag} (${node.role}): ${node.text || ''}`.substring(0, 100),
      });
    }

    return interactiveCount;
  }

  // ============================================================
  // 页面变更检测
  // ============================================================

  /**
   * 通过页面哈希快速检测页面是否发生变化
   */
  private detectPageChange(oldHash?: string, newHash?: string): boolean {
    if (!oldHash || !newHash) return true;
    return oldHash !== newHash;
  }

  /**
   * 计算页面源的指纹哈希
   */
  private async computePageHash(page: Page): Promise<string> {
    try {
      const script = `
        (function() {
          const body = document.body;
          if (!body) return '';
          // 取关键特征：可见元素数 + 表单数 + 标题 + URL
          const features = [
            document.title,
            document.querySelectorAll('*').length,
            document.querySelectorAll('form').length,
            document.querySelectorAll('a[href]').length,
            document.querySelectorAll('button, input, select, textarea').length,
          ];
          return features.join('|');
        })()
      `;
      const hash = await page.evaluate(script);
      // 简单哈希：用 Base64 编码
      return Buffer.from(String(hash)).toString('base64').substring(0, 20);
    } catch {
      return '';
    }
  }

  // ============================================================
  // 最小观测（保底）
  // ============================================================

  /**
   * 构建最小化的观测报告（当完整构建失败时的保底方案）
   */
  private async buildMinimalObservation(
    page: Page,
    errorMessage: string
  ): Promise<Observation> {
    let url = '';
    let title = '';
    try {
      url = page.url();
      title = await page.title();
    } catch {
      // 页面可能已崩溃
    }

    return {
      timestamp: new Date().toISOString(),
      url,
      title,
      viewport: { width: 0, height: 0 },
      summary: {
        title,
        interactiveElements: 0,
        forms: 0,
        links: 0,
        images: 0,
        iframes: 0,
        scripts: 0,
        stylesheets: 0,
        totalElements: 0,
      },
      pageStructure: {
        tag: 'error',
        role: 'error',
        interactive: false,
        visible: false,
        attributes: {},
        children: [],
      },
      hotSpots: [],
      network: { pending: [], completed: [], errors: [], totalRequests: 0 },
      console: { errors: [], warnings: [], logs: [] },
      lastActionFeedback: {
        action: 'buildObservation',
        success: false,
        error: errorMessage,
        duration: 0,
        pageChanged: false,
      },
    };
  }
}
