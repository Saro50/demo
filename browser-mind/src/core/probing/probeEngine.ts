// ============================================================
// BrowserMind 脚本注入引擎（Probe Engine）
//
// 职责：
// 这是框架的"眼睛"——向浏览器注入 JavaScript 脚本，
// 探测页面的内部状态。支持两类探针：
//
// 1. 预置探针（Pre-built Probes）
//    预先编写的标准化探测脚本，覆盖常见场景：
//    - 页面结构探测
//    - 交互元素探测
//    - 表单结构探测
//    - 网络状态探测
//    - 存储状态探测
//
// 2. 动态探针（Dynamic Probes）
//    根据 LLM 的自然语言描述，实时生成探测脚本。
//    例如 LLM 说："找出所有红色边框的输入框"
//    → 引擎自动生成对应的 document.querySelector 脚本
//
// 数据流转:
//   LLM/用户 → ProbeRequest → 脚本注入 → 执行 → 结构化结果
//
// 安全影响:
//   所有注入脚本都经过 SafetyGuard 审核，确保：
//   - 不包含危险 API 调用
//   - 不会修改页面状态
//   - 返回数据量受控
// ============================================================

import type { Page } from 'playwright';
import type { Probe, ProbeRequest, ProbeResult } from '../../types/index.js';
import { SafetyGuard } from '../safety/safetyGuard.js';
import type pino from 'pino';

/**
 * 脚本注入引擎
 */
export class ProbeEngine {
  /** 已注册的预置探针 */
  private probes: Map<string, Probe> = new Map();
  private safetyGuard: SafetyGuard;
  private logger: pino.Logger;

  constructor(safetyGuard: SafetyGuard, logger: pino.Logger) {
    this.safetyGuard = safetyGuard;
    this.logger = logger.child({ module: 'probe-engine' });
  }

  // ============================================================
  // 探针注册
  // ============================================================

  /**
   * 注册一个预置探针
   *
   * @param probe - 探针定义
   *
   * 使用示例:
   *   engine.register({
   *     name: 'getPageStructure',
   *     description: '获取页面语义骨架',
   *     script: fs.readFileSync('./probes/structure.js', 'utf-8'),
   *     outputType: 'json',
   *   });
   */
  register(probe: Probe): void {
    if (this.probes.has(probe.name)) {
      this.logger.warn({ probeName: probe.name }, 'Overwriting existing probe');
    }
    this.probes.set(probe.name, probe);
    this.logger.debug({ probeName: probe.name }, 'Probe registered');
  }

  /**
   * 批量注册探针
   */
  registerMany(probes: Probe[]): void {
    for (const probe of probes) {
      this.register(probe);
    }
  }

  /**
   * 获取已注册的探针列表
   */
  listProbes(): Probe[] {
    return Array.from(this.probes.values());
  }

  /**
   * 获取特定探针
   */
  getProbe(name: string): Probe | undefined {
    return this.probes.get(name);
  }

  // ============================================================
  // 探针执行
  // ============================================================

  /**
   * 在页面上执行一个探针
   *
   * @param page - Playwright Page 实例
   * @param request - 探针执行请求
   * @returns 探针执行结果
   *
   * 执行流程:
   * 1. 查找探针注册信息
   * 2. 构建完整脚本（注入参数 + 包装函数）
   * 3. SafetyGuard 审核脚本
   * 4. 通过 page.evaluate() 注入执行
   * 5. 处理结果和错误
   */
  async execute(page: Page, request: ProbeRequest): Promise<ProbeResult> {
    const startTime = Date.now();
    const { probeName, args, force } = request;

    // 1. 查找探针
    const probe = this.probes.get(probeName);
    if (!probe) {
      return {
        probeName,
        rawResult: null,
        size: 0,
        durationMs: Date.now() - startTime,
        success: false,
        error: `Unknown probe: "${probeName}". Available: ${Array.from(this.probes.keys()).join(', ')}`,
      };
    }

    this.logger.info({ probeName, args }, 'Executing probe');

    try {
      // 2. 构建注入脚本
      const fullScript = this.buildScript(probe, args);

      // 3. 安全审核
      const verdict = this.safetyGuard.auditScript(fullScript);
      if (!verdict.passed) {
        this.logger.warn({ probeName, verdict }, 'Probe script blocked by safety guard');
        return {
          probeName,
          rawResult: null,
          size: 0,
          durationMs: Date.now() - startTime,
          success: false,
          error: `Safety guard blocked probe: ${verdict.message}`,
        };
      }

      // 4. 注入并执行
      const timeout = probe.timeout || 5000;
      const rawResult = await page.evaluate(fullScript, args || {});

      // 5. 处理结果
      const durationMs = Date.now() - startTime;
      const sanitized = this.safetyGuard.sanitizeOutput(rawResult);
      const serialized = JSON.stringify(sanitized);
      const size = serialized.length;

      // 检查返回数据大小
      if (size > this.safetyGuard.getConfig().maxScriptReturnSize) {
        this.logger.warn(
          { probeName, size, maxSize: this.safetyGuard.getConfig().maxScriptReturnSize },
          'Probe result truncated'
        );
        return {
          probeName,
          rawResult: { truncated: true, originalSize: size, message: 'Result too large, truncated' },
          size,
          durationMs,
          success: true,
        };
      }

      this.logger.debug(
        { probeName, durationMs, size },
        'Probe executed successfully'
      );

      return {
        probeName,
        rawResult: sanitized,
        size,
        durationMs,
        success: true,
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error.message || String(error);

      this.logger.error({ probeName, error: errorMessage, durationMs }, 'Probe execution failed');

      return {
        probeName,
        rawResult: null,
        size: 0,
        durationMs,
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 在页面上执行多个探针
   *
   * 批量执行时会复用同一个 page.evaluate 上下文，
   * 减少通信开销。
   */
  async executeMany(page: Page, requests: ProbeRequest[]): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];
    for (const request of requests) {
      const result = await this.execute(page, request);
      results.push(result);
      // 如果关键探针失败，提前终止
      if (!result.success && request.probeName === 'getPageStructure') {
        this.logger.error('Critical probe "getPageStructure" failed, aborting batch');
        break;
      }
    }
    return results;
  }

  // ============================================================
  // 动态探针生成
  // ============================================================

  /**
   * 根据 LLM 自然语言描述，动态生成并执行探针
   *
   * @param page - Playwright Page 实例
   * @param intent - LLM 的自然语言描述
   * @returns 探测结果
   *
   * 示例:
   *   intent: "找出页面上所有 disabled 的输入框"
   *   → 生成: document.querySelectorAll('input:disabled')...
   */
  async executeDynamic(page: Page, intent: string): Promise<ProbeResult> {
    const script = this.translateIntentToScript(intent);
    this.logger.info({ intent, generatedScript: script }, 'Executing dynamic probe');

    // 创建一个临时探针来执行
    const dynamicProbe: Probe = {
      name: `dynamic_${Date.now()}`,
      description: intent,
      script,
      outputType: 'json',
      readonly: true,
    };

    this.register(dynamicProbe);
    const result = await this.execute(page, { probeName: dynamicProbe.name });
    // 执行完后移除临时探针
    this.probes.delete(dynamicProbe.name);

    return result;
  }

  /**
   * 将自然语言意图翻译为 DOM 探测脚本
   *
   * 当前实现为模板匹配，后续可接入 LLM 生成更复杂的脚本。
   */
  private translateIntentToScript(intent: string): string {
    const normalized = intent.toLowerCase();

    // 模板匹配规则
    if (normalized.includes('disabled') || normalized.includes('禁用的')) {
      if (normalized.includes('input') || normalized.includes('输入框')) {
        return `() => {
          const inputs = document.querySelectorAll('input:disabled, textarea:disabled, select:disabled');
          return Array.from(inputs).map(el => ({
            tag: el.tagName,
            name: el.getAttribute('name'),
            type: el.getAttribute('type'),
            placeholder: el.getAttribute('placeholder'),
          }));
        }`;
      }
      if (normalized.includes('button') || normalized.includes('按钮')) {
        return `() => {
          const buttons = document.querySelectorAll('button:disabled, input[type="submit"]:disabled, [role="button"][aria-disabled="true"]');
          return Array.from(buttons).map(el => ({
            tag: el.tagName,
            text: el.textContent?.trim(),
            'aria-label': el.getAttribute('aria-label'),
          }));
        }`;
      }
    }

    if (normalized.includes('hidden') || normalized.includes('隐藏')) {
      return `() => {
        const hidden = document.querySelectorAll('[hidden], [style*="display: none"], [style*="visibility: hidden"], [aria-hidden="true"]');
        return Array.from(hidden).map(el => ({
          tag: el.tagName,
          id: el.id,
          className: el.className,
          text: el.textContent?.substring(0, 100),
        }));
      }`;
    }

    if (normalized.includes('image') || normalized.includes('图片') || normalized.includes('img')) {
      return `() => {
        const imgs = document.querySelectorAll('img');
        return Array.from(imgs).map(img => ({
          src: img.src,
          alt: img.alt,
          width: img.width,
          height: img.height,
          loading: img.loading,
          visible: img.offsetWidth > 0 && img.offsetHeight > 0,
        }));
      }`;
    }

    if (normalized.includes('link') || normalized.includes('链接') || normalized.includes('a 标签')) {
      return `() => {
        const links = document.querySelectorAll('a[href]');
        return Array.from(links).map(a => ({
          href: a.href,
          text: a.textContent?.trim().substring(0, 100),
          target: a.target,
          rel: a.rel,
          visible: a.offsetWidth > 0 && a.offsetHeight > 0,
        }));
      }`;
    }

    if (normalized.includes('form') || normalized.includes('表单')) {
      return `() => {
        const forms = document.querySelectorAll('form');
        return Array.from(forms).map(form => ({
          action: form.action,
          method: form.method,
          fields: Array.from(form.querySelectorAll('input, select, textarea')).map(f => ({
            name: f.getAttribute('name'),
            type: f.getAttribute('type'),
            required: f.hasAttribute('required'),
            placeholder: f.getAttribute('placeholder'),
          })),
        }));
      }`;
    }

    if (normalized.includes('error') || normalized.includes('错误') || normalized.includes('异常')) {
      return `() => {
        const errors = document.querySelectorAll('[class*="error"], [id*="error"], [class*="alert"], [role="alert"]');
        return Array.from(errors).map(el => ({
          text: el.textContent?.trim(),
          visible: el.offsetWidth > 0 && el.offsetHeight > 0,
        }));
      }`;
    }

    // 兜底：通用元素查询
    return `(args) => {
      const selector = args?.selector || '*';
      const maxResults = args?.maxResults || 50;
      const elements = document.querySelectorAll(selector);
      return Array.from(elements).slice(0, maxResults).map(el => ({
        tag: el.tagName,
        id: el.id,
        className: el.className.substring(0, 100),
        text: el.textContent?.trim().substring(0, 100),
        visible: el.offsetWidth > 0 && el.offsetHeight > 0,
      }));
    }`;
  }

  // ============================================================
  // 脚本构建
  // ============================================================

  /**
   * 构建完整的注入脚本
   *
   * 将探针脚本包装为可执行的函数，注入配置参数。
   */
  private buildScript(probe: Probe, args?: Record<string, unknown>): string {
    // 如果脚本已经是完整函数，直接返回
    if (probe.script.trim().startsWith('(') || probe.script.trim().startsWith('function')) {
      return probe.script;
    }

    // 包装为匿名函数
    return `(args) => {
      ${probe.script}
    }`;
  }
}
