import { For, Show } from 'solid-js';
import { Icon } from './Icon';
import {
  changeDiffView, changeTheme, diffView, settingsError, settingsPath, theme, toggleWrapLines, wrapLines,
} from './settings';
import type { Theme } from './types';

const THEME_OPTIONS: { value: Theme; label: string; icon: 'monitor' | 'sun' | 'moon' }[] = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
];

/** A miniature diff in one color scheme's colors. */
function Preview(p: { scheme: 'light' | 'dark' }) {
  return (
    <span class={`theme-preview ${p.scheme}`}>
      <span class="tp-bar" />
      <span class="tp-row"><i /></span>
      <span class="tp-row del"><i /></span>
      <span class="tp-row add"><i /></span>
      <span class="tp-row add"><i /></span>
      <span class="tp-row"><i /></span>
    </span>
  );
}

export function SettingsDialog(p: { ref: HTMLDialogElement | ((el: HTMLDialogElement) => void) }) {
  return (
    <dialog class="settings-dialog" ref={p.ref} aria-labelledby="settings-title" onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }}>
      <div class="dialog-content">
        <div class="dialog-heading">
          <h2 id="settings-title">Settings</h2>
          <form method="dialog"><button class="icon-button" aria-label="Close settings"><Icon name="close" /></button></form>
        </div>

        <fieldset class="setting">
          <legend class="setting-name">Theme</legend>
          <div class="theme-options">
            <For each={THEME_OPTIONS}>{(o) => (
              <label class="theme-option">
                <input type="radio" name="theme" value={o.value} checked={theme() === o.value} onChange={() => changeTheme(o.value)} />
                <span class="theme-swatch" aria-hidden="true">
                  {o.value === 'system' ? <><Preview scheme="light" /><Preview scheme="dark" /></> : <Preview scheme={o.value as 'light' | 'dark'} />}
                </span>
                <span class="theme-name"><Icon name={o.icon} />{o.label}</span>
              </label>
            )}</For>
          </div>
        </fieldset>

        <div class="setting setting-row">
          <span class="setting-text">
            <span class="setting-name" id="layout-label">Diff layout</span>
            <span class="setting-hint">Changes in one column, or old and new side by side</span>
          </span>
          <div class="segmented" role="group" aria-labelledby="layout-label">
            <button aria-pressed={diffView() === 'unified'} classList={{ active: diffView() === 'unified' }} onClick={() => changeDiffView('unified')}><Icon name="unified" /><span>Unified</span></button>
            <button aria-pressed={diffView() === 'split'} classList={{ active: diffView() === 'split' }} onClick={() => changeDiffView('split')}><Icon name="split" /><span>Split</span></button>
          </div>
        </div>

        <label class="setting setting-row">
          <span class="setting-text">
            <span class="setting-name">Wrap long lines</span>
            <span class="setting-hint">Otherwise long lines scroll sideways</span>
          </span>
          <input type="checkbox" class="switch" checked={wrapLines()} onChange={toggleWrapLines} />
        </label>

        <p class="settings-footer" classList={{ error: !!settingsError() }} role={settingsError() ? 'alert' : undefined}>
          <Show when={!settingsError()} fallback={settingsError()}>
            <Show when={settingsPath()}>{(path) => <>Saved to <code>{path()}</code></>}</Show>
          </Show>
        </p>
      </div>
    </dialog>
  );
}
