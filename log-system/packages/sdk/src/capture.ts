/**
 * 被动上报引擎 - 自动捕获各类事件，无需业务代码侵入
 * 
 * 捕获类型与实现方式：
 * 
 * 1. 异常 (exception)
 *    - window.onerror: 捕获 JS 运行时错误（语法错误、类型错误等）
 *    - window.addEventListener('unhandledrejection'): 捕获未处理的 Promise 异常
 *    注意：onerror 无法捕获跨域脚本的详细错误信息，需要服务端配置跨域头
 * 
 * 2. 网络请求 (request)
 *    - 包装 window.fetch: 在全局 fetch 上添加拦截器
 *    - 如果业务使用 axios，建议通过 axios 拦截器集成（见响应拦截器使用示例）
 *    注意：直接覆写 fetch 可能影响业务正常请求，需要确保原功能不受影响
 * 
 * 3. 路由变化 (page)
 *    - 监听 popstate + hashchange 事件
 *    - 如果业务使用 SPA 路由库，建议业务侧额外调用 Logger.track('page_view')
 * 
 * 4. 性能指标 (performance) - 可选，默认关闭
 *    - 使用 PerformanceObserver 采集 FCP / LCP / CLS
 *    - 仅在浏览器支持且配置开启时启用
 * 
 * 5. 点击事件 (click) - 可选，默认关闭
 *    - 全局 document click 监听，采集元素选择器和文本
 *    注意：大量点击事件可能导致日志量过大，谨慎开启
 */

import type { LogEntry, LoggerConfig } from '@myby/log-shared';
import { getOrCreateTraceId, generateSpanId, setTraceId } from './id';
import { sanitizeData } from './sanitizer';
import type { LoggerInstance } from './logger';

/** 从当前页面的 URL 参数中提取 traceID（用于外部跳转链路传递） */
function extractTraceFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('_trace');
  } catch {
    return null;
  }
}

export function setupPassiveCapture(
  config: LoggerConfig,
  logger: LoggerInstance
): () => void {
  const cleanup: (() => void)[] = [];

  // 提取外部传入的 traceID
  const externalTrace = extractTraceFromUrl();
  if (externalTrace) {
    // 这会通过 sessionStorage 设入，后续所有日志自动沿用
    setTraceId(externalTrace);
  }

  // ==================== 异常捕获 ====================
  if (config.autoCapture?.error !== false) {
    const errorHandler = (event: ErrorEvent) => {
      logger._capture({
        level: 'error',
        category: 'exception',
        message: event.message || 'Unknown error',
        data: sanitizeData({
          source: event.filename,
          line: event.lineno,
          col: event.colno,
          stack: (event.error as Error)?.stack || null,
        }),
      });
    };
    window.addEventListener('error', errorHandler);
    cleanup.push(() => window.removeEventListener('error', errorHandler));
  }

  // ==================== Promise 异常 ====================
  if (config.autoCapture?.promise !== false) {
    const rejectionHandler = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      logger._capture({
        level: 'error',
        category: 'exception',
        message: reason?.message || 'Unhandled Promise rejection',
        data: sanitizeData({
          stack: reason?.stack || null,
          reason: typeof reason === 'string' ? reason : undefined,
        }),
      });
    };
    window.addEventListener('unhandledrejection', rejectionHandler);
    cleanup.push(() => window.removeEventListener('unhandledrejection', rejectionHandler));
  }

  // ==================== 网络请求 (fetch 包装) ====================
  // 注意：Logger 初始化的 endpoint 可能在运行时被覆盖，所以只记录初始 endpoint 用于过滤
  const logEndpoint = config.endpoint;
  if (config.autoCapture?.request !== false) {
    const originalFetch = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const startTime = performance.now();
      const traceId = getOrCreateTraceId();
      const spanId = generateSpanId();
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      // 跳过向日志上报端点的请求（避免上报日志时自己又被记录，形成循环）
      // 设计原因：Reporter.send() 会 POST 到 logEndpoint，如果也捕获会导致每条日志
      // 额外产生一条 request 日志，且 IndexedDB 队列可能反复触发 flush 形成循环
      if (logEndpoint && url.startsWith(logEndpoint)) {
        return originalFetch.call(window, input, init);
      }

      // 注入链路头（仅当请求头中尚未设置时，避免覆盖 Reporter 等内部组件已注入的值）
      const headers = new Headers(init?.headers);
      if (!headers.has('x-trace-id')) {
        headers.set('x-trace-id', traceId);
      }
      if (!headers.has('x-span-id')) {
        headers.set('x-span-id', spanId);
      }

      const newInit = { ...init, headers };

      return originalFetch.call(window, input, newInit)
        .then(async (response) => {
          const duration = performance.now() - startTime;
          const level = response.ok ? 'info' : response.status >= 500 ? 'error' : 'warn';

          logger._capture({
            level,
            category: 'request',
            message: `${response.status} ${response.statusText}`,
            data: sanitizeData({
              method: (init?.method || 'GET').toUpperCase(),
              url,
              status: response.status,
              duration: Math.round(duration),
              trace_id: traceId,
            }),
          });

          return response;
        })
        .catch((err: Error) => {
          const duration = performance.now() - startTime;
          logger._capture({
            level: 'error',
            category: 'request',
            message: `Fetch failed: ${err.message}`,
            data: sanitizeData({
              method: (init?.method || 'GET').toUpperCase(),
              url,
              duration: Math.round(duration),
              error: err.message,
            }),
          });
          // SDK 已记录错误，重新抛出让业务层正常处理
          throw err;
        });
    };
    cleanup.push(() => {
      window.fetch = originalFetch;
    });
  }

  // ==================== 路由变化 ====================
  if (config.autoCapture?.route !== false) {
    let currentUrl = window.location.href;

    const routeHandler = () => {
      const from = currentUrl;
      const to = window.location.href;
      currentUrl = to;

      logger._capture({
        level: 'info',
        category: 'page',
        message: `Route: ${window.location.pathname}`,
        data: {
          from,
          to,
          title: document.title,
        },
      });
    };

    window.addEventListener('popstate', routeHandler);
    window.addEventListener('hashchange', routeHandler);

    // 初始页面加载
    setTimeout(() => {
      logger._capture({
        level: 'info',
        category: 'page',
        message: `Page load: ${window.location.pathname}`,
        data: {
          url: window.location.href,
          title: document.title,
          referrer: document.referrer || null,
        },
      });
    }, 500);

    cleanup.push(() => {
      window.removeEventListener('popstate', routeHandler);
      window.removeEventListener('hashchange', routeHandler);
    });
  }

  // ==================== 性能指标 ====================
  if (config.autoCapture?.performance && typeof PerformanceObserver !== 'undefined') {
    try {
      // FCP (First Contentful Paint)
      const fcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (entries.length > 0) {
          logger._capture({
            level: 'info',
            category: 'performance',
            message: 'FCP',
            data: { value: entries[0].startTime, metric: 'FCP' },
          });
        }
      });
      fcpObserver.observe({ type: 'paint', buffered: true });
      cleanup.push(() => fcpObserver.disconnect());

      // LCP (Largest Contentful Paint)
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (entries.length > 0) {
          const last = entries[entries.length - 1];
          logger._capture({
            level: 'info',
            category: 'performance',
            message: 'LCP',
            data: { value: last.startTime, metric: 'LCP' },
          });
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
      cleanup.push(() => lcpObserver.disconnect());

      // CLS (Cumulative Layout Shift)
      let clsValue = 0;
      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!(entry as any).hadRecentInput) {
            clsValue += (entry as any).value;
          }
        }
        logger._capture({
          level: 'info',
          category: 'performance',
          message: 'CLS update',
          data: { value: clsValue, metric: 'CLS' },
        });
      });
      clsObserver.observe({ type: 'layout-shift', buffered: true });
      cleanup.push(() => clsObserver.disconnect());

      // TTFB
      setTimeout(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        if (nav) {
          logger._capture({
            level: 'info',
            category: 'performance',
            message: 'TTFB',
            data: { value: nav.responseStart - nav.requestStart, metric: 'TTFB' },
          });
        }
      }, 1000);
    } catch (err) {
      console.warn('[LogSystem] PerformanceObserver not supported or error:', err);
    }
  }

  // ==================== 点击事件 ====================
  if (config.autoCapture?.click) {
    const clickHandler = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target) return;

      // 获取可读的标识信息
      const selector = [
        target.tagName.toLowerCase(),
        target.id ? `#${target.id}` : '',
        target.className ? `.${Array.from(target.classList).join('.')}` : '',
      ].filter(Boolean).join('');

      logger._capture({
        level: 'info',
        category: 'event',
        event_key: 'click',
        message: `Click: ${selector}`,
        data: {
          tag: target.tagName.toLowerCase(),
          id: target.id || undefined,
          class: Array.from(target.classList).join(' ') || undefined,
          text: (target.textContent || '').trim().slice(0, 50),
          x: event.clientX,
          y: event.clientY,
        },
      });
    };
    document.addEventListener('click', clickHandler, { capture: true });
    cleanup.push(() => document.removeEventListener('click', clickHandler, { capture: true }));
  }

  // 返回清理函数
  return () => {
    cleanup.forEach((fn) => fn());
  };
}
