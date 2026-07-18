import { Injectable, effect, signal } from '@angular/core';

export type ThemePref = 'auto' | 'light' | 'dark';

const THEME_KEY = 'route-reel:theme';
const ORDER: ThemePref[] = ['auto', 'light', 'dark'];

/**
 * Applies the colour theme by stamping `data-theme="light|dark"` on <html>
 * (the tokens in styles.scss key off it). "auto" follows the OS preference
 * live; the choice is remembered across visits. index.html applies the
 * stored value inline before Angular boots so there is no flash.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');

  readonly pref = signal<ThemePref>(readPref());

  constructor() {
    effect(() => {
      const pref = this.pref();
      try {
        localStorage.setItem(THEME_KEY, pref);
      } catch {
        // Private mode — theme just won't persist.
      }
      this.apply(pref);
    });
    this.media.addEventListener('change', () => {
      if (this.pref() === 'auto') this.apply('auto');
    });
  }

  cycle(): void {
    const next = ORDER[(ORDER.indexOf(this.pref()) + 1) % ORDER.length];
    this.pref.set(next);
  }

  private apply(pref: ThemePref): void {
    const dark = pref === 'dark' || (pref === 'auto' && this.media.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }
}

function readPref(): ThemePref {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'auto';
  } catch {
    return 'auto';
  }
}
