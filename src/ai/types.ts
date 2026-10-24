import * as vscode from 'vscode';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiProvider {
  readonly id: string;
  readonly label: string;
  /** 流式对话；返回完整文本。 */
  chat(messages: ChatTurn[], onDelta: (text: string) => void, token: vscode.CancellationToken): Promise<string>;
}

export function abortSignalFromToken(token: vscode.CancellationToken): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const sub = token.onCancellationRequested(() => controller.abort());
  return { signal: controller.signal, dispose: () => sub.dispose() };
}

export function normalizeBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!url) {
    return url;
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  // 用户常常直接填 Ollama 地址而不带 /v1
  if (!/\/v\d+(\.\d+)?$/.test(url) && /(:\d+)?$/.test(url)) {
    url = `${url}/v1`;
  }
  return url;
}
