import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';

import { TripService } from '../../services/trip.service';
import { JourneyStoreService } from '../../services/journey-store.service';
import { SavedJourney } from '../../core/journey';
import { metresToKm } from '../../core/format';

/**
 * Save the drawn journey to the browser, reload it later, download it as a
 * JSON file, or import a previously downloaded one.
 */
@Component({
  selector: 'app-journey-library',
  imports: [DatePipe, DecimalPipe],
  templateUrl: './journey-library.component.html',
  styleUrl: './journey-library.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JourneyLibraryComponent {
  readonly trip = inject(TripService);
  readonly store = inject(JourneyStoreService);
  readonly km = metresToKm;
  readonly importError = signal<string | null>(null);

  save(nameInput: HTMLInputElement): void {
    const snapshot = this.trip.snapshot();
    if (!snapshot) return;
    this.store.save(nameInput.value, snapshot, this.trip.distance());
    nameInput.value = '';
  }

  load(journey: SavedJourney): void {
    this.importError.set(null);
    this.trip.loadJourney(journey);
  }

  downloadCurrent(): void {
    const snapshot = this.trip.snapshot();
    if (!snapshot) return;
    this.store.download({
      id: '',
      name: 'journey',
      savedAt: Date.now(),
      distance: this.trip.distance(),
      ...snapshot,
    });
  }

  async onImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-importing the same file
    if (!file) return;
    try {
      const journey = await this.store.importFile(file);
      this.importError.set(null);
      this.trip.loadJourney(journey);
    } catch (err) {
      this.importError.set(err instanceof Error ? err.message : 'Import failed.');
    }
  }
}
