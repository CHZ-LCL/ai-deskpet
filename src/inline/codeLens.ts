import * as vscode from 'vscode';
import { CMD } from '../../shared/protocol';
import { L } from '../i18n';

const FUNCTION_KINDS = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);

const explainPrompt = (): string =>
  L(
    '讲解这段代码：它在做什么、关键分支和边界条件、可能的坑。回答控制在 12 行以内，必要时用代码块。',
    'Explain this code: what it does, key branches and edge cases, and likely pitfalls. Keep the answer under 12 lines and use fenced code when needed.',
  );

const refactorPrompt = (): string =>
  L(
    '重构这段代码：改用更现代、更简洁、性能更好的写法，保持行为不变并遵守团队规范。先给【问题】【原因】【方案】【影响】，再给完整替换代码。',
    'Refactor this code: more modern, simpler, and faster while keeping behavior unchanged and following team standards. Start with 【问题】【原因】【方案】【影响】, then give the complete replacement.',
  );

/**
 * 函数级 CodeLens：把“讲解 / 重构”放到代码上方，不用选中、不用开侧边栏。
 * 只在函数/方法上出现，且过滤掉太短的小函数，避免刷屏。
 */
export function registerInlineCodeLens(context: vscode.ExtensionContext): void {
  const provider: vscode.CodeLensProvider = {
    async provideCodeLenses(document) {
      const config = vscode.workspace.getConfiguration('deskpet');
      if (!config.get<boolean>('inline.codeLens', true)) {
        return [];
      }
      if (document.lineCount > 4000) {
        return [];
      }

      let symbols: vscode.DocumentSymbol[] | undefined;
      try {
        symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          document.uri,
        );
      } catch {
        return [];
      }
      if (!symbols?.length) {
        return [];
      }

      const lenses: vscode.CodeLens[] = [];

      const walk = (items: vscode.DocumentSymbol[], depth: number) => {
        if (depth > 4) {
          return;
        }
        for (const symbol of items) {
          if (lenses.length >= 40) {
            return;
          }
          if (!FUNCTION_KINDS.has(symbol.kind) || symbol.range.end.line - symbol.range.start.line < 3) {
            continue;
          }

          const anchor = new vscode.Range(
            symbol.range.start.line,
            0,
            symbol.range.start.line,
            0,
          );
          const args = {
            startLine: symbol.range.start.line,
            startChar: symbol.range.start.character,
            endLine: symbol.range.end.line,
            endChar: symbol.range.end.character,
          };

          lenses.push(
            new vscode.CodeLens(anchor, {
              title: L('$(comment-discussion) 讲解', '$(comment-discussion) Explain'),
              tooltip: L(`让桌宠讲解 ${symbol.name}`, `Ask DeskPet to explain ${symbol.name}`),
              command: CMD.inlineChat,
              arguments: [{ ...args, prompt: explainPrompt() }],
            }),
            new vscode.CodeLens(anchor, {
              title: L('$(tools) 重构', '$(tools) Refactor'),
              tooltip: L(`重构 ${symbol.name}`, `Refactor ${symbol.name}`),
              command: CMD.inlineChat,
              arguments: [{ ...args, prompt: refactorPrompt() }],
            }),
          );

          if (symbol.children?.length) {
            walk(symbol.children, depth + 1);
          }
        }
      };

      walk(symbols, 0);
      return lenses;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'untitled' }], provider),
  );
}
