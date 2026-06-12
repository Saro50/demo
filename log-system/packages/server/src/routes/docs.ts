/**
 * GET /api/docs — 服务使用说明
 *
 * 返回业务方关心的服务使用信息，包括：
 * - 服务简介
 * - 认证方式
 * - 全部 API 列表（方法、路径、参数、响应）
 * - 快速上手步骤
 * - SDK 集成指南（含完整配置字段说明和示例）
 *
 * 设计原则：
 * - 不暴露任何内部实现细节（数据库路径、容量等）
 * - 静态说明内聚在此文件中，不需要查询数据库
 * - 所有内容围绕"业务方如何接入使用"展开
 */

import { Router, Request, Response } from 'express';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({
    service: {
      name: '@myby/log-server',
      version: '1.0.0',
      description: '轻量级日志收集与查询服务，支持前端埋点、异常上报、链路追踪',
      server_time: Date.now(),
    },

    // ==================== 认证 ====================
    authentication: {
      type: 'x-app-token',
      used_by: ['POST /api/logs'],
      description: '上报日志时需要在 Header 中携带 x-app-token',
      how_to_get: '联系服务管理员或在管理后台创建应用获取',
    },

    // ==================== API 列表 ====================
    endpoints: [
      {
        method: 'POST',
        path: '/api/logs',
        summary: '批量上报日志',
        auth: 'x-app-token（必填）',
        headers: {
          'x-app-token': '应用 Token，用于身份认证',
          'x-trace-id': '链路 Trace ID（可选，SDK 会自动生成）',
          'x-span-id': '当前 Span ID（可选，SDK 会自动生成）',
          'x-parent-span-id': '父 Span ID（可选，用于构建链路树）',
        },
        request: {
          'content-type': 'application/json',
          body: {
            logs: '日志条目数组，每条需包含 trace_id, span_id, level, category',
          },
          size_limit: '1MB',
        },
        response: {
          '200': '{ accepted: number, errors: Array<{ index: number, reason: string }> }',
          '400': '请求体格式错误',
          '403': '无效或缺失 x-app-token',
        },
      },
      {
        method: 'GET',
        path: '/api/logs',
        summary: '查询日志列表（含分页和筛选）',
        auth: '不需要',
        params: {
          page: '页码，默认 1',
          page_size: '每页条数，默认 50，最大 200',
          sort: '排序，asc（正序）/ desc（倒序），默认 desc',
          level: '按级别筛选，多个用逗号分隔，如 error,warn',
          category: '按分类筛选',
          app_name: '按应用名称筛选',
          trace_id: '按链路 ID 筛选',
          user_id: '按用户 ID 筛选',
          keyword: '关键字搜索，匹配 message 和 data 字段',
          start_time: '起始时间戳（毫秒）',
          end_time: '结束时间戳（毫秒）',
        },
      },
      {
        method: 'GET',
        path: '/api/logs/:id',
        summary: '查看单条日志详情',
        auth: '不需要',
      },
      {
        method: 'GET',
        path: '/api/traces/:traceID',
        summary: '查看完整链路追踪详情（含所有 Span）',
        auth: '不需要',
      },
      {
        method: 'GET',
        path: '/api/stats',
        summary: '获取统计聚合数据（日志量、错误数、事件分布、时序图）',
        auth: '不需要',
        params: {
          start_time: '起始时间戳（毫秒），默认 1 小时前',
          end_time: '结束时间戳（毫秒），默认当前时间',
        },
      },
      {
        method: 'GET',
        path: '/api/apps',
        summary: '获取已注册应用列表',
        auth: '不需要',
      },
      {
        method: 'GET',
        path: '/api/health',
        summary: '健康检查',
        auth: '不需要',
      },
    ],

    // ==================== 快速上手 ====================
    quick_start: [
      {
        step: 1,
        title: '启动服务',
        command: 'npm run dev',
        note: '默认监听 http://localhost:3100，首次启动会自动创建 demo 应用',
      },
      {
        step: 2,
        title: '获取应用 Token',
        description: '服务首次启动时，控制台会打印 Demo Token。',
        extra: '如需更多应用，执行 seed 脚本：',
        command: 'npm run db:seed',
      },
      {
        step: 3,
        title: '上报一条日志',
        command: [
          "curl -X POST http://localhost:3100/api/logs \\",
          '  -H "Content-Type: application/json" \\',
          '  -H "x-app-token: your-token-here" \\',
          '  -d \'{"logs":[{"trace_id":"abc","span_id":"1","level":"info","category":"event","message":"hello world"}]}\'',
        ].join('\n'),
      },
      {
        step: 4,
        title: '打开日志看板',
        url: 'http://localhost:3100',
        description: '在浏览器中查看日志、筛选、追踪链路和统计',
      },
    ],

    // ==================== SDK 集成 ====================
    sdk_integration: {
      package: '@myby/log-sdk',
      install: 'npm install @myby/log-sdk',

      /** 配置字段说明 */
      config_fields: [
        {
          name: 'endpoint',
          type: 'string',
          required: true,
          default: '/api/logs',
          description: '日志上报地址，同域时可省略域名部分',
        },
        {
          name: 'appName',
          type: 'string',
          required: true,
          description: '应用名称，用于在日志看板中区分不同来源的日志',
        },
        {
          name: 'environment',
          type: 'string',
          required: true,
          default: 'development',
          description: '运行环境，如 production / staging / development',
        },
        {
          name: 'appToken',
          type: 'string',
          required: false,
          description: '应用 Token，从服务端获取。传了则后端会校验上报权限',
        },
        {
          name: 'sampleRate',
          type: 'number',
          default: 1,
          description: '采样率，取值范围 0~1。1 表示全量采集，0.1 表示只采集 10%',
        },
        {
          name: 'sanitize',
          type: 'boolean',
          default: true,
          description: '是否自动脱敏，开启后会对 data 中的敏感字段做模糊处理',
        },
        {
          name: 'autoCapture',
          type: 'object',
          default: '{ error: true, promise: true, request: true, route: true, performance: false, click: false }',
          description: '被动捕获开关，可按需关闭不需要的自动采集类型',
          fields: [
            { name: 'error',       default: true,  description: '自动捕获 JS 运行时错误（window.onerror）' },
            { name: 'promise',     default: true,  description: '自动捕获未处理的 Promise rejection' },
            { name: 'request',     default: true,  description: '自动包装 fetch，记录请求耗时和状态码' },
            { name: 'route',       default: true,  description: '自动监听 popstate / hashchange 记录路由变化' },
            { name: 'performance', default: false, description: '采集 FCP / LCP / CLS / TTFB 性能指标' },
            { name: 'click',       default: false, description: '采集全局点击事件（日志量较大，谨慎开启）' },
          ],
        },
        {
          name: 'maxQueueSize',
          type: 'number',
          default: 5000,
          description: '本地 IndexedDB 队列最大容量，超出后丢弃旧日志',
        },
        {
          name: 'maxRetries',
          type: 'number',
          default: 5,
          description: '上报失败最大重试次数，超限后丢弃该条日志',
        },
        {
          name: 'retryInterval',
          type: 'number',
          default: 1000,
          description: '重试间隔（毫秒），每次重试按指数退避递增',
        },
      ],

      /** 主动 API */
      api_methods: [
        {
          name: 'Logger.init(config)',
          description: '【必需】初始化 SDK，完成配置并启动被动捕获，建议在应用入口处调用',
          example: "Logger.init({ appName: 'my-app', environment: 'production' })",
        },
        {
          name: 'Logger.track(eventKey, data?)',
          description: '业务埋点事件，category 自动设为 event',
          example: "Logger.track('pay_success', { amount: 99.9 })",
        },
        {
          name: 'Logger.error(message, data?)',
          description: '主动上报错误',
          example: "Logger.error('请求失败', { status: 500 })",
        },
        {
          name: 'Logger.info(message, data?)',
          description: '主动上报信息',
          example: "Logger.info('用户注册完成')",
        },
        {
          name: 'Logger.setUserId(userId)',
          description: '设置当前用户 ID，设置后后续所有日志自动携带此用户标识',
          example: "Logger.setUserId('user_abc123')",
        },
        {
          name: 'Logger.getQueueDepth()',
          description: '获取本地队列待发送日志数，返回 Promise<number>，可用于调试',
          example: 'const count = await Logger.getQueueDepth()',
        },
      ],

      /** 被动捕获说明 */
      auto_capture: [
        {
          event: 'JS 异常',
          category: 'exception',
          source: 'window.onerror',
          description: '自动捕获 JS 运行时错误（语法错误、类型错误等），含错误堆栈和行列号',
        },
        {
          event: 'Promise rejection',
          category: 'exception',
          source: 'unhandledrejection',
          description: '自动捕获未 catch 的 Promise 异常',
        },
        {
          event: '网络请求',
          category: 'request',
          source: 'fetch 包装',
          description: '自动包装全局 fetch，记录请求耗时、状态码、URL。不会捕获日志上报自身的请求，避免循环',
        },
        {
          event: '路由变化',
          category: 'page',
          source: 'popstate / hashchange',
          description: '自动监听路由变化，记录页面跳转来源与去向。初始页面加载也会记录一次',
        },
        {
          event: '性能指标',
          category: 'performance',
          source: 'PerformanceObserver',
          description: '采集 FCP / LCP / CLS / TTFB，需配置 autoCapture.performance = true 开启',
        },
        {
          event: '点击事件',
          category: 'event',
          source: 'document.click',
          description: '采集全局点击事件，记录元素选择器、文本和坐标。需配置 autoCapture.click = true 开启',
        },
      ],

      /** SDK 完整接入示例 */
      full_example: [
        'import { Logger } from "@myby/log-sdk";',
        '',
        '// 在应用入口处调用（仅一次）',
        'Logger.init({',
        '  endpoint: "/api/logs",',
        '  appName: "shop-web",',
        '  environment: "production",',
        '  appToken: "tok_xxx",  // 从服务端获取',
        '  autoCapture: {',
        '    performance: true,  // 开启性能采集',
        '    click: false,       // 关闭点击采集',
        '  },',
        '  sampleRate: 0.5,      // 50% 采样率',
        '});',
        '',
        '// ── 主动上报 ──',
        'Logger.track("add_to_cart", { sku: "123", price: 29.9 });',
        'Logger.error("API 返回异常", { code: 500, path: "/order" });',
        'Logger.info("页面加载完成");',
        '',
        '// 设置用户标识',
        'Logger.setUserId("user_abc123");',
        '',
        '// ── 被动上报（无需任何代码） ──',
        '// JS 异常       → 自动捕获为 exception 日志',
        '// fetch 请求    → 自动捕获为 request 日志（耗时、状态码）',
        '// 路由跳转      → 自动捕获为 page 日志',
      ].join('\n'),

      /** 类型声明说明 */
      types: {
        note: 'SDK 包含完整的 TypeScript 类型声明，所有接口均有 TSDoc 注释，可在 IDE 中直接查看',
        import_path: "import { Logger, type LoggerConfig, type LogEntry } from '@myby/log-sdk'",
        definitions: [
          'LoggerConfig — 初始化配置接口，所有字段均有注释说明',
          'LogEntry     — 日志条目结构，含 trace_id, span_id, level, category 等字段',
          "LogLevel     — 'debug' | 'info' | 'warn' | 'error' | 'fatal'",
          "LogCategory  — 'event' | 'exception' | 'request' | 'page' | 'performance'",
        ],
      },
    },
  });
});

export default router;
