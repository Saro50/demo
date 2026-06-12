// ============================================================
// BrowserMind — 核心编排引擎
//
// 职责：
// 这是框架的"中央处理器"，负责编排所有模块的协作。
// 实现 Observe-Think-Act 循环，驱动 LLM 逐步探索页面。
//
// 架构说明：
// BrowserMind 作为外观模式（Facade）入口，统一管理：
// - PlaywrightExecutor（执行器）：操控浏览器
// - ProbeEngine（探针引擎）：注入探测脚本
// - ObservationBuilder（观察器）：构建观测报告
// - ActionPlanner（规划器）：解析意图编排动作
// - SafetyGuard（安全守卫）：审核所有操作
// - LLMProvider（LLM 适配器）：与大模型通信
//
// 数据流转：
//   User Goal
//     → BrowserMind.run() 创建 Session
//     → 循环: [Observe(页面) → LLM(分析+决策) → Act(执行动作)]
//     → Session 结束返回总结报告
//
// 异常影响：
// - 任一模块的严重错误会导致当前步骤失败，但不会影响整个会话
// - 安全违规会立即阻断当前操作
// - 浏览器崩溃会自动重启
// ============================================================

import type { BrowserMindConfig, SessionContext, SessionStatus, Action, Observation, ActionResult } from '../types/index.js';
import type { LLMProvider } from '../types/index.js';
import { PlaywrightExecutor } from './execution/playwrightExecutor.js';
import { ProbeEngine } from './probing/probeEngine.js';
import { ObservationBuilder } from './observation/observationBuilder.js';
import { ActionPlanner } from './planning/actionPlanner.js';
import { SafetyGuard } from './safety/safetyGuard.js';
import { createLLMProvider } from '../llm/adapters/llmAdapter.js';
import { initLogger, createSessionLogger, closeLogger } from '../logging/logger.js';
import { db, disconnectDatabase } from '../db/prisma.js';
import type pino from 'pino';

/** 会话运行结果 */
export interface RunResult {
  sessionId: string;
  status: SessionStatus;
  totalSteps: number;
  totalDuration: number;
  summary?: string;
  error?: string;
  observations: Observation[];
}

/**
 * BrowserMind 主引擎
 *
 * 使用示例:
 * ```typescript
 * const mind = new BrowserMind(config);
 * const result = await mind.run('探测登录页面', 'https://example.com/login');
 * console.log(result.summary);
 * ```
 */
export class BrowserMind {
  private config: BrowserMindConfig;
  private logger: pino.Logger;
  private safetyGuard: SafetyGuard;
  private probeEngine!: ProbeEngine;
  private observationBuilder!: ObservationBuilder;
  private executor!: PlaywrightExecutor;
  private planner!: ActionPlanner;
  private llmProvider!: LLMProvider;

  constructor(config: BrowserMindConfig) {
    this.config = config;
    this.logger = initLogger(config);
    this.safetyGuard = new SafetyGuard(config.safety, this.logger);

    // 延迟初始化 probeEngine，以便 registerProbe() 可以提前调用
    this.probeEngine = new ProbeEngine(this.safetyGuard, this.logger);

    this.logger.info(
      { viewport: config.viewport, llmProvider: config.llm.provider },
      'BrowserMind initialized'
    );
  }

  // ============================================================
  // 注册预置探针
  // ============================================================

  /**
   * 注册自定义探针
   *
   * 框架内置了基础探针，可以通过此方法扩展自定义探针。
   */
  registerProbe(probe: import('../types/index.js').Probe): void {
    // probeEngine 在构造函数中已初始化，此处安全
    this.probeEngine!.register(probe);
  }

  /**
   * 批量注册探针
   */
  registerProbes(probes: import('../types/index.js').Probe[]): void {
    this.probeEngine!.registerMany(probes);
  }

  // ============================================================
  // 核心运行方法
  // ============================================================

  /**
   * 运行一次探测会话
   *
   * @param goal - 探测目标（自然语言描述）
   * @param url - 目标页面 URL（可选，如不提供则不导航）
   * @returns 会话运行结果
   *
   * 运行流程:
   * 1. 创建会话记录
   * 2. 启动浏览器
   * 3. 初始化所有子模块
   * 4. 进入 Observe-Think-Act 循环
   * 5. 直到规划器判定完成或达到限制
   * 6. 关闭浏览器，持久化结果
   */
  async run(goal: string, url?: string, existingPage?: import('playwright').Page): Promise<RunResult> {
    const sessionId = this.generateSessionId();
    const sessionLogger = createSessionLogger(sessionId, 0);

    sessionLogger.info({ goal, url }, 'Starting BrowserMind session');

    // 创建会话上下文
    const context: SessionContext = {
      sessionId,
      status: 'RUNNING',
      config: this.config,
      stepNumber: 0,
      startTime: Date.now(),
      lastActivity: Date.now(),
      actionHistory: [],
      observationHistory: [],
      metadata: {},
    };

    // 持久化 Session 到数据库
    await this.persistSession(context, goal, url);

    try {
      // 1. 初始化浏览器（如果传入了 existingPage，直接使用而非新启动）
      this.executor = new PlaywrightExecutor(this.config, this.safetyGuard, this.logger);
      
      let page: import('playwright').Page;
      let ownsBrowser = false;
      if (existingPage) {
        // 使用已有的 Page 实例（共享浏览器场景，如 MCP Server）
        this.executor.setPage(existingPage);
        page = existingPage;
        this.logger.info('Using existing Page instance (shared browser mode)');
      } else {
        page = await this.executor.launch();
        ownsBrowser = true;
      }
      this.ownsBrowser = ownsBrowser;

      // 2. 初始化子模块
      this.llmProvider = createLLMProvider(this.config, this.logger);
      this.observationBuilder = new ObservationBuilder(this.safetyGuard, this.logger);
      this.planner = new ActionPlanner(this.logger);

      // 注册内置探针（probeEngine 已在构造函数中初始化）
      this.registerBuiltinProbes();

      // 3. 如果提供了 URL，先导航
      if (url) {
        const navAction: Action = {
          type: 'navigate',
          params: { url },
          description: `导航到 ${url}`,
        };
        const navResult = await this.executor.executeAction(navAction);
        context.actionHistory.push(navAction);
        if (navResult.observation) {
          context.observationHistory.push(navResult.observation);
        }
        await this.logAction(sessionId, navAction, navResult, sessionLogger);
      }

      // 4. Observe-Think-Act 循环
      let isComplete = false;
      let fallbackCount = 0;

      while (!isComplete && context.stepNumber < this.config.session.maxSteps) {
        context.stepNumber++;
        const stepLogger = createSessionLogger(sessionId, context.stepNumber);

        stepLogger.info('=== Step %d ===', context.stepNumber);

        // Observe: 获取当前观测
        const currentPage = this.executor.getPage();
        if (!currentPage) {
          stepLogger.error('Page instance is null, attempting recovery');
          const recoveredPage = await this.executor.relaunch();
          if (!recoveredPage) {
            throw new Error('Failed to recover browser page after crash');
          }
        }
        const observation = await this.observationBuilder.buildObservation(
          this.executor.getPage()!
        );
        context.observationHistory.push(observation);

        // 死锁检测（多维特征）
        const deadlockCheck = this.safetyGuard.checkDeadlock(
          `${observation.summary.interactiveElements}|${observation.summary.forms}|${observation.hotSpots.length}`,
          observation.url,
          observation.hotSpots.length
        );
        if (deadlockCheck.deadlocked) {
          stepLogger.warn({ suggestion: deadlockCheck.suggestion }, 'Deadlock detected');
          isComplete = true;
          context.metadata.completionReason = 'deadlock';
          break;
        }

        // Think: LLM 分析观测，决定下一步
        const llmResponse = await this.think(observation, context);
        if (!llmResponse.actions || llmResponse.actions.length === 0) {
          // 如果 LLM 没有给出动作，使用规划器兜底
          const plan = this.planner.parseIntent(goal, context, observation);
          if (plan.isComplete) {
            isComplete = true;
            context.metadata.summary = plan.summary;
            continue;
          }
          llmResponse.actions = plan.actions;
        }

        // Act: 执行动作
        for (const action of llmResponse.actions) {
          // 安全审核
          const verdict = this.safetyGuard.auditAction(action, context);
          if (verdict.action === 'terminate') {
            isComplete = true;
            context.metadata.completionReason = verdict.message;
            break;
          }
          if (verdict.action === 'block') {
            stepLogger.warn({ verdict }, 'Action blocked by safety guard');
            fallbackCount++;
            if (fallbackCount > 3) {
              isComplete = true;
              context.metadata.completionReason = 'too many blocked actions';
            }
            continue;
          }

          // 执行
          const result = await this.executor.executeAction(action);
          context.actionHistory.push(action);

          // 记录安全指标
          if (result.success) {
            this.safetyGuard.recordSuccess();
            fallbackCount = 0;
          } else {
            this.safetyGuard.recordFailure();
            fallbackCount++;
          }

          // 持久化
          await this.logAction(sessionId, action, result, stepLogger);

          // 检查是否需要终止
          if (context.stepNumber >= this.config.session.maxSteps) {
            isComplete = true;
            context.metadata.completionReason = 'maxStepsReached';
            break;
          }
        }
      }

      // 5. 完成会话
      context.status = 'COMPLETED';
      context.metadata.totalDuration = Date.now() - context.startTime;
      context.metadata.totalSteps = context.stepNumber;

      const summary = (context.metadata.summary as string) ||
        `探索完成。共执行 ${context.stepNumber} 步，采集 ${context.observationHistory.length} 次观测。`;

      sessionLogger.info(
        { totalSteps: context.stepNumber, totalDuration: context.metadata.totalDuration },
        'Session completed'
      );

      // 更新数据库
      await this.updateSession(context, summary);

      return {
        sessionId,
        status: 'COMPLETED',
        totalSteps: context.stepNumber,
        totalDuration: context.metadata.totalDuration as number,
        summary,
        observations: context.observationHistory,
      };
    } catch (error: any) {
      context.status = 'FAILED';
      sessionLogger.error({ error: error.message }, 'Session failed');

      await this.updateSession(context, undefined, error.message);

      return {
        sessionId,
        status: 'FAILED',
        totalSteps: context.stepNumber,
        totalDuration: Date.now() - context.startTime,
        error: error.message,
        observations: context.observationHistory,
      };
    } finally {
      // 6. 清理资源
      await this.cleanup();
    }
  }

  // ============================================================
  // LLM 交互
  // ============================================================

  /**
   * 将当前观测发送给 LLM，获取下一步行动指令
   */
  private async think(
    observation: Observation,
    context: SessionContext
  ): Promise<{ actions?: Action[]; reasoning?: string }> {
    // 构建发送给 LLM 的消息
    const systemPrompt = this.buildSystemPrompt();
    const userMessage = this.buildUserMessage(observation, context);

    try {
      const response = await this.llmProvider.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ]);

      this.logger.debug(
        { usage: response.usage, contentLength: response.content.length },
        'LLM response received'
      );

      // 尝试从 LLM 响应中解析出动作
      const actions = this.parseActionsFromLLM(response.content);
      return {
        actions,
        reasoning: response.content.substring(0, 500),
      };
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'LLM chat failed');
      return {};
    }
  }

  /**
   * 构建系统提示词
   */
  private buildSystemPrompt(): string {
    return `你是一个 Web 页面探测助手。你的任务是通过逐步执行浏览器操作来理解一个网页。

你可以执行以下操作:
1. click — 点击元素 (参数: selector, text, role, coordinates)
2. type — 输入文本 (参数: selector, text, clearFirst)
3. navigate — 导航到 URL (参数: url)
4. scroll — 滚动页面 (参数: direction: 'up'|'down'|'left'|'right'|'top'|'bottom')
5. hover — 悬停元素 (参数: selector, text)
6. wait — 等待 (参数: ms, condition, selector)
7. extract — 提取页面数据 (参数: pattern, method: 'text'|'regex'|'selector')
8. assert — 断言页面状态 (参数: condition, actualFrom: 'url'|'title'|'text'|'count')

你需要返回 JSON 格式的行动计划:
{
  "actions": [
    { "type": "click", "params": { "text": "登录" }, "description": "点击登录按钮" }
  ],
  "reasoning": "简短说明你的分析"
}

完成探索后，返回:
{ "actions": [], "reasoning": "...", "summary": "页面总结" }

注意:
- 每次只能执行 1-3 个动作
- 动作失败时换一种方式重试
- 优先使用 text 定位而不是 selector
- 只读模式，不要尝试修改数据
- 探索充分后主动结束`;
  }

  /**
   * 构建用户消息（包含当前观测）
   */
  private buildUserMessage(observation: Observation, context: SessionContext): string {
    return `[第 ${context.stepNumber} 步]

当前页面观测:
- URL: ${observation.url}
- 标题: ${observation.title}
- 视口: ${observation.viewport.width}x${observation.viewport.height}

页面摘要:
- 交互元素: ${observation.summary.interactiveElements}
- 表单: ${observation.summary.forms}
- 链接: ${observation.summary.links}
- 图片: ${observation.summary.images}
- iframe: ${observation.summary.iframes}

交互热点:
${observation.hotSpots.map((h, i) => `${i + 1}. [${h.rect.x},${h.rect.y} - ${h.rect.w}x${h.rect.h}] ${h.description} (${h.elementCount} 个元素)`).join('\n')}

页面结构 (压缩DOM):
${JSON.stringify(observation.pageStructure, null, 2).substring(0, 2000)}

${observation.lastActionFeedback ? `上一步动作反馈: ${observation.lastActionFeedback.action} → ${observation.lastActionFeedback.success ? '成功' : '失败: ' + observation.lastActionFeedback.error}` : ''}

【历史摘要】
已执行 ${context.stepNumber} 步。接下来的行动是什么？`;
  }

  // ============================================================
  // LLM 响应解析
  // ============================================================

  /**
   * 从 LLM 响应文本中解析出 Action 数组
   *
   * 支持两种格式：
   * 1. 纯 JSON 格式：{"actions": [...]}
   * 2. 代码块格式：\`\`\`json\n{"actions": [...]}\n\`\`\`
   */
  private parseActionsFromLLM(content: string): Action[] | undefined {
    try {
      // 尝试提取 JSON
      let jsonStr = content;

      // 提取 ```json ... ``` 代码块
      const jsonBlockMatch = content.match(/```(?:json)?\s*\n?({[\s\S]*?})\n?\s*```/);
      if (jsonBlockMatch) {
        jsonStr = jsonBlockMatch[1];
      }

      // 尝试直接解析
      const parsed = JSON.parse(jsonStr);

      if (parsed.actions && Array.isArray(parsed.actions)) {
        return parsed.actions.map((a: any) => ({
          type: a.type,
          params: a.params || {},
          description: a.description || a.type,
        }));
      }

      if (parsed.type) {
        // 单个动作
        return [{
          type: parsed.type,
          params: parsed.params || {},
          description: parsed.description || parsed.type,
        }];
      }

      if (parsed.summary) {
        // 完成
        return [];
      }

      return undefined;
    } catch {
      this.logger.warn('Failed to parse LLM response as JSON');
      return undefined;
    }
  }

  // ============================================================
  // 内置探针注册
  // ============================================================

  /**
   * 注册框架内置的预置探针
   */
  private registerBuiltinProbes(): void {
    // 内置探针在代码中定义，避免外部文件依赖
    const builtinProbes = [
      {
        name: 'getPageStructure',
        description: '获取页面语义骨架结构',
        outputType: 'json' as const,
        readonly: true,
        script: `
          // 页面结构探针 — 在 observationBuilder 中已有实现
          // 此处返回一个空包装，实际由 ObservationBuilder 处理
          return null;
        `,
      },
      {
        name: 'getInteractiveElements',
        description: '获取所有可交互元素',
        outputType: 'json' as const,
        readonly: true,
        script: `
          (args) => {
            const all = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])');
            return Array.from(all).slice(0, 100).map(el => ({
              tag: el.tagName,
              type: el.getAttribute('type'),
              text: el.textContent?.trim().substring(0, 100),
              href: el.getAttribute('href'),
              name: el.getAttribute('name'),
              placeholder: el.getAttribute('placeholder'),
              disabled: el.disabled || false,
              visible: el.offsetWidth > 0 && el.offsetHeight > 0,
              rect: (() => {
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
              })(),
            }));
          }
        `,
      },
      {
        name: 'getForms',
        description: '获取页面表单结构',
        outputType: 'json' as const,
        readonly: true,
        script: `
          (args) => {
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
          }
        `,
      },
      {
        name: 'getNavigation',
        description: '获取页面导航结构',
        outputType: 'json' as const,
        readonly: true,
        script: `
          (args) => {
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
          }
        `,
      },
    ];

    this.probeEngine.registerMany(builtinProbes);
  }

  // ============================================================
  // 数据库持久化
  // ============================================================

  /**
   * 持久化会话创建
   */
  private async persistSession(context: SessionContext, goal: string, url?: string): Promise<void> {
    try {
      await db.session.create({
        data: {
          id: context.sessionId,
          goal,
          url: url || null,
          status: 'RUNNING',
          config: JSON.stringify(this.config),
          llmModel: this.config.llm.model,
        },
      });
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Failed to persist session');
    }
  }

  /**
   * 持久化动作日志
   */
  private async logAction(
    sessionId: string,
    action: Action,
    result: ActionResult,
    logger: pino.Logger
  ): Promise<void> {
    try {
      await db.actionLog.create({
        data: {
          sessionId,
          stepNumber: result.action.stepNumber || 0,
          actionType: action.type,
          actionInput: JSON.stringify(action.params),
          actionOutput: result.evaluateResult
            ? JSON.stringify(result.evaluateResult).substring(0, 5000)
            : null,
          success: result.success,
          error: result.error,
          durationMs: result.durationMs,
          llmIntent: action.description,
        },
      });

      // 如果有观测，持久化
      if (result.observation) {
        const obs = result.observation;
        await db.observation.create({
          data: {
            sessionId,
            stepNumber: action.stepNumber || 0,
            url: obs.url,
            title: obs.title,
            viewport: JSON.stringify(obs.viewport),
            summary: JSON.stringify(obs.summary),
            pageStructure: JSON.stringify(obs.pageStructure).substring(0, 10000),
            hotSpots: JSON.stringify(obs.hotSpots),
          },
        });
      }
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to log action');
    }
  }

  /**
   * 更新会话状态
   */
  private async updateSession(
    context: SessionContext,
    summary?: string,
    error?: string
  ): Promise<void> {
    try {
      await db.session.update({
        where: { id: context.sessionId },
        data: {
          status: context.status,
          summary: summary || null,
          error: error || null,
          totalSteps: context.stepNumber,
          totalDuration: context.metadata.totalDuration as number || Date.now() - context.startTime,
        },
      });
    } catch (dbError: any) {
      this.logger.error({ error: dbError.message }, 'Failed to update session');
    }
  }

  // ============================================================
  // 资源清理
  // ============================================================

  /** 标记是否自己启动的浏览器（自己启动才负责关闭） */
  private ownsBrowser = false;

  /**
   * 清理资源
   *
   * 如果使用的是共享浏览器（MCP Server 场景），不关闭浏览器实例。
   */
  private async cleanup(): Promise<void> {
    try {
      if (this.ownsBrowser) {
        await this.executor?.close();
      } else {
        this.logger.debug('Skipping browser close: using shared browser');
      }
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Error during cleanup');
    }
  }

  /**
   * 完全关闭框架（退出应用时调用）
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down BrowserMind...');
    await this.cleanup();
    await closeLogger();
    await disconnectDatabase();
  }

  // ============================================================
  // 工具方法
  // ============================================================

  private generateSessionId(): string {
    return `bm_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }
}
