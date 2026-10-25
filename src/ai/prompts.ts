import type { PetTone, ReplyLength } from '../../shared/protocol';

export interface PersonaOptions {
  name: string;
  extra?: string;
  level?: number;
  days?: number;
  userName?: string;
  tone?: PetTone;
  replyLength?: ReplyLength;
}

const TONE_LINES: Record<PetTone, string> = {
  warm: '语气温和、鼓励，先共情再讲事，但别灌鸡汤，也不要为了安慰而模糊技术结论。',
  sharp: '语气直接、犀利，可以说实话甚至吐槽代码，但不对人；技术结论必须准确。',
  concise: '极简：能一句话说清就不说两句，少用形容词，不重复用户的话。',
  chuuni: '偶尔中二（“吾”“凡人”），但技术内容必须严谨，不能为了梗牺牲准确性。',
};

const LENGTH_LINES: Record<ReplyLength, string> = {
  short: '默认回答控制在 6 行以内，除非用户明确要求展开。',
  normal: '',
  detailed: '可以展开讲：补边界、给反例，必要时分小标题。',
};

/**
 * 桌宠的人设与硬性输出规则。规则写得具体一点，小模型也能稳定遵守。
 */
export function buildSystemPrompt(options: PersonaOptions): string {
  const { name, extra, level, days, userName, tone, replyLength } = options;
  const lines = [
    `你叫「${name}」，是用户桌面上的 AI 编程搭子，一只住在编辑器里的桌宠。`,
    '性格：亲切、机灵、有点小骄傲，但绝不油腻。你会调侃，但永远站在用户这边。',
    level ? `你和用户已经相处 ${days ?? 1} 天，好感等级 Lv.${level}。` : '',
    userName ? `称呼用户为「${userName}」。` : '',
    tone ? `说话风格：${TONE_LINES[tone]}` : '',
    replyLength ? LENGTH_LINES[replyLength] : '',
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
    `下面的 ${languageId} 代码（文件：${fileName}）可能有错误。请先诊断，再修复。`,
    diagnostics ? `已知的诊断信息：\n${diagnostics}` : '',
    '输出格式严格如下（某一项确实没有就写“无”）：',
    '【问题】一句话说清哪里不对、用户会看到什么现象',
    '【原因】为什么会这样，触发条件是什么',
    '【方案】你准备怎么改，最多 3 条，每条一行',
    '【影响】改动会波及哪些调用方、行为或边界条件',
    '然后输出一个完整的、可直接替换原代码的代码块，不要省略原有逻辑。',
  ]
    .filter(Boolean)
    .join('\n');
}

export function refactorPrompt(languageId: string, goal: string): string {
  return [
    `请重构下面的 ${languageId} 代码。目标：${goal || '更清晰、更易维护，保持行为不变'}。`,
    '输出格式严格如下（某一项确实没有就写“无”）：',
    '【问题】现状哪里不好，为什么要重构',
    '【原因】它带来了什么具体成本（可读性 / 重复 / 耦合 / 性能）',
    '【方案】改造步骤，最多 3 条',
    '【影响】行为是否改变、需要同步改哪些地方、有什么风险',
    '然后输出一个完整代码块（可替换原文）。不要引入新依赖，除非确实必要并说明原因。',
  ].join('\n');
}

export type TeachDepth = 'line' | 'logic' | 'design';

export const TEACH_DEPTH_LABEL: Record<TeachDepth, string> = {
  line: '逐行讲解',
  logic: '逻辑梳理',
  design: '设计思路',
};

/**
 * “一对一老师”模式：按深度把一段代码讲透。
 * 行号约束写死，避免模型编造位置。
 */
export function teachPrompt(
  languageId: string,
  fileName: string,
  depth: TeachDepth,
  references: string,
): string {
  const shared = [
    `你在给一个刚接手这段 ${languageId} 代码的开发者上课（文件：${fileName}）。`,
    '不要复述代码表面，讲“为什么”和“所以然后”。引用位置时统一用 L<行号>，行号以给定代码为准，不要编造。',
    references ? `\n这段代码在项目里的调用/引用位置：\n${references}` : '',
  ];

  if (depth === 'line') {
    return [
      ...shared,
      '',
      '请做**逐行讲解**：',
      '1. 跳过空行、单独的括号等无信息量的行，只讲有逻辑的行。',
      '2. 每行一个条目，格式：`L12` — 这行在做什么；必要时补一句“为什么这么写”。',
      '3. 连续的多行如果是一个整体（如一个表达式、一个配置对象），合并成一条并写明行号范围。',
      '4. 最后用 2-3 句话总结这段代码的整体意图。',
    ].join('\n');
  }

  if (depth === 'logic') {
    return [
      ...shared,
      '',
      '请做**逻辑梳理**：',
      '1. 按实际执行顺序拆成步骤（1/2/3…），标出分支、循环、提前返回和异常路径。',
      '2. 单独列出所有**副作用**（I/O、状态修改、网络、文件、全局变量）。',
      '3. 用文字画一条数据流：输入 → 中间形态 → 输出。',
      '4. 指出最容易出错或最难测试的一步，并说明原因。',
    ].join('\n');
  }

  return [
    ...shared,
    '',
    '请讲**设计思路**：',
    '1. 这段代码要解决的核心问题是什么，它做了哪些假设。',
    '2. 为什么这样分层/抽象/命名；如果换成另一种常见写法，会付出什么代价。',
    '3. 从调用方的角度看，这个接口的约束是什么（参数含义、返回值、错误处理）。',
    '4. 如果要扩展或替换这部分，应该改哪里、不该动哪里。',
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

export interface PromptSnippet {
  file: string;
  startLine: number;
  endLine: number;
  languageId: string;
  code: string;
}

const EXPLAIN_FORMAT = [  '输出格式严格如下（某项确实没有就写“无”）：',
  '【问题】用一句人话说明用户会遇到什么现象，不要复述报错原文',
  '【原因】报错到底在说什么：哪个值、哪一步不满足什么假设；如果是堆栈，指出真正的出错点（可以提“上层调用传入了 X，但这里假设它是 Y”）',
  '【方案】怎么改，最多 3 条',
  '【影响】改动会影响哪些调用方、边界条件或错误处理',
];

export function failurePrompt(
  failure: { language: string; message: string; raw: string },
  target: PromptSnippet | undefined,
  related: string,
): string {
  return [
    '用户遇到了下面这段报错/堆栈。请像一位耐心的老师那样，先读懂它，再解释给人听，最后才给代码。',
    '',
    ...EXPLAIN_FORMAT,
    '然后**只输出一个代码块**：替换下面标注的文件片段，不要输出其它文件的内容，不要用省略号。',
    '',
    target
      ? [
          `目标文件：${target.file}（${target.languageId}，第 ${target.startLine}-${target.endLine} 行，整段替换）`,
          '```' + target.languageId,
          target.code,
          '```',
        ].join('\n')
      : '（没有定位到具体文件，这次只解释、不输出代码块。）',
    related ? `\n堆栈里其它已定位的代码：\n${related}` : '',
    '',
    `原始报错（${failure.language}，核心信息：${failure.message || '未识别'}）：`,
    '```text',
    failure.raw.slice(0, 7000),
    '```',
    '',
    '要求：解释要具体到变量和取值，不要泛泛而谈“可能为空”。如果信息不足，明确说出你缺什么，而不是猜。',
  ]
    .filter(Boolean)
    .join('\n');
}

export function diagnosticPrompt(
  diagnostics: Array<{ message: string; severity: string; source?: string; line: number }>,
  target: PromptSnippet,
): string {
  const list = diagnostics
    .map((item) => `- [${item.severity}] 第 ${item.line} 行：${item.message}${item.source ? `（${item.source}）` : ''}`)
    .join('\n');
  return [
    '用户在编辑器里遇到了下面的诊断信息（波浪线/编译错误）。请先用通俗的话解释，再给修复代码。',
    '',
    ...EXPLAIN_FORMAT,
    '然后**只输出一个代码块**，完整替换下面这段代码：',
    `文件：${target.file}（${target.languageId}，第 ${target.startLine}-${target.endLine} 行）`,
    '```' + target.languageId,
    target.code,
    '```',
    '',
    '诊断信息：',
    list,
    '',
    '要求：不要修改这段代码里与报错无关的逻辑；如果根因在别处（比如类型定义、调用方），在【原因】里说清楚，并说明为什么只改这里。',
  ].join('\n');
}

export function rulesPrompt(
  file: string,
  languageId: string,
  findings: string,
  code: string,
  scope: string,
): string {
  return [
    `你在按团队规范审查 ${file} 的${scope}。本地规则扫描先给出了下面这些线索（可能有误报）：`,
    '',
    findings,
    '',
    '要求：',
    '1. 先逐条判断：真正要改 / 可以不改（说明理由）。不要为了“清零”而改坏可读性。',
    '2. 选**最有价值的一处**给出补丁，保持行为不变；不要顺手重写无关逻辑。',
    '3. 如果某个问题是全局性的（比如命名风格），在【影响】里说明，不要在这一处硬改。',
    '',
    '输出格式严格如下：',
    '【问题】最有价值的那个问题是什么，会造成什么实际影响',
    '【原因】为什么现有写法不好（可读性 / 性能 / 安全 / 一致性）',
    '【方案】怎么改，最多 3 条',
    '【影响】行为是否变化、需要同步改哪些地方',
    '然后只输出一个代码块，替换下面这段代码：',
    '```' + languageId,
    code,
    '```',
  ].join('\n');
}

export function testsPrompt(options: {
  file: string;
  languageId: string;
  signature: string;
  code: string;
  framework: string;
  idiom: string;
  suggestedFile: string;
}): string {
  return [
    `你在为 ${options.file} 里的符号写单元测试。`,
    `测试框架：${options.framework}；写法：${options.idiom}；建议文件：${options.suggestedFile}。`,
    '',
    '要求：',
    '1. 先列出要覆盖的分支，每条格式 `- 场景：输入 → 预期`。至少包含：正常路径、参数缺失/为空、边界值（0、-1、空集合、超长）、异常或异步拒绝；签名里有可选参数或联合类型时逐个覆盖。',
    '2. 然后**只输出一个完整测试文件的代码块**，不要输出其它内容。',
    '3. 不要 mock 被测函数本身；必须 mock 外部依赖时，用一行注释说明理由。',
    '4. 测试名说清场景，避免 test1 / test2。',
    '5. 不要修改产品代码；如果被测逻辑无法测试（例如依赖全局状态），在代码块外用一句话说明。',
    '',
    '签名：',
    '```' + options.languageId,
    options.signature,
    '```',
    '',
    '实现：',
    '```' + options.languageId,
    options.code,
    '```',
  ].join('\n');
}

export function documentationPrompt(options: {
  file: string;
  languageId: string;
  style: string;
  signature: string;
  existingDoc?: string;
}): string {
  return [
    `为 ${options.file} 里的符号生成或扩写文档注释。`,
    `语言：${options.languageId}；风格：${options.style}。`,
    '',
    '当前签名：',
    '```' + options.languageId,
    options.signature,
    '```',
    options.existingDoc
      ? ['', '已有注释（保留其中有效的信息和作者意图）：', '```', options.existingDoc, '```'].join('\n')
      : '\n目前没有文档注释。',
    '',
    '要求：',
    '1. 一句话摘要说清“做什么”，不要复述实现细节。',
    '2. 每个参数写含义、单位/取值范围、是否可以为空。',
    '3. 写清返回值与可能抛出的错误（没有就省略该项）。',
    '4. 只有在确实有帮助时才加一个简短示例。',
    '5. 不确定的行为写 `TODO(确认)`，不要编造。',
    '6. **只输出一个代码块**：注释 + 完整签名（Python 是 def 行 + docstring），不要函数体。',
  ]
    .filter(Boolean)
    .join('\n');
}

export function fixAllPrompt(options: {
  file: string;
  languageId: string;
  diagnostics: string;
  code: string;
}): string {
  return [
    `请修复 ${options.file} 里的编译/类型错误。`,
    '',
    '编辑器报告的问题：',
    options.diagnostics,
    '',
    '要求：',
    '1. 只修这些错误，不要重构无关代码，不要改公共 API，不要换风格。',
    '2. 输出**完整文件**的一个代码块：保留所有原有 import/export、注释和未涉及错误的逻辑，不能省略、不能用“…其余不变”。',
    '3. 如果某个错误无法在不改变行为的前提下修复，保留原样，并在代码块外用一句话说明。',
    '4. 不要引入新依赖。',
    '',
    '当前完整文件：',
    '```' + options.languageId,
    options.code,
    '```',
  ].join('\n');
}

export function rewritePrompt(options: {
  file: string;
  languageId: string;
  instruction: string;
  code: string;
}): string {
  return [
    `请对 ${options.file} 做一次全文修改。`,
    `用户的要求：${options.instruction}`,
    '',
    '输出格式严格如下（某项确实没有就写“无”）：',
    '【问题】现在哪里不满足要求，或这次要改什么',
    '【原因】为什么要改（可读性/正确性/性能/一致性）',
    '【方案】改动的要点，最多 3 条',
    '【影响】行为是否变化、需要同步改哪些调用方',
    '然后输出**一个完整文件**的代码块：',
    '- 保留所有原有 import/export、注释和与本次要求无关的逻辑；',
    '- 不能省略、不能用“其余不变”之类的占位；',
    '- 不要引入新依赖，不要顺手重构无关代码。',
    '',
    '当前完整文件：',
    '```' + options.languageId,
    options.code,
    '```',
  ].join('\n');
}

export function reviewPrompt(file: string, languageId: string, code: string): string {  return [
    `请对下面这段 ${languageId} 代码（${file}）做一次静态检修。这不是让你重写，而是找问题。`,
    '',
    '检查清单：空值与未定义、边界与越界、异常被吞/未处理、资源泄漏、并发与竞态、',
    '错误码被忽略、类型断言滥用、异步未 await、循环里的重复计算、日志/敏感信息泄漏。',
    '',
    '输出要求：',
    '1. 只列**真实存在**的问题，按严重度排序：`[高]` / `[中]` / `[低]`。',
    '2. 每条格式：`[高] L42 — 问题一句话`，下一行缩进说明“触发条件 + 会造成什么后果”。',
    '3. 没有发现问题的类别不要提。',
    '4. 最后用一行给出建议优先修的那一条，并说明为什么。',
    '5. 不要输出代码块，除非某个问题必须用 2-3 行代码才能说清。',
    '',
    '```' + languageId,
    code,
    '```',
  ].join('\n');
}
