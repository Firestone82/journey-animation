/** Serializable description of a drawn journey. */
export interface JourneySnapshot {
  /** Global travel mode id (see TRAVEL_MODES). */
  modeId: string;
  waypoints: { lat: number; lng: number }[];
  /** Per-leg mode overrides, keyed by leg index. */
  legModes?: Record<number, string>;
  /** Per-leg playback-speed multipliers (1 = trip speed), keyed by leg index. */
  legSpeeds?: Record<number, number>;
}

/** A journey stored in the browser library (and the file export shape). */
export interface SavedJourney extends JourneySnapshot {
  id: string;
  name: string;
  /** Epoch ms. */
  savedAt: number;
  /** Metres, informational only. */
  distance?: number;
}

/** Runtime validation for untrusted JSON (imported files, localStorage). */
export function parseSnapshot(value: unknown): JourneySnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<SavedJourney>;
  if (typeof v.modeId !== 'string' || !Array.isArray(v.waypoints)) return null;
  const waypoints = v.waypoints.filter(
    (p): p is { lat: number; lng: number } =>
      !!p && typeof p.lat === 'number' && typeof p.lng === 'number' &&
      Number.isFinite(p.lat) && Number.isFinite(p.lng),
  );
  if (waypoints.length < 2 || waypoints.length !== v.waypoints.length) return null;

  const legModes: Record<number, string> = {};
  if (v.legModes && typeof v.legModes === 'object') {
    for (const [k, m] of Object.entries(v.legModes)) {
      const i = Number(k);
      if (Number.isInteger(i) && i >= 0 && typeof m === 'string') legModes[i] = m;
    }
  }
  const legSpeeds: Record<number, number> = {};
  if (v.legSpeeds && typeof v.legSpeeds === 'object') {
    for (const [k, f] of Object.entries(v.legSpeeds)) {
      const i = Number(k);
      if (
        Number.isInteger(i) && i >= 0 &&
        typeof f === 'number' && Number.isFinite(f) && f >= 0.1 && f <= 5
      ) {
        legSpeeds[i] = f;
      }
    }
  }
  return { modeId: v.modeId, waypoints, legModes, legSpeeds };
}
