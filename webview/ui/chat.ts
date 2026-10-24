import type { ChatMessage } from '../../shared/protocol';
import { escapeHtml } from '../util';
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
  private pending?: HTMLElement;

  constructor(private readonly log: HTMLElement) {}

  clear(): void {
    this.log.innerHTML = '';
    this.ids.clear();
    this.streams.clear();
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

  addAssistant(message: ChatMessage): void {    if (this.ids.has(message.id)) {
      this.finish(message.id, message.content);
      return;
    }
    this.append('pet', message.content, message.id, message.error);
    this.scrollToBottom();
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
    this.scrollToBottom();
  }

  /** 系统提示/参考资料链接这类轻量信息。 */
  notice(text: string): void {
    const element = document.createElement('div');
    element.className = 'chat-notice md';
    element.innerHTML = renderMarkdown(text);
    this.log.appendChild(element);
    this.scrollToBottom();
  }

  setPending(label?: string): void {    this.pending?.remove();
    this.pending = undefined;
    if (!label) {
      return;
    }
    const element = document.createElement('div');
    element.className = 'msg role-pet pending';
    element.innerHTML = `<span class="typing"><i></i><i></i><i></i></span><span class="pending-label">${escapeHtml(label)}</span>`;
    this.log.appendChild(element);
    this.pending = element;
    this.scrollToBottom();
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
    this.scrollToBottom();
  }
}
