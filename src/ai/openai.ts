import * as vscode from 'vscode';
import { abortSignalFromToken, normalizeBaseUrl, type AiProvider, type ChatTurn } from './types';

export interface OpenAiOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  label?: string;
}

/**
 * 任意 OpenAI 兼容的 /chat/completions 接口：Ollama、vLLM、DeepSeek、通义、OpenAI 都走这里。
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly id = 'openai';
  readonly label: string;

  constructor(private readonly options: OpenAiOptions) {
    this.label = options.label ?? options.model;
  }

  async chat(messages: ChatTurn[], onDelta: (text: string) => void, token: vscode.CancellationToken): Promise<string> {
    const baseUrl = normalizeBaseUrl(this.options.baseUrl);
    if (!baseUrl) {
      throw new Error('还没有配置 AI 接口地址（deskpet.ai.baseUrl）。');
    }

    const { signal, dispose } = abortSignalFromToken(token);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          temperature: this.options.temperature,
          max_tokens: this.options.maxTokens,
          stream: true,
        }),
      });

      if (!response.ok) {
        const body = await safeText(response);
        throw new Error(`AI 接口返回 ${response.status} ${response.statusText}${body ? `：${body.slice(0, 300)}` : ''}`);
      }

      if (!response.body) {
        throw new Error('AI 接口没有返回可读取的数据流。');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let full = '';
      let finished = false;

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line.startsWith(':')) {
            continue;
          }
          if (!line.startsWith('data:')) {
            continue;
          }
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            finished = true;
            break;
          }
          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string } }>;
              error?: { message?: string };
            };
            if (json.error?.message) {
              throw new Error(json.error.message);
            }
            const piece = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? '';
            if (piece) {
              full += piece;
              onDelta(piece);
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              continue; // 半行数据，等下一块
            }
            throw error;
          }
        }
      }

      return full;
    } catch (error) {
      if (isAbortError(error)) {
        return '';
      }
      if (error instanceof TypeError) {
        throw new Error(
          `连接不上 AI 接口：${baseUrl}\n${error.message}\n\n本地 Ollama 请确认已运行：ollama serve`,
        );
      }
      throw error;
    } finally {
      dispose();
    }
  }
}

export async function listOpenAiModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!response.ok) {
    throw new Error(`获取模型列表失败：${response.status}`);
  }
  const json = (await response.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
  return [...(json.data ?? []).map((item) => item.id).filter(Boolean), ...(json.models ?? []).map((item) => item.name).filter(Boolean)] as string[];
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'));
}
