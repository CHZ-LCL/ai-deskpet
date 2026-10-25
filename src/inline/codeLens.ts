import * as vscode from 'vscode';
import { CMD } from '../../shared/protocol';

const FUNCTION_KINDS = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);

const EXPLAIN_PROMPT =
  '讲解这段代码：它在做什么、关键分支和边界条件、可能的坑。回答控制在 12 行以内，必要时用代码块。';

const REFACTOR_PROMPT =
  '重构这段代码：改用更现代、更简洁、性能更好的写法，保持行为不变并遵守团队规范。' +
  '先给【问题】【原因】【方案】【影响】，再给完整替换代码。';

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
              title: '$(comment-discussion) 讲解',
              tooltip: `让桌宠讲解 ${symbol.name}`,
              command: CMD.inlineChat,
              arguments: [{ ...args, prompt: EXPLAIN_PROMPT }],
            }),
            new vscode.CodeLens(anchor, {
              title: '$(tools) 重构',
              tooltip: `重构 ${symbol.name}`,
              command: CMD.inlineChat,
              arguments: [{ ...args, prompt: REFACTOR_PROMPT }],
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
