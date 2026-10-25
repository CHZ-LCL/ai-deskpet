import type { AdviceAction, AdviceCard, ChatMessage } from '../../shared/protocol';
import { escapeHtml } from '../util';
import { L } from '../i18n';
import { renderMarkdown } from './markdown';

interface Stream {
  element: HTMLElement;
  content: HTMLElement;
  text: string;
  frame?: number;
}

/** 对话列表渲染：支持流式增量、去重、自动滚动。 */
export class ChatView {
  private readonly ids = new Set<string>();
  private readonly streams = new Map<string, Stream>();
  private empty?: HTMLElement;

  constructor(
    private readonly log: HTMLElement,
    private readonly emptyText: () => string,
  ) {}

  clear(): void {
    this.log.innerHTML = '';
    this.ids.clear();
    this.streams.clear();
    this.empty = undefined;
    this.syncEmpty();
  }

  addUser(message: ChatMessage): void {
    this.append('user', message.content, message.id);
  }

  addHistory(messages: ChatMessage[]): void {
    for (const message of messages) {
      this.append(message.role === 'assistant' ? 'pet' : 'user', message.content, message.id, message.error);
    }
    this.scrollToBottom(true);
  }

  begin(id: string): void {
    if (this.streams.has(id)) {
      const stream = this.streams.get(id)!;
      stream.text = '';
      stream.content.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
      this.scrollToBottom();
      return;
    }
    const element = document.createElement('div');
    element.className = 'msg role-pet streaming';
    const content = document.createElement('div');
    content.className = 'msg-body md';
    content.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    element.appendChild(content);
    this.log.appendChild(element);
    this.streams.set(id, { element, content, text: '' });
    this.syncEmpty();
    this.scrollToBottom();
  }

  delta(id: string, text: string): void {
    const stream = this.streams.get(id);
    if (!stream) {
      return;
    }
    stream.text += text;
    if (stream.frame) {
      return;
    }
    stream.frame = requestAnimationFrame(() => {
      stream.frame = undefined;
      stream.content.innerHTML = renderMarkdown(stream.text);
      this.scrollToBottom();
    });
  }

  finish(id: string, text: string): void {
    const stream = this.streams.get(id);
    if (!stream) {
      this.append('pet', text, id);
      return;
    }
    if (stream.frame) {
      cancelAnimationFrame(stream.frame);
      stream.frame = undefined;
    }
    const finalText = text || stream.text;
    stream.content.innerHTML = renderMarkdown(finalText);
    stream.element.classList.remove('streaming');
    this.streams.delete(id);
    this.ids.add(id);
    this.syncEmpty();
    this.scrollToBottom();
  }

  fail(id: string, message: string): void {
    const stream = this.streams.get(id);
    if (stream) {
      stream.element.classList.remove('streaming');
      stream.element.classList.add('is-error');
      stream.content.innerHTML = `<p class="err">${escapeHtml(message)}</p>`;
      this.streams.delete(id);
      this.ids.add(id);
    } else {
      this.append('pet', message, `err-${id}`, true);
    }
    this.syncEmpty();
    this.scrollToBottom();
  }

  /** 主动提醒：安静模式下只在这里留一条，不抢焦点。 */
  addNudge(text: string, actions?: Array<{ label: string; command?: string; send?: string }>): void {
    const element = document.createElement('div');
    element.className = 'chat-nudge';

    const body = document.createElement('div');
    body.className = 'md';
    body.innerHTML = renderMarkdown(text);
    element.appendChild(body);

    if (actions?.length) {
      const row = document.createElement('div');
      row.className = 'chat-nudge-actions';
      for (const action of actions) {
        const button = document.createElement('button');
        button.textContent = action.label;
        if (action.command) {
          button.dataset.command = action.command;
        }
        if (action.send) {
          button.dataset.send = action.send;
        }
        row.appendChild(button);
      }
      element.appendChild(row);
    }

    this.log.appendChild(element);
    this.syncEmpty();
    this.scrollToBottom();
  }

  /** 修复/重构的“变更说明”卡片：先讲清问题、原因、方案、影响，再让用户决定。 */
  addAdvice(advice: AdviceCard): void {
    if (this.log.querySelector(`[data-advice="${advice.id}"]`)) {
      return;
    }

    const element = document.createElement('div');
    element.className = 'advice-card';
    element.dataset.advice = advice.id;

    const row = (label: string, value: string) =>
      value
        ? `<div class="advice-row"><span class="advice-label">${label}</span><div class="md">${renderMarkdown(value)}</div></div>`
        : '';

    element.innerHTML = `
      <div class="advice-head">
        <span class="advice-title">${escapeHtml(advice.title)}</span>
        <span class="advice-loc">${escapeHtml(advice.file)}:${advice.startLine}-${advice.endLine}</span>
      </div>
      ${row(L('问题'), advice.problem)}
      ${row(L('原因'), advice.cause)}
      ${row(L('方案'), advice.plan)}
      ${row(L('影响'), advice.impact)}
      <div class="advice-actions">
        <button data-advice-action="diff">${L('先看差异')}</button>
        <button data-advice-action="apply" class="primary">${L('应用修改')}</button>
        <button data-advice-action="copy" class="ghost">${L('复制代码')}</button>
        <button data-advice-action="dismiss" class="ghost">${L('忽略')}</button>
      </div>`;

    this.log.appendChild(element);
    this.syncEmpty();
    this.scrollToBottom();
  }

  resolveAdvice(id: string, action: AdviceAction, ok: boolean): void {
    const card = this.log.querySelector<HTMLElement>(`[data-advice="${id}"]`);
    if (!card) {
      return;
    }
    card.querySelectorAll('button').forEach((button) => {
      button.disabled = true;
    });
    card.classList.add(ok ? 'is-done' : 'is-failed');

    const messages: Record<AdviceAction, string> = {
      apply: L('已应用到编辑器'),
      diff: L('已打开差异预览'),
      copy: L('代码已复制到剪贴板'),
      dismiss: L('已忽略这条建议'),
    };
    const footer = document.createElement('div');
    footer.className = 'advice-foot';
    footer.textContent = ok ? messages[action] : L('操作失败，请重新生成建议');
    card.appendChild(footer);
  }

  /** 系统提示/参考资料链接这类轻量信息。 */
  notice(text: string): void {
    const element = document.createElement('div');
    element.className = 'chat-notice md';
    element.innerHTML = renderMarkdown(text);
    this.log.appendChild(element);
    this.syncEmpty();
    this.scrollToBottom();
  }

  /** 切换语言后刷新空状态提示。 */
  refreshEmpty(): void {
    if (this.empty) {
      this.empty.textContent = this.emptyText();
    } else {
      this.syncEmpty();
    }
  }

  scrollToBottom(force = false): void {
    const distance = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight;
    if (force || distance < 120) {
      this.log.scrollTop = this.log.scrollHeight;
    }
  }

  private append(role: 'user' | 'pet', text: string, id: string, isError = false): void {
    if (id && this.ids.has(id)) {
      return;
    }
    const element = document.createElement('div');
    element.className = `msg role-${role}${isError ? ' is-error' : ''}`;
    const body = document.createElement('div');
    body.className = 'msg-body md';
    if (role === 'user') {
      body.textContent = text;
    } else {
      body.innerHTML = renderMarkdown(text);
    }
    element.appendChild(body);
    this.log.appendChild(element);
    if (id) {
      this.ids.add(id);
    }
    this.syncEmpty();
    this.scrollToBottom();
  }

  private syncEmpty(): void {
    const hasContent = this.log.querySelector('.msg, .chat-nudge, .advice-card, .chat-notice');
    if (hasContent) {
      this.empty?.remove();
      this.empty = undefined;
      return;
    }
    if (!this.empty) {
      this.empty = document.createElement('div');
      this.empty.className = 'chat-empty';
      this.log.appendChild(this.empty);
    }
    this.empty.textContent = this.emptyText();
  }
}
