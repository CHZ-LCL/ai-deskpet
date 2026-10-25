/**
 * 报错文本解析：支持 JS/TS、Python、Java/Kotlin、C#、Go、Rust 的常见堆栈格式。
 * 只做“够用”的识别，不做完整的语言运行时解析；解析不出来就退化成纯文本分析。
 */

export interface StackFrame {
  file: string;
  line: number;
  column?: number;
  symbol?: string;
}

export type FailureLanguage = 'javascript' | 'python' | 'java' | 'csharp' | 'go' | 'rust' | 'unknown';

export interface ParsedFailure {
  language: FailureLanguage;
  message: string;
  frames: StackFrame[];
  raw: string;
}

const JS_FRAME = /^\s*at\s+(?:(?:async\s+)?(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
const PY_FRAME = /^\s*File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?\s*$/;
const JAVA_FRAME = /^\s*at\s+([\w.$<>]+)\(([\w.$]+\.(?:java|kt)):(\d+)\)\s*$/;
const CSHARP_FRAME = /^\s*at\s+(.+?)(?:\s+in\s+(.+?):line\s+(\d+))?\s*$/;
const GO_FRAME = /^\s*(\S+\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?\s*$/;
const RUST_FRAME = /panicked at\s+(.+?):(\d+):(\d+)/;
const ERROR_LINE = /(Error|Exception|panic|fatal|错误|异常|失败)/i;

export function parseFailure(input: string): ParsedFailure | undefined {
  const raw = input.trim();
  if (!raw) {
    return undefined;
  }
  const lines = raw.split(/\r?\n/);
  const frames: StackFrame[] = [];

  const pushFrame = (frame: StackFrame) => {
    if (!frame.file || frames.some((item) => item.file === frame.file && item.line === frame.line)) {
      return;
    }
    frames.push(frame);
  };

  for (const line of lines) {
    const py = PY_FRAME.exec(line);
    if (py) {
      pushFrame({ file: py[1], line: Number(py[2]), symbol: py[3]?.trim() });
      continue;
    }

    const js = JS_FRAME.exec(line);
    if (js && !/^\s*at\s+<anonymous>/.test(line)) {
      pushFrame({
        file: cleanPath(js[2]),
        line: Number(js[3]),
        column: Number(js[4]),
        symbol: js[1]?.trim(),
      });
      continue;
    }

    const java = JAVA_FRAME.exec(line);
    if (java) {
      pushFrame({ file: java[2], line: Number(java[3]), symbol: java[1] });
      continue;
    }

    const cs = CSHARP_FRAME.exec(line);
    if (cs && cs[2]) {
      pushFrame({ file: cleanPath(cs[2]), line: Number(cs[3]), symbol: cs[1]?.trim() });
      continue;
    }

    const go = GO_FRAME.exec(line);
    if (go) {
      pushFrame({ file: go[1], line: Number(go[2]) });
      continue;
    }

    const rust = RUST_FRAME.exec(line);
    if (rust) {
      pushFrame({ file: rust[1], line: Number(rust[2]), column: Number(rust[3]) });
    }
  }

  const language = detectLanguage(raw, frames.length > 0);
  const message = extractMessage(lines, language);

  if (!frames.length && !message) {
    return undefined;
  }

  return { language, message, frames: frames.slice(0, 12), raw };
}

function detectLanguage(raw: string, hasFrames: boolean): FailureLanguage {
  if (/Traceback \(most recent call last\)/.test(raw)) {
    return 'python';
  }
  if (/panicked at /.test(raw) || /note: run with `RUST_BACKTRACE/.test(raw)) {
    return 'rust';
  }
  if (/^\s*at [\w.$]+\([\w.$]+\.java:\d+\)/m.test(raw)) {
    return 'java';
  }
  if (/^\s*at .+ in .+:line \d+/m.test(raw)) {
    return 'csharp';
  }
  if (/^\s*\S+\.go:\d+/m.test(raw) || /^panic: /m.test(raw)) {
    return 'go';
  }
  if (/^\s*at\s+/m.test(raw) && hasFrames) {
    return 'javascript';
  }
  return 'unknown';
}

function extractMessage(lines: string[], language: FailureLanguage): string {
  if (language === 'python') {
    // Traceback 的最后一行才是真正的异常
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (/^[\w.]*(Error|Exception|Warning)\b/.test(line) || /^[\w.]+:\s/.test(line)) {
        return line;
      }
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(panic|fatal|FAIL|error TS\d+|ERROR)\b/i.test(trimmed)) {
      return trimmed;
    }
    if (ERROR_LINE.test(trimmed) && trimmed.length < 400) {
      return trimmed;
    }
  }

  return lines.find((line) => line.trim())?.trim() ?? '';
}

function cleanPath(value: string): string {
  let file = value.trim();
  if (file.startsWith('file://')) {
    try {
      file = decodeURIComponent(new URL(file).pathname);
    } catch {
      file = file.slice('file://'.length);
    }
  }
  file = file.replace(/^webpack:\/\/[^/]*\//, '');
  file = file.replace(/^vscode-file:\/\/vscode-app/, '');
  if (/^\/[a-zA-Z]:\//.test(file)) {
    file = file.slice(1); // Windows 路径被加上了前导斜杠
  }
  return file;
}

/** 粗略判断一段文本像不像报错日志，用于终端输出筛选。 */
export function looksLikeFailure(text: string): boolean {
  if (!text.trim()) {
    return false;
  }
  return (
    /Traceback \(most recent call last\)/.test(text) ||
    /^\s*at\s+\S+.*:\d+:\d+/m.test(text) ||
    /panicked at .+:\d+/.test(text) ||
    /^\s*panic: /m.test(text) ||
    /(Error|Exception):\s/.test(text) ||
    /\bFAIL(ED)?\b/.test(text) ||
    /error TS\d{4}/.test(text) ||
    /npm ERR!/.test(text)
  );
}
