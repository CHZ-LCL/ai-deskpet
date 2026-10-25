/**
 * webview 侧文案。设计成「中文原文 → 英文」的字典：
 * 调用处写 `L('形象库')`，漏翻时自动退回中文，不会出现空文案。
 * 需要插值时用 `{0}`、`{1}` 占位。
 */
export type Lang = 'zh' | 'en';

const EN: Record<string, string> = {
  // 工具栏 / 通用
  'AI 桌宠': 'AI DeskPet',
  形象库: 'Avatars',
  音效库: 'Sounds',
  代码规范: 'Standards',
  个性化: 'Appearance',
  设置: 'Settings',
  在编辑器标签中打开: 'Open in editor tab',
  关闭: 'Close',
  好感等级: 'Affection level',
  有新的提醒: 'New reminder',
  当前文件的问题: 'Problems in this file',
  'AI 设置': 'AI settings',
  发送: 'Send',
  停止生成: 'Stop generating',
  清空: 'Clear',
  未配置: 'Not configured',

  // 心情
  发呆中: 'Spacing out',
  心情不错: 'Feeling good',
  思考中: 'Thinking',
  警觉: 'Alert',
  打盹中: 'Napping',
  害羞: 'Shy',
  打招呼: 'Waving',

  // 音效
  点击桌宠: 'Pet click',
  '开心 / 保存成功': 'Happy / saved',
  '提醒 / 报错': 'Alert / error',
  出错: 'Error',
  切换形象: 'Switch avatar',
  内置合成音: 'Built-in synth',
  试听: 'Preview',
  '导入音效文件…': 'Import sound…',

  // 对话
  '思考中…': 'Thinking…',
  '我在这儿，需要我陪你看段代码吗？': "I'm here — want me to look at some code with you?",
  讲解选中代码: 'Explain selection',
  查资料: 'Look up docs',
  '模型：{0}': 'Model: {0}',
  '已索引项目：{0}': 'Indexed: {0}',
  项目索引未建立: 'Project index not built yet',
  '好感度 {0} · 陪伴 {1} 天 · 互动 {2} 次': 'Affection {0} · {1} days together · {2} interactions',
  桌宠: 'DeskPet',
  '查资料：关键词或文档地址，Enter 发送…': 'Docs: keywords or URL, Enter to send…',
  '和桌宠聊聊…（Enter 发送 / Shift+Enter 换行）': 'Message your pet… (Enter to send)',
  已停止生成: 'Stopped generating',
  '选中一段代码让我讲解，或者直接问我点什么。\nCtrl+Alt+E 讲解 · Ctrl+Alt+P 聊天':
    'Select some code and ask me to explain it, or just ask a question.\nCtrl+Alt+E explain · Ctrl+Alt+P chat',

  // 形象库
  导入形象: 'Import avatar',
  'Live2D / 3D / 图片': 'Live2D / 3D / image',
  '支持 .model3.json、.vrm / .glb、png / gif / webp':
    'Supports .model3.json, .vrm / .glb, png / gif / webp',
  内置: 'Built-in',
  图片: 'Image',

  // 问题清单
  '{0}：{1} 个错误，{2} 条其它提示': '{0}: {1} errors, {2} other messages',
  '问题清单 · {0}': 'Problems · {0}',
  问题清单: 'Problems',
  '当前文件没有诊断问题。<br/>可以点下面的「体检整个文件」做一次静态检查。':
    'No diagnostics in this file.<br/>Run “Review whole file” below for a static check.',
  '一键修复全部错误（{0}）': 'Fix all errors ({0})',
  解释: 'Explain',
  修复: 'Fix',
  体检整个文件: 'Review whole file',
  分析剪贴板里的报错: 'Analyze clipboard error',

  // 代码规范
  索引完成后会显示检测到的项目约定: 'Detected conventions appear after indexing',
  检测到的约定: 'Detected conventions',
  规则包: 'Rule packs',
  '正在读取配置…': 'Loading…',
  '自定义规则 {0} 条': '{0} custom rules',
  '白名单 {0} 条': '{0} whitelisted',
  '规则和风格会写进每次生成的提示词；白名单里的规则不会被扫描，也不会被“修复”。':
    'Rules and style are added to every prompt; whitelisted rules are never flagged or “fixed”.',
  按规范检查当前文件: 'Check current file against standards',
  现代化重构选中代码: 'Modernize selection',
  编辑规则与白名单: 'Edit rules & whitelist',
  '规则包已更新，{0} 个启用': 'Rule packs updated, {0} enabled',

  // 个性化
  '正在加载配置…': 'Loading configuration…',
  写入范围: 'Write scope',
  全局: 'Global',
  当前工作区: 'Workspace',
  当前工作区已有独立主题: 'This workspace has its own theme',
  清除: 'Clear',
  主题: 'Theme',
  自定义主色: 'Custom accent',
  主题包: 'Theme file',
  '导入…': 'Import…',
  '导出…': 'Export…',
  '导出为 JSON 分享给同事；导入会逐字段校验，坏值回退默认。':
    'Export JSON to share; imports are validated field by field with safe fallbacks.',
  背景: 'Background',
  网格: 'Grid',
  纯色: 'Solid',
  极简: 'Minimal',
  动效: 'Motion',
  完整: 'Full',
  轻量: 'Lite',
  排版: 'Density',
  紧凑: 'Compact',
  标准: 'Cozy',
  宽松: 'Comfortable',
  显示名牌: 'Show nameplate',
  快捷按钮: 'Quick actions',
  '+ 添加': '+ Add',
  保存: 'Save',
  '命令 id 填 __docs__ 表示切换到查资料模式；留空的按钮不会保存。':
    'Use __docs__ to toggle docs mode; empty rows are dropped.',
  '自定义 CSS': 'Custom CSS',
  撤销预览: 'Revert preview',
  '保存 CSS': 'Save CSS',
  '改动即时预览，并写入你的 VS Code 设置':
    'Changes preview live and are saved to your VS Code settings',
  按钮文字: 'Button label',
  '命令 id 或 __docs__': 'Command id or __docs__',
  删除: 'Remove',
  快捷按钮已保存: 'Quick actions saved',
  '自定义 CSS 已保存': 'Custom CSS saved',
  '已撤销未保存的 CSS 预览': 'Reverted unsaved CSS preview',
  之后的外观改动只写入当前工作区: 'Appearance changes now apply to this workspace',
  之后的外观改动写入全局设置: 'Appearance changes now apply globally',
  紧凑气泡: 'Compact bubbles',
  等宽代码: 'Monospace code',
  隐藏光晕: 'Hide glow',
  大圆角: 'Large radius',

  // 设置
  语言: 'Language',
  语音朗读回复: 'Read replies aloud',
  打扰程度: 'Interruptions',
  平衡: 'Balanced',
  安静: 'Quiet',
  话多: 'Chatty',
  怎么称呼你: 'What should I call you?',
  可留空: 'Optional',
  语气: 'Tone',
  温和: 'Warm',
  犀利: 'Sharp',
  简洁: 'Concise',
  中二: 'Chuuni',
  回复长度: 'Reply length',
  短: 'Short',
  详细: 'Detailed',
  开场白: 'Greeting',
  留空使用默认: 'Leave empty for default',
  音量: 'Volume',
  形象大小: 'Avatar size',
  好感: 'Affection',
  陪伴: 'Together',
  模型: 'Model',
  天: 'days',
  设置密钥: 'Set API key',
  打开全部设置: 'Open all settings',
  重置桌宠: 'Reset pet',
  '好呀，以后我会念给你听。': 'Sure — I’ll read replies aloud from now on.',
  '安静模式：提醒只写进对话，不弹气泡': 'Quiet: reminders go to chat only',
  '话多模式：提醒会直接弹气泡': 'Chatty: every reminder pops a bubble',
  '平衡模式：重要提醒才弹气泡，打字时不打扰':
    'Balanced: only important reminders pop up, never while you type',
  '改完即时生效，设置会写入你的 VS Code 配置':
    'Changes apply immediately and are saved to your VS Code settings',

  // 对话卡片
  复制: 'Copy',
  已复制: 'Copied',
  问题: 'Problem',
  原因: 'Cause',
  方案: 'Plan',
  影响: 'Impact',
  先看差异: 'View diff',
  应用修改: 'Apply',
  复制代码: 'Copy code',
  忽略: 'Dismiss',
  已应用到编辑器: 'Applied to the editor',
  已打开差异预览: 'Diff opened',
  代码已复制到剪贴板: 'Code copied to clipboard',
  已忽略这条建议: 'Suggestion dismissed',
  '操作失败，请重新生成建议': 'Action failed — please regenerate',
};

let lang: Lang = 'zh';

export function setLanguage(next: Lang): void {
  lang = next;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN';
  }
}

export function getLanguage(): Lang {
  return lang;
}

/** 取文案；未知条目回退中文。 */
export function L(zh: string, ...args: Array<string | number>): string {
  const template = lang === 'en' ? EN[zh] ?? zh : zh;
  if (!args.length) {
    return template;
  }
  return template.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? whole : String(value);
  });
}

/** 供单元测试检查字典完整性。 */
export function englishDictionary(): Readonly<Record<string, string>> {
  return EN;
}
