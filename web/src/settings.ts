import { batch, createSignal } from 'solid-js';
import { AuthError, fetchSettings, saveSettings } from './api';
import type { Layout, Settings, Theme } from './types';

export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];
const root = document.documentElement;

/** The server puts the saved theme on <html>, so the first paint is already in it. */
function initialTheme(): Theme {
  const t = root.dataset.theme as Theme | undefined;
  return t && THEMES.includes(t) ? t : 'system';
}

const [theme, setTheme] = createSignal<Theme>(initialTheme());
const [diffView, setDiffView] = createSignal<Layout>('unified');
const [wrapLines, setWrapLines] = createSignal(true);
/** Where settings are saved; undefined until loaded, or without a home directory. */
const [settingsPath, setSettingsPath] = createSignal<string>();
/** Why settings can't be loaded or saved. */
const [settingsError, setSettingsError] = createSignal('');
export { diffView, settingsError, settingsPath, theme, wrapLines };

function current(): Settings {
  return { theme: theme(), layout: diffView(), wrap: wrapLines() };
}

function apply(s: Partial<Settings>) {
  batch(() => {
    if (s.theme) {
      setTheme(s.theme);
      // Each theme is a color scheme; style.css picks the colors from it.
      root.dataset.theme = s.theme;
    }
    if (s.layout) setDiffView(s.layout);
    if (s.wrap !== undefined) setWrapLines(s.wrap);
  });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+: /, '');

export async function loadSettings() {
  try {
    const file = await fetchSettings();
    batch(() => {
      setSettingsPath(file.path);
      setSettingsError(file.error ?? '');
      apply(file.settings);
    });
  } catch (e) {
    if (!(e instanceof AuthError)) setSettingsError(`Cannot load settings: ${message(e)}`);
  }
}

let saving = Promise.resolve();

/** Applies a change at once and saves it. Saves go out one at a time, in order. */
export function updateSettings(change: Partial<Settings>) {
  const now = current();
  const changed = Object.fromEntries(
    Object.entries(change).filter(([k, v]) => now[k as keyof Settings] !== v),
  ) as Partial<Settings>;
  if (!Object.keys(changed).length) return;
  apply(changed);
  saving = saving.then(async () => {
    try {
      const file = await saveSettings(changed);
      batch(() => {
        setSettingsPath(file.path);
        setSettingsError('');
      });
    } catch (e) {
      setSettingsError(e instanceof AuthError
        ? 'Not saved: open the URL printed by rediff again'
        : `Not saved: ${message(e)}`);
    }
  });
}

export const changeTheme = (t: Theme) => updateSettings({ theme: t });
export const changeDiffView = (layout: Layout) => updateSettings({ layout });
export const toggleWrapLines = () => updateSettings({ wrap: !wrapLines() });
