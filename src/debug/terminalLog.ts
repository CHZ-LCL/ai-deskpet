import * as vscode from 'vscode';
import { looksLikeFailure } from './stackTrace';

export interface FailureLog {
  command: string;
  output: string;
  exitCode?: number;
  at: number;
}

let lastFailure: FailureLog | undefined;

export function setLastFailure(log: FailureLog): void {
  lastFailure = log;
}

export function getLastFailure(): FailureLog | undefined {
  return lastFailure;
}

interface ShellExecutionLike {
  read(): AsyncIterable<string>;
  commandLine?: { value?: string };
}

interface StartEvent {
  execution: ShellExecutionLike;
}

interface EndEvent {
  execution: ShellExecutionLike;
  exitCode: number | undefined;
}

interface TerminalWindowApi {
  onDidStartTerminalShellExecution?: (listener: (event: StartEvent) => unknown) => vscode.Disposable;
  onDidEndTerminalShellExecution?: (listener: (event: EndEvent) => unknown) => vscode.Disposable;
}

/**
 * 捕获终端命令输出（VS Code 1.93+ 的 Shell Integration API）。
 * 失败时把最后一段日志存起来，但不主动弹窗——由打扰策略决定怎么提醒。
 */
export function registerTerminalCapture(
  context: vscode.ExtensionContext,
  onFailure?: (log: FailureLog) => void,
): void {
  const api = vscode.window as unknown as TerminalWindowApi;
  if (!api.onDidStartTerminalShellExecution || !api.onDidEndTerminalShellExecution) {
    return;
  }

  const buffers = new WeakMap<ShellExecutionLike, { command: string; text: string }>();

  context.subscriptions.push(
    api.onDidStartTerminalShellExecution((event) => {
      const entry = { command: event.execution.commandLine?.value ?? '', text: '' };
      buffers.set(event.execution, entry);
      void (async () => {
        try {
          for await (const chunk of event.execution.read()) {
            entry.text += chunk;
            // 只保留尾部，避免长构建把内存吃满
            if (entry.text.length > 40_000) {
              entry.text = entry.text.slice(-30_000);
            }
          }
        } catch {
          // 终端关闭或读取被取消
        }
      })();
    }),
    api.onDidEndTerminalShellExecution((event) => {
      const entry = buffers.get(event.execution);
      if (!entry) {
        return;
      }
      buffers.delete(event.execution);

      const failed =
        (typeof event.exitCode === 'number' && event.exitCode !== 0) || looksLikeFailure(entry.text.slice(-8000));
      if (!failed) {
        return;
      }

      setLastFailure({
        command: entry.command,
        output: entry.text.slice(-14_000),
        exitCode: event.exitCode,
        at: Date.now(),
      });
      onFailure?.({
        command: entry.command,
        output: entry.text.slice(-14_000),
        exitCode: event.exitCode,
        at: Date.now(),
      });
    }),
  );
}
