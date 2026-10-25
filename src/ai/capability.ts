import * as vscode from 'vscode';
import { isEnglish, L } from '../i18n';
import { createProvider, readAiSettings, type AiSettings } from './index';
import { CAPABILITY_SAMPLE, validateFullFileReply } from './capabilitySample';

const KEY = 'deskpet.modelCapability.fullFile.v1';

export interface CapabilityRecord {
  provider: string;
  model: string;
  baseUrl: string;
  at: number;
  passed: boolean;
  notes: string;
}

export function readCapability(context: vscode.ExtensionContext): CapabilityRecord | undefined {
  return context.globalState.get<CapabilityRecord>(KEY);
}

/** 换了模型或接口地址，之前的验证结果就作废。 */
export function capabilityMatches(record: CapabilityRecord | undefined, settings: AiSettings): boolean {
  if (!record) {
    return false;
  }
  if (record.provider !== settings.provider || record.model !== settings.model) {
    return false;
  }
  return settings.provider === 'vscode-lm' || record.baseUrl === settings.baseUrl;
}

/**
 * 用一个带越界错误的 8 行样本测试模型：必须返回完整文件、保留标记与函数、修掉 bug。
 * 结果按「provider + model + baseUrl」缓存，换模型后自动失效。
 */
export async function checkFullFileCapability(context: vscode.ExtensionContext): Promise<CapabilityRecord> {
  const settings = await readAiSettings(context);
  const provider = createProvider(settings);
  const status = vscode.window.setStatusBarMessage(
    L('$(sync~spin) 正在验证模型的整文件改写能力…', '$(sync~spin) Checking full-file rewrite capability…'),
  );
  const cts = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => cts.cancel(), 90_000);

  let verdict = { ok: false, code: '', reason: L('未执行', 'not run') };

  try {
    const reply = await provider.chat(
      [
        {
          role: 'system',
          content: L(
            '你是一个严格遵守格式的代码编辑器。',
            'You are a code editor that follows the requested format exactly.',
          ),
        },
        {
          role: 'user',
          content: isEnglish()
            ? [
                'The loop in the code below has an out-of-bounds error. Fix it.',
                'Requirements:',
                '1. Output exactly one complete-file code block.',
                '2. Keep the DESKPET_CAPABILITY_MARKER comment on the first line.',
                '3. Do not output explanations or anything else.',
                '',
                '```ts',
                CAPABILITY_SAMPLE,
                '```',
              ].join('\n')
            : [
                '下面这段代码的循环有越界错误，请修复。',
                '要求：',
                '1. 只输出一个完整文件的代码块；',
                '2. 保留第一行的 DESKPET_CAPABILITY_MARKER 注释；',
                '3. 不要输出解释或其它内容。',
                '',
                '```ts',
                CAPABILITY_SAMPLE,
                '```',
              ].join('\n'),
        },
      ],
      () => undefined,
      cts.token,
    );
    verdict = validateFullFileReply(CAPABILITY_SAMPLE, reply);
  } catch (error) {
    verdict = {
      ok: false,
      code: '',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    cts.dispose();
    status.dispose();
  }

  const record: CapabilityRecord = {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    at: Date.now(),
    passed: verdict.ok,
    notes: localizedReason(verdict.reason),
  };
  await context.globalState.update(KEY, record);
  return record;
}

const REASON_EN: Record<string, string> = {
  未执行: 'not run',
  没有返回代码块: 'no code block returned',
  '丢失了标记注释，说明不是完整文件': 'marker comment missing — not a full file',
  丢失了原有函数: 'original function missing',
  没有修掉循环越界: 'loop bound not fixed',
  输出明显被截断: 'output was truncated',
  通过: 'passed',
};

function localizedReason(reason: string): string {
  if (!isEnglish()) {
    return reason;
  }
  return REASON_EN[reason] ?? reason;
}
