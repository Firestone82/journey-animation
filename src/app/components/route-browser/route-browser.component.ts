import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';

import { TripService } from '../../services/trip.service';
import { TRAVEL_MODES } from '../../core/travel-modes';
import { formatDuration, metresToKm } from '../../core/format';

/**
 * Lists every leg of the journey — pin to pin, with distance and travel
 * time — and lets each leg use its own travel mode (walk, cycle, …).
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
  readonly modes = TRAVEL_MODES;
  readonly km = metresToKm;
  readonly fmtDuration = formatDuration;

  pinLabel(waypointIndex: number): string {
    const last = this.trip.legs().length;
    if (waypointIndex === 0) return 'A';
    return waypointIndex === last ? 'B' : String(waypointIndex);
  }

  legIcon(modeId: string): string {
    return this.modes.find((m) => m.id === modeId)?.icon ?? '';
  }

  /** Value for the leg's select: the override's mode id, or '' for trip mode. */
  selectedMode(legIndex: number): string {
    const overrides: Partial<Record<number, string>> = this.trip.legModes();
    return overrides[legIndex] ?? '';
  }

  onModeChange(legIndex: number, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.trip.setLegMode(legIndex, value || null);
  }
}
