import {
  isWhitelisted,
  readStandardsConfig,
  type PackId,
  type Severity,
} from './rules';
import { isEnglish, L } from '../i18n';

export interface Finding {
  ruleId: string;
  pack: PackId;
  title: string;
  severity: Severity;
  line: number;
  excerpt: string;
  advice: string;
}

interface Detector {
  ruleId: string;
  pack: PackId;
  title: string;
  severity: Severity;
  languages: string[];
  pattern: RegExp;
  advice: string;
  skip?: (line: string) => boolean;
}

const JS = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'vue', 'svelte'];
const TS = ['typescript', 'typescriptreact'];
const PY = ['python'];

const DETECTORS: Detector[] = [
  {
    ruleId: 'js-modern.var',
    pack: 'js-modern',
    title: '使用 var 声明',
    severity: 'medium',
    languages: JS,
    pattern: /\bvar\s+[A-Za-z_$]/,
    advice: '用 const（不重新赋值）或 let（会重新赋值），块级作用域更安全。',
  },
  {
    ruleId: 'js-modern.loose-eq',
    pack: 'js-modern',
    title: '宽松相等',
    severity: 'medium',
    languages: JS,
    pattern: /(^|[^=!<>])==(?!=)|(^|[^=!<>])!=(?!=)/,
    advice: '改用 === / !==，避免隐式类型转换带来的意外。',
  },
  {
    ruleId: 'js-modern.indexof',
    pack: 'js-modern',
    title: '用 indexOf 判断存在',
    severity: 'low',
    languages: JS,
    pattern: /\.indexOf\([^)]*\)\s*(?:[!<>]==?|>=?|<)\s*-?\s*1/,
    advice: '用 includes() / startsWith()，可读性更好且意图明确。',
  },
  {
    ruleId: 'js-modern.object-assign',
    pack: 'js-modern',
    title: 'Object.assign 拷贝对象',
    severity: 'low',
    languages: JS,
    pattern: /Object\.assign\(\s*\{\s*\}\s*,/,
    advice: '用对象展开 { ...base, ...patch } 更直观。',
  },
  {
    ruleId: 'js-modern.parseint',
    pack: 'js-modern',
    title: 'parseInt 未指定进制',
    severity: 'low',
    languages: JS,
    pattern: /parseInt\(\s*[^,()]+\)/,
    advice: '补上第二个参数 10，避免个别环境按八进制/十六进制解析。',
  },
  {
    ruleId: 'js-modern.json-clone',
    pack: 'js-modern',
    title: 'JSON 深拷贝',
    severity: 'medium',
    languages: JS,
    pattern: /JSON\.parse\(\s*JSON\.stringify\(/,
    advice: '改用 structuredClone()，能正确处理 Date/Map/Set 等类型。',
  },
  {
    ruleId: 'js-modern.then-chain',
    pack: 'js-modern',
    title: 'Promise.then 链',
    severity: 'low',
    languages: JS,
    pattern: /\.then\(\s*(?:\(|function)/,
    advice: '在允许的调用层改成 async/await，错误处理更集中。',
  },
  {
    ruleId: 'js-modern.index-loop',
    pack: 'js-modern',
    title: '下标循环遍历数组',
    severity: 'low',
    languages: JS,
    pattern: /for\s*\(\s*(?:let|var)\s+\w+\s*=\s*0\s*;.*\.length/,
    advice: '用 for...of / entries()；需要下标时再显式取。',
  },
  {
    ruleId: 'js-modern.console',
    pack: 'js-modern',
    title: '遗留的 console 调试输出',
    severity: 'low',
    languages: JS,
    pattern: /\bconsole\.(?:log|debug)\(/,
    advice: '提交前删除，或改用项目的 logger。',
  },
  {
    ruleId: 'js-modern.debugger',
    pack: 'js-modern',
    title: '遗留 debugger',
    severity: 'medium',
    languages: JS,
    pattern: /\bdebugger\b/,
    advice: '删除 debugger，避免生产环境卡住执行流。',
  },
  {
    ruleId: 'ts-strict.any',
    pack: 'ts-strict',
    title: '使用 any',
    severity: 'medium',
    languages: TS,
    pattern: /:\s*any\b|\bas\s+any\b/,
    advice: '用具体类型、unknown + 类型收窄，或泛型替代 any。',
  },
  {
    ruleId: 'ts-strict.ts-ignore',
    pack: 'ts-strict',
    title: '@ts-ignore',
    severity: 'medium',
    languages: TS,
    pattern: /@ts-ignore\b/,
    advice: '改用 @ts-expect-error 并写清原因，类型修好后它会自动报错。',
  },
  {
    ruleId: 'ts-strict.enum',
    pack: 'ts-strict',
    title: '使用 enum',
    severity: 'low',
    languages: TS,
    pattern: /^\s*(?:export\s+)?enum\s+\w+/,
    advice: '考虑用联合类型 + const 对象，运行时开销更小、打包更友好。',
  },
  {
    ruleId: 'react.dangerous-html',
    pack: 'react',
    title: 'dangerouslySetInnerHTML',
    severity: 'high',
    languages: ['javascriptreact', 'typescriptreact'],
    pattern: /dangerouslySetInnerHTML/,
    advice: '先做 HTML 消毒（如 DOMPurify），或改为结构化渲染。',
  },
  {
    ruleId: 'react.index-key',
    pack: 'react',
    title: '用数组下标作为 key',
    severity: 'low',
    languages: ['javascriptreact', 'typescriptreact'],
    pattern: /key=\{\s*(?:index|i|idx)\s*\}/,
    advice: '用稳定的业务 id，避免列表增删时状态错位。',
  },
  {
    ruleId: 'python.percent-format',
    pack: 'python-modern',
    title: '百分号字符串格式化',
    severity: 'low',
    languages: PY,
    pattern: /['"][^'"]*%[sd][^'"]*['"]\s*%/,
    advice: '改用 f-string，可读性和性能都更好。',
  },
  {
    ruleId: 'python.str-format',
    pack: 'python-modern',
    title: 'str.format 格式化',
    severity: 'low',
    languages: PY,
    pattern: /\.format\(/,
    advice: '改用 f-string。',
  },
  {
    ruleId: 'python.bare-except',
    pack: 'python-modern',
    title: '裸 except',
    severity: 'high',
    languages: PY,
    pattern: /^\s*except\s*:/,
    advice: '捕获具体异常类型，否则会吞掉 KeyboardInterrupt / SystemExit。',
  },
  {
    ruleId: 'python.except-pass',
    pack: 'python-modern',
    title: 'except 里直接 pass',
    severity: 'medium',
    languages: PY,
    pattern: /^\s*except[^:]*:\s*pass\s*$/,
    advice: '至少记录日志，或明确写出为什么可以忽略。',
  },
  {
    ruleId: 'python.range-len',
    pack: 'python-modern',
    title: 'range(len(...))',
    severity: 'low',
    languages: PY,
    pattern: /for\s+\w+\s+in\s+range\(\s*len\(/,
    advice: '用 enumerate() 同时拿下标和元素。',
  },
  {
    ruleId: 'python.open-without-with',
    pack: 'python-modern',
    title: 'open 未使用上下文管理器',
    severity: 'medium',
    languages: PY,
    pattern: /^\s*\w+\s*=\s*open\(/,
    advice: '改用 with open(...) as f:，异常时也能保证关闭文件。',
  },
  {
    ruleId: 'python.mutable-default',
    pack: 'python-modern',
    title: '可变默认参数',
    severity: 'medium',
    languages: PY,
    pattern: /def\s+\w+\([^)]*=\s*(?:\[\]|\{\})/,
    advice: '默认值用 None，在函数体内初始化。',
  },
  {
    ruleId: 'security.eval',
    pack: 'security',
    title: 'eval / 动态执行',
    severity: 'high',
    languages: JS.concat(PY),
    pattern: /(?:^|[^.\w])eval\s*\(/,
    advice: 'eval 会把字符串当代码执行，优先用 JSON.parse、查表或显式分支。',
  },
  {
    ruleId: 'security.new-function',
    pack: 'security',
    title: 'new Function 动态代码',
    severity: 'high',
    languages: JS,
    pattern: /new\s+Function\s*\(/,
    advice: '动态函数无法被静态分析，且等同 eval；用显式逻辑替代。',
  },
  {
    ruleId: 'security.innerhtml',
    pack: 'security',
    title: '直接写 innerHTML',
    severity: 'high',
    languages: JS,
    pattern: /\.(?:innerHTML|outerHTML)\s*=/,
    advice: '改用 textContent 或经过消毒的渲染；否则存在 XSS 风险。',
  },
  {
    ruleId: 'security.child-process',
    pack: 'security',
    title: 'shell 执行拼接字符串',
    severity: 'high',
    languages: JS.concat(PY),
    pattern: /(?:exec|execSync|spawnSync)\s*\(\s*[`'"]/,
    advice: '避免拼接外部输入；用参数数组形式（execFile/spawn）并校验入参。',
  },
  {
    ruleId: 'security.secret',
    pack: 'security',
    title: '疑似硬编码密钥',
    severity: 'high',
    languages: JS.concat(PY),
    pattern: /(?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    advice: '移到环境变量或密钥管理服务；提交过的密钥要立即轮换。',
    skip: (line) =>
      /process\.env|import\.meta\.env|os\.environ|your[_-]|example|placeholder|xxx|\$\{|<[^>]+>|test|mock/i.test(line),
  },
  {
    ruleId: 'security.secret-token',
    pack: 'security',
    title: '疑似真实服务商令牌',
    severity: 'high',
    languages: JS.concat(PY),
    pattern: /['"](?:sk_live_|sk_test_|ghp_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16})[A-Za-z0-9_-]{6,}['"]/,
    advice: '这是服务商格式的令牌，不要提交到仓库；立刻轮换并改用环境变量。',
    skip: (line) => /process\.env|import\.meta\.env|os\.environ|example|xxx|\$\{/i.test(line),
  },
  {
    ruleId: 'security.md5',
    pack: 'security',
    title: '使用 MD5',
    severity: 'medium',
    languages: JS.concat(PY),
    pattern: /createHash\(\s*['"]md5['"]\s*\)|hashlib\.md5\(/,
    advice: '密码场景改用 bcrypt/argon2；校验场景改用 SHA-256。',
  },
  {
    ruleId: 'security.plain-http',
    pack: 'security',
    title: '明文 HTTP 地址',
    severity: 'medium',
    languages: JS.concat(PY),
    pattern: /['"]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^'"]+['"]/,
    advice: '改用 https，或确认这是内网且已在配置层做了隔离。',
  },
  {
    ruleId: 'security.document-write',
    pack: 'security',
    title: 'document.write',
    severity: 'high',
    languages: JS,
    pattern: /document\.write\s*\(/,
    advice: 'document.write 会重写文档且极易引入 XSS，改用 DOM API。',
  },
  {
    ruleId: 'security.random-token',
    pack: 'security',
    title: '用 Math.random 生成令牌',
    severity: 'high',
    languages: JS,
    pattern: /(?:token|secret|key|salt|nonce)\s*=\s*[^;\n]*Math\.random\(\)/i,
    advice: '改用 crypto.randomUUID() 或 crypto.getRandomValues()。',
  },
  {
    ruleId: 'security.sql-concat',
    pack: 'security',
    title: 'SQL 字符串拼接',
    severity: 'high',
    languages: JS.concat(PY),
    pattern: /(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)[^;]{0,80}\+\s*[A-Za-z_$]/i,
    advice: '改用参数化查询（占位符 + 绑定参数），避免注入。',
  },
  {
    ruleId: 'security.py-verify',
    pack: 'security',
    title: '关闭 TLS 校验',
    severity: 'high',
    languages: PY,
    pattern: /verify\s*=\s*False/,
    advice: '不要关闭证书校验；内网自签证书应显式配置 CA。',
  },
  {
    ruleId: 'security.py-shell',
    pack: 'security',
    title: 'subprocess shell=True',
    severity: 'high',
    languages: PY,
    pattern: /shell\s*=\s*True/,
    advice: '用参数列表 + shell=False，避免命令注入。',
  },
];

/** 确定性扫描：找常见模式与安全隐患，给模型“事实依据”，也直接展示给用户。 */
export function scanCode(
  code: string,
  languageId: string,
  filePath: string,
  options: { packs?: PackId[]; lineOffset?: number } = {},
): Finding[] {
  const config = readStandardsConfig();
  const packs = new Set(options.packs ?? config.packs);
  const offset = options.lineOffset ?? 0;
  const lines = code.split(/\r?\n/);
  const findings: Finding[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().length > 600) {
      continue;
    }
    for (const detector of DETECTORS) {
      if (!packs.has(detector.pack) || !detector.languages.includes(languageId)) {
        continue;
      }
      if (detector.skip?.(line)) {
        continue;
      }
      detector.pattern.lastIndex = 0;
      if (!detector.pattern.test(line)) {
        continue;
      }
      if (isWhitelisted(detector.ruleId, filePath, config.whitelist)) {
        continue;
      }
      findings.push({
        ruleId: detector.ruleId,
        pack: detector.pack,
        title: detector.title,
        severity: detector.severity,
        line: index + 1 + offset,
        excerpt: line.trim().slice(0, 120),
        advice: detector.advice,
      });
      if (findings.length >= 60) {
        return findings;
      }
    }
  }

  const weight = { high: 0, medium: 1, low: 2 } as const;
  return findings.sort((left, right) => weight[left.severity] - weight[right.severity] || left.line - right.line);
}

/** 给提示词用的紧凑清单。 */
export function formatFindings(findings: Finding[]): string {
  if (!findings.length) {
    return L('（本地扫描没有发现明显问题）', '(the local scan found no obvious issues)');
  }
  const label = isEnglish()
    ? ({ high: 'high', medium: 'medium', low: 'low' } as const)
    : ({ high: '高', medium: '中', low: '低' } as const);
  return findings
    .slice(0, 20)
    .map(
      (item) =>
        `- [${label[item.severity]}] L${item.line} ${item.ruleId}${L('：', ': ')}${item.title} → ${item.advice}`,
    )
    .join('\n');
}

export function countBySeverity(findings: Finding[]): { high: number; medium: number; low: number } {
  return findings.reduce(
    (acc, item) => {
      acc[item.severity] += 1;
      return acc;
    },
    { high: 0, medium: 0, low: 0 },
  );
}
