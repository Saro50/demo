// ============================================================
// BrowserMind 规划层（Action Planner）
//
// 职责：
// 将 LLM 的自然语言意图解析为可执行的动作序列。
// 这是框架的"大脑"——理解意图、编排步骤、处理反馈。
//
// 核心能力：
// 1. 意图解析 — 将 LLM 的自然语言转为结构化 Action[]
// 2. 动作编排 — 复杂目标分解为多步动作序列
// 3. 反馈驱动 — 根据上一次观测调整下一步计划
// 4. 错误恢复 — 动作失败时自动尝试替代方案
//
// 设计决策：
// - 采用"观测-思考-行动"循环（Observe-Think-Act）
// - 每一步都包含"观测 + 动作 + 反馈"三个环节
// - LLM 的"思考"结果保存在 Action.description 中
// ============================================================

import type { Action, ActionType, Observation, SessionContext } from '../../types/index.js';
import type pino from 'pino';

/** 规划结果 */
export interface PlanResult {
  /** 下一步要执行的动作 */
  actions: Action[];
  /** 规划器的解释/推理 */
  reasoning: string;
  /** 是否判定为完成 */
  isComplete: boolean;
  /** 完成时的总结（如有） */
  summary?: string;
}

/** 规划器配置 */
export interface PlannerConfig {
  /** 搜索深度 */
  maxDepth: number;
  /** 是否启用自动探索模式 */
  autoExplore: boolean;
  /** 探索模板（autoExplore 时使用） */
  exploreTemplate?: Action[];
}

const DEFAULT_EXPLORE_TEMPLATE: Action[] = [
  { type: 'probe', params: { probeName: 'getPageStructure' }, description: '探测页面骨架结构' },
  { type: 'probe', params: { probeName: 'getInteractiveElements' }, description: '探测可交互元素' },
  { type: 'probe', params: { probeName: 'getForms' }, description: '探测表单结构' },
];

export class ActionPlanner {
  private logger: pino.Logger;
  private config: PlannerConfig;

  constructor(logger: pino.Logger, config?: Partial<PlannerConfig>) {
    this.logger = logger.child({ module: 'action-planner' });
    this.config = {
      maxDepth: 10,
      autoExplore: true,
      exploreTemplate: DEFAULT_EXPLORE_TEMPLATE,
      ...config,
    };
  }

  // ============================================================
  // 意图解析
  // ============================================================

  /**
   * 将 LLM 的自然语言意图解析为动作序列
   *
   * @param intent - LLM 的自然语言意图
   * @param context - 当前会话上下文
   * @param lastObservation - 最近一次观测（用于反馈）
   * @returns 规划结果
   *
   * 解析策略：
   * 1. 如果 intent 为空或"探索" → 使用自动探索模板
   * 2. 如果 intent 包含明确指令 → 基于模板匹配生成动作
   * 3. 如果 intent 是"继续" → 基于上一步观测决定下一步
   */
  parseIntent(
    intent: string,
    context: SessionContext,
    lastObservation?: Observation
  ): PlanResult {
    const normalized = intent.toLowerCase().trim();

    this.logger.info({ intent, stepNumber: context.stepNumber }, 'Parsing intent');

    // 检查步数限制
    if (context.stepNumber >= this.config.maxDepth) {
      return {
        actions: [],
        reasoning: `已达到最大探索步数 (${this.config.maxDepth})，结束会话`,
        isComplete: true,
        summary: `探索完成，共执行 ${context.stepNumber} 步`,
      };
    }

    // 完成指令
    if (this.isCompletionIntent(normalized)) {
      return this.buildCompletionResult(context);
    }

    // 探索指令
    if (this.isExplorationIntent(normalized) || !normalized) {
      return this.buildExplorationPlan(context, lastObservation);
    }

    // 特定功能测试
    if (this.isFeatureTestIntent(normalized)) {
      return this.buildFeatureTestPlan(normalized, context);
    }

    // 提取指令
    if (this.isExtractionIntent(normalized)) {
      return this.buildExtractionPlan(normalized);
    }

    // 断言指令
    if (this.isAssertionIntent(normalized)) {
      return this.buildAssertionPlan(normalized);
    }

    // 兜底：单步动作
    return this.buildSingleAction(normalized, context);
  }

  // ============================================================
  // 意图分类
  // ============================================================

  private isCompletionIntent(text: string): boolean {
    const keywords = ['完成', '结束', '停止', '总结', 'done', 'finish', 'stop', 'complete', 'summarize'];
    return keywords.some((k) => text.includes(k));
  }

  private isExplorationIntent(text: string): boolean {
    const keywords = [
      '探索', '探测', '查看', '了解', '浏览', '看看',
      'explore', 'probe', 'examine', 'inspect', 'look', 'browse',
      '有什么', '页面', '结构',
    ];
    return keywords.some((k) => text.includes(k));
  }

  private isFeatureTestIntent(text: string): boolean {
    const keywords = [
      '测试', '功能', '验证', '登录', '搜索', '注册', '表单', '提交',
      'test', 'verify', 'check', 'login', 'search', 'register', 'form', 'submit',
    ];
    return keywords.some((k) => text.includes(k));
  }

  private isExtractionIntent(text: string): boolean {
    const keywords = [
      '提取', '获取', '取出', '找到',
      'extract', 'get', 'find', 'retrieve', 'fetch',
    ];
    return keywords.some((k) => text.includes(k));
  }

  private isAssertionIntent(text: string): boolean {
    const keywords = [
      '断言', '验证', '确认', '检查',
      'assert', 'verify', 'should', 'expect', 'must',
    ];
    return keywords.some((k) => text.includes(k));
  }

  // ============================================================
  // 计划构建
  // ============================================================

  /**
   * 构建自动探索计划
   */
  private buildExplorationPlan(
    context: SessionContext,
    lastObservation?: Observation
  ): PlanResult {
    // 如果已经探索过，基于之前的结果深入
    if (context.observationHistory.length > 0 && lastObservation) {
      return this.buildDeepExplorationPlan(lastObservation);
    }

    // 初次探索：使用标准模板
    return {
      actions: [
        { type: 'navigate', params: { url: context.config.browser?.launch?.channel || '' }, description: '导航到目标页面' },
        ...(this.config.exploreTemplate || DEFAULT_EXPLORE_TEMPLATE),
      ],
      reasoning: '首次探索页面，先获取页面骨架和交互元素信息',
      isComplete: false,
    };
  }

  /**
   * 基于已获取的观测，决定深入探测区域
   */
  private buildDeepExplorationPlan(observation: Observation): PlanResult {
    const actions: Action[] = [];

    // 如果有表单，深入探测表单
    if (observation.summary.forms > 0) {
      actions.push({
        type: 'probe',
        params: { probeName: 'getForms' },
        description: '深入探测表单字段详情',
      });
    }

    // 如果有 iframe，探测 iframe 内容
    if (observation.summary.iframes > 0) {
      actions.push({
        type: 'evaluate',
        params: {
          script: `() => Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, title: f.title, width: f.width }))`,
        },
        description: '探测 iframe 内容',
      });
    }

    // 分析交互热点，深入热点区域
    if (observation.hotSpots.length > 0) {
      const topHotSpot = observation.hotSpots[0];
      actions.push({
        type: 'scroll',
        params: { selector: `[class*="${topHotSpot.description.split(':')[0].trim()}"]` },
        description: `滚动到交互热点区域: ${topHotSpot.description.substring(0, 50)}`,
      });
    }

    // 如果没有更多可探索的，完成
    if (actions.length === 0) {
      return {
        actions: [],
        reasoning: '页面已充分探索',
        isComplete: true,
        summary: this.buildSummary(observation),
      };
    }

    return {
      actions,
      reasoning: `页面有 ${observation.summary.forms} 个表单, ${observation.summary.iframes} 个 iframe, ${observation.hotSpots.length} 个交互热点，继续深入探测`,
      isComplete: false,
    };
  }

  /**
   * 构建功能测试计划
   */
  private buildFeatureTestPlan(intent: string, context: SessionContext): PlanResult {
    const actions: Action[] = [];

    if (intent.includes('登录') || intent.includes('login')) {
      actions.push(
        { type: 'probe', params: { probeName: 'getForms' }, description: '探测登录表单' },
        { type: 'extract', params: { pattern: 'input', method: 'selector' }, description: '提取输入框' },
        { type: 'assert', params: { condition: '存在登录表单', actualFrom: 'count', selector: 'form' }, description: '验证登录表单存在' }
      );
    } else if (intent.includes('搜索') || intent.includes('search')) {
      actions.push(
        { type: 'probe', params: { probeName: 'getInteractiveElements' }, description: '探测搜索输入框' },
        { type: 'extract', params: { pattern: 'input[type="search"], input[name*="search"], input[placeholder*="搜索"]', method: 'selector' }, description: '提取搜索框' }
      );
    } else {
      // 通用功能探测
      actions.push(
        { type: 'snapshot', params: { type: 'full' }, description: '全页面快照' },
        { type: 'extract', params: { pattern: 'button, a[href], input, select, textarea', method: 'selector' }, description: '提取所有交互元素' }
      );
    }

    return {
      actions,
      reasoning: `根据意图 "${intent}" 生成功能测试计划`,
      isComplete: false,
    };
  }

  /**
   * 构建提取计划
   */
  private buildExtractionPlan(intent: string): PlanResult {
    let pattern = '';
    let method: 'text' | 'regex' | 'selector' = 'text';

    if (intent.includes('链接') || intent.includes('link') || intent.includes('href')) {
      pattern = 'a[href]';
      method = 'selector';
    } else if (intent.includes('图片') || intent.includes('image') || intent.includes('img')) {
      pattern = 'img';
      method = 'selector';
    } else if (intent.includes('表格') || intent.includes('table') || intent.includes('数据')) {
      pattern = 'table';
      method = 'selector';
    } else {
      pattern = intent.replace(/提取|获取|找出|找到|extract|get|find/gi, '').trim();
    }

    return {
      actions: [
        { type: 'extract', params: { pattern, method }, description: `提取: ${pattern}` },
      ],
      reasoning: `根据意图提取 "${pattern}"`,
      isComplete: false,
    };
  }

  /**
   * 构建断言计划
   */
  private buildAssertionPlan(intent: string): PlanResult {
    return {
      actions: [
        {
          type: 'assert',
          params: { condition: intent, actualFrom: 'text' },
          description: `断言: ${intent}`,
        },
      ],
      reasoning: `执行断言: ${intent}`,
      isComplete: false,
    };
  }

  /**
   * 构建单步动作（兜底）
   */
  private buildSingleAction(intent: string, context: SessionContext): PlanResult {
    // 尝试识别单一动作
    let action: Action;

    if (intent.startsWith('/')) {
      // 显式命令: /click #button
      const parts = intent.slice(1).split(' ');
      const cmd = parts[0] as ActionType;
      const args = parts.slice(1).join(' ');
      action = { type: cmd, params: { selector: args || 'body' }, description: intent };
    } else if (intent.includes('点击') || intent.includes('click') || intent.includes('button')) {
      action = { type: 'click', params: { text: intent.replace(/点击|click|按钮/gi, '').trim() }, description: intent };
    } else if (intent.includes('输入') || intent.includes('type') || intent.includes('填写')) {
      action = { type: 'type', params: { selector: 'input', text: intent.replace(/输入|type|填写|到|中/gi, '').trim() }, description: intent };
    } else if (intent.includes('滚动') || intent.includes('scroll')) {
      action = { type: 'scroll', params: { direction: intent.includes('下') ? 'down' : 'up' }, description: intent };
    } else if (intent.includes('等待') || intent.includes('wait')) {
      action = { type: 'wait', params: { ms: 2000 }, description: intent };
    } else {
      action = { type: 'snapshot', params: { type: 'full' }, description: intent };
    }

    return {
      actions: [action],
      reasoning: `解析为单一动作: ${action.type}`,
      isComplete: false,
    };
  }

  // ============================================================
  // 辅助方法
  // ============================================================

  /**
   * 构建完成结果
   */
  private buildCompletionResult(context: SessionContext): PlanResult {
    return {
      actions: [],
      reasoning: '用户请求结束探索',
      isComplete: true,
      summary: this.buildSummary(context.observationHistory[context.observationHistory.length - 1]),
    };
  }

  /**
   * 构建探索总结
   */
  private buildSummary(observation?: Observation): string {
    if (!observation) {
      return '探索完成，未收集到页面信息';
    }

    return [
      `📄 页面: ${observation.title}`,
      `🔗 URL: ${observation.url}`,
      `📊 包含 ${observation.summary.interactiveElements} 个交互元素，${observation.summary.forms} 个表单，${observation.summary.links} 个链接`,
      `🎯 发现 ${observation.hotSpots.length} 个交互热点区域`,
      observation.summary.iframes > 0 ? `🖼️ 包含 ${observation.summary.iframes} 个 iframe` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 更新规划器配置
   */
  updateConfig(partial: Partial<PlannerConfig>): void {
    this.config = { ...this.config, ...partial };
    this.logger.info({ updatedFields: Object.keys(partial) }, 'Planner config updated');
  }
}
