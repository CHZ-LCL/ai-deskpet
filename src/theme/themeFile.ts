import type {
  BackgroundStyle,
  Density,
  MotionLevel,
  PetTheme,
  QuickAction,
  ThemeId,
} from '../../shared/protocol';
import { THEME_PRESETS } from '../../shared/protocol';

export interface ThemeFile {
  version: 1;
  name?: string;
  theme: PetTheme;
  quickActions?: QuickAction[];
}

const THEME_IDS = new Set(THEME_PRESETS.map((preset) => preset.id));
const BACKGROUNDS = new Set<BackgroundStyle>(['grid', 'plain', 'none']);
const MOTIONS = new Set<MotionLevel>(['full', 'lite', 'off']);
const DENSITIES = new Set<Density>(['compact', 'cozy', 'comfortable']);
const MAX_CSS = 12_000;

export function buildThemeFile(theme: PetTheme, quickActions: QuickAction[], name?: string): ThemeFile {
  return {
    version: 1,
    name: name?.slice(0, 60),
    theme: {
      id: theme.id,
      accent: theme.accent,
      background: theme.background,
      motion: theme.motion,
      density: theme.density,
      nameplate: theme.nameplate,
      customCss: theme.customCss.slice(0, MAX_CSS),
    },
    quickActions: quickActions.slice(0, 10),
  };
}

/**
 * 主题文件是用户之间分享的，必须当成不可信输入：
 * 每个字段都做白名单/范围校验，坏值回退到默认，不让一份 JSON 把面板搞崩。
 */
export function parseThemeFile(text: string): { ok: true; file: ThemeFile } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件。' };
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: '主题文件的根节点必须是对象。' };
  }

  const data = raw as Record<string, unknown>;
  if (data.version !== undefined && data.version !== 1) {
    return { ok: false, error: `不支持的主题版本：${String(data.version)}` };
  }

  const source = (data.theme ?? data) as Record<string, unknown>;
  const theme = normalizeTheme(source);

  const quickActions = Array.isArray(data.quickActions)
    ? data.quickActions
        .slice(0, 10)
        .map((item) => normalizeAction(item))
        .filter((item): item is QuickAction => Boolean(item))
    : undefined;

  return {
    ok: true,
    file: {
      version: 1,
      name: typeof data.name === 'string' ? data.name.slice(0, 60) : undefined,
      theme,
      quickActions: quickActions?.length ? quickActions : undefined,
    },
  };
}

export function normalizeTheme(source: Record<string, unknown>): PetTheme {
  const id = typeof source.id === 'string' && THEME_IDS.has(source.id as ThemeId) ? (source.id as ThemeId) : 'mint';
  const accent = typeof source.accent === 'string' && /^#[0-9a-f]{6}$/i.test(source.accent) ? source.accent : '#4ec9b0';
  const background =
    typeof source.background === 'string' && BACKGROUNDS.has(source.background as BackgroundStyle)
      ? (source.background as BackgroundStyle)
      : 'grid';
  const motion =
    typeof source.motion === 'string' && MOTIONS.has(source.motion as MotionLevel)
      ? (source.motion as MotionLevel)
      : 'full';
  const density =
    typeof source.density === 'string' && DENSITIES.has(source.density as Density)
      ? (source.density as Density)
      : 'cozy';

  return {
    id,
    accent,
    background,
    motion,
    density,
    nameplate: source.nameplate !== false,
    customCss: typeof source.customCss === 'string' ? source.customCss.slice(0, MAX_CSS) : '',
  };
}

function normalizeAction(item: unknown): QuickAction | undefined {
  if (!item || typeof item !== 'object') {
    return undefined;
  }
  const action = item as Record<string, unknown>;
  const label = typeof action.label === 'string' ? action.label.trim().slice(0, 20) : '';
  if (!label) {
    return undefined;
  }
  const command = typeof action.command === 'string' ? action.command.trim().slice(0, 120) : '';
  const text = typeof action.text === 'string' ? action.text.slice(0, 400) : '';
  if (!command && !text) {
    return undefined;
  }
  return text ? { label, text } : { label, command };
}
