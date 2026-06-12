// ============================================================
// BrowserMind 默认配置
//
// 提供开箱即用的安全配置，用户可通过 BrowserMindConfig 覆盖
// ============================================================

import type { BrowserMindConfig } from './types/index.js';

export const DEFAULT_CONFIG: BrowserMindConfig = {
  browser: {
    browserType: 'chromium',
    launch: {
      headless: true,
    },
    context: {},
  },

  llm: {
    provider: 'openai',
    model: 'gpt-4o',
    temperature: 0.3,
    maxTokens: 4096,
    apiKey: process.env.OPENAI_API_KEY,
  },

  safety: {
    maxStepsPerSession: 30,
    maxConcurrentSessions: 3,
    actionTimeoutMs: 15000,
    readonlyMode: true,
    allowedApis: [
      'document.querySelector',
      'document.querySelectorAll',
      'document.getElementById',
      'element.getAttribute',
      'element.textContent',
      'element.getBoundingClientRect',
      'JSON.stringify',
      'JSON.parse',
      'Array.from',
      'String',
      'Number',
      'Boolean',
      'Object.keys',
      'window.getComputedStyle',
      'document.title',
      'document.cookie',
      'localStorage.getItem',
      'localStorage.key',
    ],
    blockedApis: [
      'eval',
      'innerHTML',
      'outerHTML',
      'document.write',
      'new Function',
      'setTimeout',
      'setInterval',
      'fetch',
      'XMLHttpRequest',
      'localStorage.setItem',
      'localStorage.removeItem',
      'localStorage.clear',
      'sessionStorage.setItem',
      'sessionStorage.removeItem',
      'sessionStorage.clear',
    ],
    maxScriptReturnSize: 102400, // 100KB
    sensitivePatterns: [
      '(?<=eyJ)[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+', // JWT
      '(?<=sk-[a-zA-Z0-9]{20,})', // OpenAI keys
      '(?<=ghp_)[a-zA-Z0-9]{36}', // GitHub tokens
    ],
    maskFields: [
      'password',
      'passwd',
      'secret',
      'token',
      'api_key',
      'apiKey',
      'apikey',
      'authorization',
      'Authorization',
    ],
    allowedOrigins: [],
    blockCrossOrigin: true,
    scriptTimeoutMs: 5000,
    maxStringLength: 5000,
  },

  logging: {
    level: 'info',
    persistToDb: true,
    prettyPrint: true,
  },

  session: {
    maxSteps: 30,
    timeoutMs: 300000, // 5min
    stepTimeoutMs: 30000,
    maxRetries: 3,
  },

  viewport: {
    width: 1280,
    height: 720,
  },
};
