import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';

import { TripService } from '../../services/trip.service';
import { TRAVEL_MODES } from '../../core/travel-modes';
import { formatDuration, metresToKm } from '../../core/format';

const DOCK_KEY = 'route-reel:browser-dock';

/**
 * Floating route browser over the map: every pin and the leg between each
 * pair (mode, distance, time, speed override). Pins can be reordered;
 * right-clicking a pin or a leg opens the same context menus as the map.
 * Docked left by default, movable to the right and draggable vertically.
 */
@Component({
  selector: 'app-route-browser',
  imports: [DecimalPipe],
  templateUrl: './route-browser.component.html',
  styleUrl: './route-browser.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RouteBrowserComponent {
  readonly trip = inject(TripService);
  readonly km = metresToKm;
  readonly fmtDuration = formatDuration;

  readonly dock = signal<'left' | 'right'>(readDock());
  readonly offsetY = signal(0);
  readonly pinIndices = computed(() =>
    Array.from({ length: this.trip.legs().length + 1 }, (_, i) => i),
  );

  private dragStartY = 0;
  private dragStartOffset = 0;

  pinName(i: number): string {
    const last = this.trip.legs().length;
    return i === 0 ? 'Start' : i === last ? 'Finish' : `Stop ${i}`;
  }

  legIcon(modeId: string): string {
    return TRAVEL_MODES.find((m) => m.id === modeId)?.icon ?? '';
  }

  speedBadge(legIndex: number): string {
    const overrides: Partial<Record<number, number>> = this.trip.legSpeeds();
    const f = overrides[legIndex];
    return f ? `${f}×` : '';
  }

  toggleDock(): void {
    const next = this.dock() === 'left' ? 'right' : 'left';
    this.dock.set(next);
    try {
      localStorage.setItem(DOCK_KEY, next);
    } catch {
      // Private mode — dock side just won't persist.
    }
  }

  onPinMenu(i: number, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.trip.openPinMenu(i, ev.clientX, ev.clientY);
  }

  onLegMenu(i: number, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.trip.openLegMenu(i, ev.clientX, ev.clientY);
  }

  startDrag(ev: PointerEvent): void {
    // Only the header drags; buttons inside it keep working.
    if ((ev.target as HTMLElement).closest('button')) return;
    ev.preventDefault();
    this.dragStartY = ev.clientY;
    this.dragStartOffset = this.offsetY();
    const move = (e: PointerEvent) => {
      const next = this.dragStartOffset + (e.clientY - this.dragStartY);
      this.offsetY.set(Math.max(0, Math.min(next, window.innerHeight * 0.55)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}

function readDock(): 'left' | 'right' {
  try {
    return localStorage.getItem(DOCK_KEY) === 'right' ? 'right' : 'left';
  } catch {
    return 'left';
  }
}
