import { For } from 'solid-js';

const paths = {
  diff: ['M5 3H2v10h3M11 3h3v10h-3M5.5 5.5h5M8 3v5M5.5 11h5'],
  chevron: ['m6 4 4 4-4 4'],
  folder: ['M1.5 4V2.5h5l1.5 2h6.5v9h-13V4Z'],
  file: ['M9.5 1.5h-7v13h11v-9l-4-4Zm0 0v4h4'],
  search: ['M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm-1.3 3.2 3.8 3.8'],
  close: ['m4 4 8 8M12 4l-8 8'],
  check: ['m3 8 3.2 3.2L13 4.5'],
  copy: ['M6 5.5h7.5v9H6zM10 3V1.5H2.5v9H4'],
  history: ['M2 7a6 6 0 1 1 1.5 5M2 2v5h5M8 4v4l3 2'],
  sidebar: ['M1.5 2.5h13v11h-13zM6 3v10'],
  up: ['m4 10 4-4 4 4'],
  down: ['m4 6 4 4 4-4'],
  collapse: ['m4 2 4 4 4-4M4 14l4-4 4 4'],
  expand: ['m4 5 4-4 4 4M4 11l4 4 4-4'],
  split: ['M1.5 2.5h13v11h-13zM8 3v10M4 6v4M11 6v4'],
  unified: ['M1.5 2.5h13v11h-13zM4 6h8M4 10h8'],
  wrap: ['M2 3h12M2 7h9a3 3 0 0 1 0 6H8m2-2-2 2 2 2M2 11h3'],
  refresh: ['M13.5 6A5.7 5.7 0 0 0 3 4M13.5 2v4h-4M2.5 10A5.7 5.7 0 0 0 13 12M2.5 14v-4h4'],
  commit: ['M5 8H1m14 0h-4M11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
  keyboard: ['M1.5 3.5h13v9h-13zM4 6h.1M6.5 6h.1M9 6h.1M11.5 6h.1M4 8.5h.1M6.5 8.5h.1M9 8.5h.1M11.5 8.5h.1M5 10.5h6'],
} satisfies Record<string, string[]>;

export function Icon(p: { name: keyof typeof paths; size?: number; class?: string }) {
  return (
    <svg class={p.class} width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <For each={paths[p.name]}>{(d) => <path d={d} />}</For>
    </svg>
  );
}
