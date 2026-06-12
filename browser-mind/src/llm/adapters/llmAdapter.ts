// ============================================================
// BrowserMind LLM 适配器
//
// 职责：
// 为框架提供统一的 LLM 调用接口。通过适配器模式，
// 支持多种模型提供商（OpenAI、Claude、Ollama、自定义）。
//
// 设计模式：策略模式 + 工厂模式
// - LLMProvider 接口定义了所有模型必须实现的方法
// - LLMAdapterFactory 根据配置创建对应的适配器实例
// - 新增模型只需实现 LLMProvider 接口并注册到工厂
//
// 数据流转:
//   Observation → SystemPrompt + UserMessage → LLM → Response → Action[]
//
// 影响范围:
//   框架的核心"智能"来自 LLM。适配器质量直接影响：
//   - 意图解析的准确性
//   - 动作编排的合理性
//   - 错误恢复的能力
// ============================================================

import type { LLMProvider, LLMMessage, LLMResponse } from '../../types/index.js';
import type { BrowserMindConfig } from '../../types/index.js';
import type pino from 'pino';

// ============================================================
// LLM 适配器工厂
// ============================================================

/**
 * 创建 LLM 提供者实例
 *
 * @param config - 框架配置（包含 LLM 配置）
 * @param logger - 日志记录器
 * @returns LLM 提供者实例
 *
 * 支持的 provider:
 * - openai: OpenAI GPT 系列
 * - anthropic: Anthropic Claude 系列
 * - ollama: 本地部署的 Ollama
 * - custom: 自定义 API（需提供 baseUrl）
 */
export function createLLMProvider(
  config: BrowserMindConfig,
  logger: pino.Logger
): LLMProvider {
  const { provider, apiKey, model, baseUrl, temperature, maxTokens } = config.llm;

  logger.info({ provider, model }, 'Creating LLM provider');

  switch (provider) {
    case 'openai':
      return new OpenAIAdapter({ apiKey, model, baseUrl, temperature, maxTokens }, logger);
    case 'anthropic':
      return new AnthropicAdapter({ apiKey, model, baseUrl, temperature, maxTokens }, logger);
    case 'ollama':
      return new OllamaAdapter({ baseUrl: baseUrl || 'http://localhost:11434', model }, logger);
    case 'custom':
      return new CustomAdapter({ apiKey, model, baseUrl, temperature, maxTokens }, logger);
    default:
      logger.warn({ provider }, 'Unknown provider, falling back to OpenAI');
      return new OpenAIAdapter({ apiKey, model, baseUrl, temperature, maxTokens }, logger);
  }
}

// ============================================================
// LLM 适配器配置
// ============================================================

interface AdapterConfig {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

// ============================================================
// OpenAI 适配器
// ============================================================

class OpenAIAdapter implements LLMProvider {
  private config: AdapterConfig;
  private logger: pino.Logger;

  constructor(config: AdapterConfig, logger: pino.Logger) {
    this.config = config;
    this.logger = logger.child({ adapter: 'openai' });
  }

  getModelInfo(): { name: string; provider: string } {
    return { name: this.config.model, provider: 'openai' };
  }

  async chat(
    messages: LLMMessage[],
    options?: Record<string, unknown>
  ): Promise<LLMResponse> {
    this.logger.debug({ messageCount: messages.length }, 'Sending chat request to OpenAI');

    const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key not provided. Set it in config or OPENAI_API_KEY env var.');
    }

    const baseUrl = this.config.baseUrl || 'https://api.openai.com/v1';

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model || 'gpt-4o',
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: this.config.temperature ?? 0.3,
        max_tokens: this.config.maxTokens ?? 4096,
        ...options,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;

    return {
      content: data.choices[0]?.message?.content || '',
      usage: {
        prompt: data.usage?.prompt_tokens || 0,
        completion: data.usage?.completion_tokens || 0,
        total: data.usage?.total_tokens || 0,
      },
      model: data.model,
    };
  }
}

// ============================================================
// Anthropic 适配器
// ============================================================

class AnthropicAdapter implements LLMProvider {
  private config: AdapterConfig;
  private logger: pino.Logger;

  constructor(config: AdapterConfig, logger: pino.Logger) {
    this.config = config;
    this.logger = logger.child({ adapter: 'anthropic' });
  }

  getModelInfo(): { name: string; provider: string } {
    return { name: this.config.model, provider: 'anthropic' };
  }

  async chat(
    messages: LLMMessage[],
    options?: Record<string, unknown>
  ): Promise<LLMResponse> {
    const apiKey = this.config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('Anthropic API key not provided. Set it in config or ANTHROPIC_API_KEY env var.');
    }

    const baseUrl = this.config.baseUrl || 'https://api.anthropic.com/v1';

    // Anthropic 使用不同的消息格式
    const systemMsg = messages.find((m) => m.role === 'system');
    const otherMessages = messages.filter((m) => m.role !== 'system');

    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model || 'claude-3-5-sonnet-20241022',
        system: systemMsg?.content || '',
        messages: otherMessages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: this.config.maxTokens ?? 4096,
        temperature: this.config.temperature ?? 0.3,
        ...options,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;

    return {
      content: data.content?.[0]?.text || '',
      usage: {
        prompt: data.usage?.input_tokens || 0,
        completion: data.usage?.output_tokens || 0,
        total: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
      model: data.model,
    };
  }
}

// ============================================================
// Ollama 适配器（本地模型）
// ============================================================

class OllamaAdapter implements LLMProvider {
  private config: AdapterConfig;
  private logger: pino.Logger;

  constructor(config: AdapterConfig, logger: pino.Logger) {
    this.config = config;
    this.logger = logger.child({ adapter: 'ollama' });
  }

  getModelInfo(): { name: string; provider: string } {
    return { name: this.config.model, provider: 'ollama' };
  }

  async chat(
    messages: LLMMessage[],
    options?: Record<string, unknown>
  ): Promise<LLMResponse> {
    const baseUrl = this.config.baseUrl || 'http://localhost:11434';

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model || 'llama3',
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        options: {
          temperature: this.config.temperature ?? 0.3,
          ...options,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;

    return {
      content: data.message?.content || '',
      usage: {
        prompt: data.prompt_eval_count || 0,
        completion: data.eval_count || 0,
        total: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      },
      model: data.model,
    };
  }
}

// ============================================================
// 自定义 API 适配器（兼容 OpenAI API 格式）
// ============================================================

class CustomAdapter implements LLMProvider {
  private config: AdapterConfig;
  private logger: pino.Logger;

  constructor(config: AdapterConfig, logger: pino.Logger) {
    this.config = config;
    this.logger = logger.child({ adapter: 'custom' });
  }

  getModelInfo(): { name: string; provider: string } {
    return { name: this.config.model, provider: 'custom' };
  }

  async chat(
    messages: LLMMessage[],
    options?: Record<string, unknown>
  ): Promise<LLMResponse> {
    const baseUrl = this.config.baseUrl;
    if (!baseUrl) {
      throw new Error('Custom LLM provider requires a baseUrl in config.llm.baseUrl');
    }

    // 默认使用 OpenAI 兼容格式
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model || 'default',
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: this.config.temperature ?? 0.3,
        max_tokens: this.config.maxTokens ?? 4096,
        ...options,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Custom LLM API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;

    return {
      content: data.choices?.[0]?.message?.content || data.content || '',
      usage: data.usage || undefined,
      model: data.model || this.config.model,
    };
  }
}
