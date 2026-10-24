export interface PersonaOptions {
  name: string;
  extra?: string;
  level?: number;
  days?: number;
}

/**
 * 桌宠的人设与硬性输出规则。规则写得具体一点，小模型也能稳定遵守。
 */
export function buildSystemPrompt(options: PersonaOptions): string {
  const { name, extra, level, days } = options;
  const lines = [
    `你叫「${name}」，是用户桌面上的 AI 编程搭子，一只住在编辑器里的桌宠。`,
    '性格：亲切、机灵、有点小骄傲，但绝不油腻。你会调侃，但永远站在用户这边。',
    level ? `你和用户已经相处 ${days ?? 1} 天，好感等级 Lv.${level}。` : '',
    '',
    '回答规则：',
    '1. 默认使用简体中文，语速干脆，先给结论再给理由，不要说“作为一个AI”这类废话。',
    '2. 所有代码放在带语言标记的代码块里；给最小可运行示例，不要省略关键部分。',
    '3. 不确定就直说，不要编造不存在的 API、参数或版本号。',
    '4. 只有在信息真的不足时才提问，一次最多问一个问题。',
    '5. 解释代码时先说“这段代码在做什么”，再讲关键分支和潜在坑。',
    '6. 用户可以让你改代码：这时给出完整替换代码，不要用省略号代替原有逻辑。',
    extra?.trim() ? `\n用户额外设定：${extra.trim()}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function explainPrompt(languageId: string, fileName: string): string {
  return [
    `请讲解下面的 ${languageId} 代码（文件：${fileName}）。`,
    '结构：先用一句话总结它的作用，再分点讲关键逻辑，最后指出可能的坑或改进点。',
  ].join('\n');
}

export function fixPrompt(languageId: string, fileName: string, diagnostics: string): string {
  return [
    `下面的 ${languageId} 代码（文件：${fileName}）可能有错误。请修复它。`,
    diagnostics ? `已知的诊断信息：\n${diagnostics}` : '',
    '要求：输出一个完整的、可直接替换原代码的代码块，然后最多用 3 条要点说明改了什么。不要省略原有逻辑。',
  ]
    .filter(Boolean)
    .join('\n');
}

export function refactorPrompt(languageId: string, goal: string): string {
  return [
    `请重构下面的 ${languageId} 代码。目标：${goal || '更清晰、更易维护，保持行为不变'}。`,
    '要求：输出一个完整代码块（可替换原文），再用 3 条以内说明改进点。不要引入新依赖，除非确实必要并说明原因。',
  ].join('\n');
}

export function testPrompt(languageId: string, fileName: string): string {
  return [
    `请为下面的 ${languageId} 代码（文件：${fileName}）编写测试。`,
    '要求：使用该语言最主流的测试框架；覆盖正常路径、边界情况和错误路径；只输出一个完整的测试文件代码块，必要处加简短注释。',
  ].join('\n');
}

export function commitPrompt(diff: string, branch: string): string {
  return [
    '你是一个严格遵守 Conventional Commits 的提交信息生成器。',
    branch ? `当前分支：${branch}` : '',
    '根据下面的 git diff，输出一条提交信息：第一行是 type(scope): 简短描述（英文，不超过 72 字符），空一行后是 1-3 条英文要点。',
    '只输出提交信息本身，不要代码块，不要解释。',
    '',
    '```diff',
    diff,
    '```',
  ]
    .filter(Boolean)
    .join('\n');
}

export function docsPrompt(query: string, sources: Array<{ title: string; url: string; text: string }>): string {
  const material = sources
    .map((source, index) => `[资料 ${index + 1}] ${source.title}\nURL: ${source.url}\n${source.text}`)
    .join('\n\n---\n\n');
  return [
    `用户想了解：${query}`,
    '',
    '下面是检索到的资料。请基于资料回答，要求：',
    '1. 先给一段 2-3 句的结论。',
    '2. 再分点展开，引用处标 [资料 1] 这样的编号。',
    '3. 给出可直接复制的代码示例（如果适用）。',
    '4. 资料没有覆盖的部分，明确说明“资料里没提到”，不要猜。',
    '',
    material,
  ].join('\n');
}

export function docsNoSourcePrompt(query: string, languageId: string): string {
  return [
    `用户在 ${languageId} 项目中问：${query}`,
    '',
    '没有检索到外部资料。请基于你已有的知识回答，并明确提醒用户：这条回答未联网核对，可能不是最新版本。',
    '给出结论、关键 API 的用法示例（代码块），以及建议查阅的官方文档链接（只写你确认存在的域名路径，不要编造具体页面）。',
  ].join('\n');
}
