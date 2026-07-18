import { Injectable, signal } from '@angular/core';

export type MenuEntry =
  | {
      kind: 'item';
      label: string;
      icon?: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      action: () => void;
    }
  | { kind: 'header'; label: string }
  | { kind: 'sep' };

export interface MenuState {
  x: number;
  y: number;
  entries: MenuEntry[];
}

/** One global right-click menu; ContextMenuComponent renders the state. */
@Injectable({ providedIn: 'root' })
export class ContextMenuService {
  readonly state = signal<MenuState | null>(null);

  open(x: number, y: number, entries: MenuEntry[]): void {
    const width = 240;
    const height =
      entries.reduce(
        (h, e) => h + (e.kind === 'item' ? 32 : e.kind === 'header' ? 24 : 9),
        0,
      ) + 14;
    this.state.set({
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
      entries,
    });
  }

  close(): void {
    this.state.set(null);
  }

  run(entry: MenuEntry & { kind: 'item' }): void {
    this.close();
    entry.action();
  }
}
