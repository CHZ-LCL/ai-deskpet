import * as vscode from 'vscode';
import { L } from '../i18n';
import { OpenAiCompatibleProvider } from './openai';
import { VscodeLmProvider } from './vscodeLm';
import type { AiProvider } from './types';

export const API_KEY_SECRET = 'deskpet.apiKey';

export type ProviderKind = 'ollama' | 'openai' | 'vscode-lm';

export interface AiSettings {
  provider: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export async function readAiSettings(context: vscode.ExtensionContext): Promise<AiSettings> {
  const config = vscode.workspace.getConfiguration('deskpet');
  const provider = config.get<ProviderKind>('ai.provider', 'ollama');
  const apiKey = await context.secrets.get(API_KEY_SECRET);
  return {
    provider,
    baseUrl: config.get<string>('ai.baseUrl', 'http://127.0.0.1:11434/v1'),
    apiKey: apiKey || undefined,
    model: config.get<string>('ai.model', 'qwen2.5-coder:14b'),
    temperature: config.get<number>('ai.temperature', 0.6),
    maxTokens: config.get<number>('ai.maxTokens', 2048),
  };
}

export function createProvider(settings: AiSettings): AiProvider {
  if (settings.provider === 'vscode-lm') {
    return new VscodeLmProvider();
  }
  return new OpenAiCompatibleProvider({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    label: settings.provider === 'ollama' ? `Ollama · ${settings.model}` : settings.model,
  });
}

export function providerLabel(settings: AiSettings): string {
  if (settings.provider === 'vscode-lm') {
    return 'VS Code LM';
  }
  return `${settings.provider === 'ollama' ? 'Ollama' : L('OpenAI 兼容', 'OpenAI-compatible')} · ${settings.model}`;
}
