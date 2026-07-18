import { Injectable, signal } from '@angular/core';

import { JourneySnapshot, SavedJourney, parseSnapshot } from '../core/journey';

const LIBRARY_KEY = 'route-reel:journeys';
const MAX_JOURNEYS = 50;

/**
 * Browser-side journey library: named journeys persisted in localStorage,
 * plus JSON file export/import. Knows nothing about the map — TripService
 * produces and consumes the snapshots.
 */
@Injectable({ providedIn: 'root' })
export class JourneyStoreService {
  readonly journeys = signal<SavedJourney[]>(this.read());

  save(name: string, snapshot: JourneySnapshot, distance?: number): SavedJourney {
    const journey: SavedJourney = {
      id: crypto.randomUUID(),
      name: name.trim() || `Journey ${new Date().toLocaleDateString()}`,
      savedAt: Date.now(),
      distance,
      ...snapshot,
    };
    this.update([journey, ...this.journeys()].slice(0, MAX_JOURNEYS));
    return journey;
  }

  remove(id: string): void {
    this.update(this.journeys().filter((j) => j.id !== id));
  }

  /** Downloads a journey as a standalone JSON file. */
  download(journey: SavedJourney): void {
    const blob = new Blob([JSON.stringify(journey, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug(journey.name)}.journey.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Parses a journey file and adds it to the library. */
  async importFile(file: File): Promise<SavedJourney> {
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    const snapshot = parseSnapshot(raw);
    if (!snapshot) {
      throw new Error('That file does not look like a saved journey.');
    }
    const named = raw as Partial<SavedJourney>;
    const name =
      typeof named.name === 'string' && named.name.trim()
        ? named.name.trim()
        : file.name.replace(/\.journey\.json$|\.json$/i, '');
    const distance = typeof named.distance === 'number' ? named.distance : undefined;
    return this.save(name, snapshot, distance);
  }

  private update(journeys: SavedJourney[]): void {
    this.journeys.set(journeys);
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(journeys));
    } catch {
      // Storage full or unavailable — the in-memory list still works.
    }
  }

  private read(): SavedJourney[] {
    try {
      const raw = localStorage.getItem(LIBRARY_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      return list.filter((j): j is SavedJourney => {
        const parsed = parseSnapshot(j);
        return !!parsed && typeof j.id === 'string' && typeof j.name === 'string';
      });
    } catch {
      return [];
    }
  }
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'journey'
  );
}
