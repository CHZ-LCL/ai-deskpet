import * as vscode from 'vscode';
import type { AiProvider, ChatTurn } from './types';

/**
 * 复用 VS Code 语言模型 API（通常是 Copilot 订阅），无需另配 Key。
 */
export class VscodeLmProvider implements AiProvider {
  readonly id = 'vscode-lm';
  label = 'VS Code 语言模型';

  async chat(messages: ChatTurn[], onDelta: (text: string) => void, token: vscode.CancellationToken): Promise<string> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    const model = models[0];
    if (!model) {
      throw new Error(
        '没有可用的 VS Code 语言模型。请安装并登录 GitHub Copilot，或在设置里把 deskpet.ai.provider 改为 ollama / openai。',
      );
    }
    this.label = `${model.name} (${model.family})`;

    const lmMessages = messages.map((message) =>
      message.role === 'assistant'
        ? vscode.LanguageModelChatMessage.Assistant(message.content)
        : vscode.LanguageModelChatMessage.User(message.content),
    );

    const response = await model.sendRequest(lmMessages, {}, token);
    let full = '';
    for await (const fragment of response.text) {
      full += fragment;
      onDelta(fragment);
    }
    return full;
  }
}
