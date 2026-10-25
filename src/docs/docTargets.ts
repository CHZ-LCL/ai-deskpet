import * as vscode from 'vscode';

export interface SignatureInfo {
  text: string;
  startLine: number;
  endLine: number;
}

export interface DocBlock {
  startLine: number;
  endLine: number;
  text: string;
}

export interface DocDrift {
  line: number;
  name: string;
  missing: string[];
  extra: string[];
}

/**
 * 从符号范围里截出“签名”（到第一个 { 或 Python 的 : 为止）。
 * 不追求语法级精确，够喂给模型、够做参数比对即可。
 */
export function extractSignature(
  document: vscode.TextDocument,
  range: vscode.Range,
  languageId: string,
): SignatureInfo {
  const startLine = range.start.line;
  const maxLine = Math.min(range.end.line, startLine + 12);
  const lines: string[] = [];
  let endLine = startLine;

  for (let line = startLine; line <= maxLine; line += 1) {
    const text = document.lineAt(line).text;
    lines.push(text);
    endLine = line;

    if (languageId === 'python') {
      if (/:\s*(?:#.*)?$/.test(text.trim()) && !/^\s*#/.test(text)) {
        break;
      }
    } else if (/[{;]\s*$/.test(text.trim()) || /=>\s*$/.test(text.trim())) {
      break;
    }
    if (lines.length >= 12) {
      break;
    }
  }

  return { text: lines.join('\n'), startLine, endLine };
}

/** 找签名上方的文档注释（只认 /** *\/ 、/// 、Go/Rust 的 // 块）。 */
export function findDocBlock(
  document: vscode.TextDocument,
  signature: SignatureInfo,
  languageId: string,
): DocBlock | undefined {
  if (languageId === 'python') {
    return undefined;
  }

  let line = signature.startLine - 1;
  if (line < 0) {
    return undefined;
  }
  const first = document.lineAt(line).text.trim();
  if (!first) {
    return undefined;
  }

  const isJsDoc = first.endsWith('*/');
  const isSlashDoc = /^\/\/[/!]/.test(first);
  const isGoDoc = (languageId === 'go' || languageId === 'rust') && /^\/\//.test(first);

  if (isJsDoc) {
    let start = line;
    while (start > 0 && !/^\s*\/\*/.test(document.lineAt(start).text)) {
      start -= 1;
    }
    return {
      startLine: start,
      endLine: line,
      text: document.getText(
        new vscode.Range(start, 0, line, document.lineAt(line).text.length),
      ),
    };
  }

  if (isSlashDoc || isGoDoc) {
    let start = line;
    while (start > 0) {
      const previous = document.lineAt(start - 1).text.trim();
      const matches = isSlashDoc ? /^\/\/[/!]/.test(previous) : /^\/\//.test(previous);
      if (!matches) {
        break;
      }
      start -= 1;
    }
    return {
      startLine: start,
      endLine: line,
      text: document.getText(
        new vscode.Range(start, 0, line, document.lineAt(line).text.length),
      ),
    };
  }

  return undefined;
}

/** Python 的文档字符串在函数体内，单独处理。 */
export function findPythonDocstring(
  document: vscode.TextDocument,
  signature: SignatureInfo,
): DocBlock | undefined {
  let line = signature.endLine + 1;
  while (line < document.lineCount && !document.lineAt(line).text.trim()) {
    line += 1;
  }
  if (line >= document.lineCount) {
    return undefined;
  }

  const text = document.lineAt(line).text;
  const match = /("""|''')/.exec(text);
  if (!match) {
    return undefined;
  }

  const quote = match[1];
  const rest = text.slice(match.index + 3);
  if (rest.includes(quote)) {
    return { startLine: line, endLine: line, text };
  }

  let end = line + 1;
  while (end < document.lineCount && !document.lineAt(end).text.includes(quote)) {
    end += 1;
  }
  end = Math.min(end, document.lineCount - 1);
  return {
    startLine: line,
    endLine: end,
    text: document.getText(new vscode.Range(line, 0, end, document.lineAt(end).text.length)),
  };
}

/**
 * 生成文档时要被替换的范围：
 * - 有旧注释：从注释第一行到签名最后一行；
 * - 没有：只替换签名（模型会返回“注释 + 签名”）；
 * - Python：从 def 行到旧 docstring 结束（没有就只到 def 行）。
 */
export function docReplacementRange(
  document: vscode.TextDocument,
  signature: SignatureInfo,
  languageId: string,
): { range: vscode.Range; existing?: DocBlock } {
  if (languageId === 'python') {
    const existing = findPythonDocstring(document, signature);
    const endLine = existing?.endLine ?? signature.endLine;
    return {
      range: new vscode.Range(
        signature.startLine,
        0,
        endLine,
        document.lineAt(endLine).text.length,
      ),
      existing,
    };
  }

  const existing = findDocBlock(document, signature, languageId);
  const startLine = existing?.startLine ?? signature.startLine;
  return {
    range: new vscode.Range(
      startLine,
      0,
      signature.endLine,
      document.lineAt(signature.endLine).text.length,
    ),
    existing,
  };
}

export function docStyleFor(languageId: string): string {  if (languageId === 'python') {
    return 'Google 风格 docstring（""" 三引号，Args: / Returns: / Raises:）';
  }
  if (languageId === 'go') {
    return 'Go doc 注释（// 开头，首词是符号名）';
  }
  if (languageId === 'rust') {
    return 'Rust doc 注释（///，支持 # Examples）';
  }
  if (languageId === 'java' || languageId === 'kotlin' || languageId === 'csharp') {
    return 'Javadoc / XML doc 注释';
  }
  return 'JSDoc / TSDoc（/** ... */，@param / @returns / @throws）';
}

/** 找到包含指定行的最小符号（函数/方法/类），供文档生成定位。 */
export async function findEnclosingSymbol(
  document: vscode.TextDocument,
  line: number,
): Promise<vscode.DocumentSymbol | undefined> {
  try {
    const symbols = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    )) ?? [];
    let best: vscode.DocumentSymbol | undefined;

    const walk = (items: vscode.DocumentSymbol[]) => {
      for (const symbol of items) {
        if (symbol.range.start.line <= line && symbol.range.end.line >= line) {
          if (!best || symbol.range.start.line >= best.range.start.line) {
            best = symbol;
          }
          if (symbol.children?.length) {
            walk(symbol.children);
          }
        }
      }
    };
    walk(symbols);
    return best;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ 文档漂移

/**
 * 确定性检查：已有文档里写了参数说明，但参数名和签名对不上。
 * 只检查“本来就在写参数文档”的函数，避免把只有一句摘要的注释也报出来。
 */
export function scanDocDrift(text: string, languageId: string): DocDrift[] {
  return languageId === 'python' ? scanPythonDrift(text) : scanJsDocDrift(text);
}

/** JSDoc 只在“紧贴声明”时才算数，按行扫描避免跨函数误匹配。 */
function scanJsDocDrift(text: string): DocDrift[] {
  const lines = text.split('\n');
  const drift: DocDrift[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim().startsWith('/**')) {
      continue;
    }

    let end = index;
    while (end < lines.length && !lines[end].includes('*/')) {
      end += 1;
    }
    if (end >= lines.length) {
      break;
    }

    const doc = lines.slice(index, end + 1).join('\n');
    const documented = jsDocParams(doc);
    if (!documented.size) {
      index = end;
      continue;
    }

    let declLine = end + 1;
    while (declLine < lines.length && !lines[declLine].trim()) {
      declLine += 1;
    }
    const declaration = collectDeclaration(lines, declLine);
    if (declaration) {
      const params = splitParams(declaration.params)
        .map(paramName)
        .filter((item): item is string => Boolean(item) && item !== 'this');
      const missing = params.filter((param) => !documented.has(param));
      const extra = [...documented].filter((param) => !params.includes(param));
      if (missing.length || extra.length) {
        drift.push({ line: index + 1, name: declaration.name, missing, extra });
      }
    }
    index = end;
  }

  return drift;
}

function collectDeclaration(
  lines: string[],
  start: number,
): { name: string; params: string } | undefined {
  let buffer = '';

  for (let index = start; index < Math.min(lines.length, start + 10); index += 1) {
    buffer += `${lines[index]}\n`;
    const open = buffer.indexOf('(');
    if (open < 0) {
      if (/[;=]\s*$/.test(buffer.trim())) {
        return undefined;
      }
      continue;
    }

    let depth = 0;
    let close = -1;
    for (let cursor = open; cursor < buffer.length; cursor += 1) {
      if (buffer[cursor] === '(') {
        depth += 1;
      } else if (buffer[cursor] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = cursor;
          break;
        }
      }
    }
    if (close < 0) {
      continue;
    }

    const header = buffer.slice(0, open);
    const named =
      /(?:function|const|let|var|class|interface|enum)\s+([A-Za-z_$][\w$]*)/.exec(header) ??
      /([A-Za-z_$][\w$]*)\s*$/.exec(header.trim());
    if (!named) {
      return undefined;
    }
    return { name: named[1], params: buffer.slice(open + 1, close) };
  }

  return undefined;
}

function scanPythonDrift(text: string): DocDrift[] {
  const drift: DocDrift[] = [];
  const pattern = /def\s+(\w+)\s*\(([^)]*)\)[^:]*:\s*\n\s*(?:"""|''')([\s\S]*?)(?:"""|''')/g;

  for (const match of text.matchAll(pattern)) {
    const documented = pythonDocParams(match[3] ?? '');
    if (!documented.size) {
      continue;
    }
    const params = splitParams(match[2] ?? '')
      .map(paramName)
      .filter((item): item is string => Boolean(item) && item !== 'self' && item !== 'cls');
    const missing = params.filter((param) => !documented.has(param));
    const extra = [...documented].filter((param) => !params.includes(param));
    if (missing.length || extra.length) {
      drift.push({
        line: text.slice(0, match.index ?? 0).split('\n').length,
        name: match[1],
        missing,
        extra,
      });
    }
  }

  return drift;
}

function jsDocParams(doc: string): Set<string> {
  const names = new Set<string>();
  for (const match of doc.matchAll(/@param(?:\s+\{[^}]*\})?\s+(\[?[\w$.]+\]?)/g)) {
    const name = match[1].replace(/^\[|\]$/g, '').split(/[.=]/)[0];
    if (name) {
      names.add(name);
    }
  }
  return names;
}

function pythonDocParams(doc: string): Set<string> {
  const names = new Set<string>();
  for (const match of doc.matchAll(/^\s*:param\s+(?:[\w[\], .]+\s+)?(\w+)\s*:/gm)) {
    names.add(match[1]);
  }
  const args = /Args:\s*\n([\s\S]*?)(?:\n\s*\n|Returns:|Raises:|$)/.exec(doc);
  if (args) {
    for (const line of args[1].split('\n')) {
      const match = /^\s*(\w+)\s*(?:\([^)]*\))?\s*:/.exec(line);
      if (match) {
        names.add(match[1]);
      }
    }
  }
  return names;
}

function splitParams(raw: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';

  for (const char of raw) {
    if ('(<[{'.includes(char)) {
      depth += 1;
    } else if (')>]}'.includes(char)) {
      depth = Math.max(0, depth - 1);
    }
    if (char === ',' && depth === 0) {
      result.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    result.push(current);
  }
  return result;
}

function paramName(raw: string): string | undefined {
  const cleaned = raw.trim().replace(/^\.\.\./, '').replace(/^readonly\s+/, '');
  if (!cleaned) {
    return undefined;
  }
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    const inner = cleaned.slice(1, cleaned.search(/[}\]]/));
    const first = inner.split(',')[0]?.trim().split(':')[0]?.trim();
    return first || undefined;
  }
  const match = /^([A-Za-z_$][\w$]*)/.exec(cleaned);
  return match?.[1];
}
