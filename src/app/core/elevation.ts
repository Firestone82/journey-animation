import * as L from 'leaflet';

export interface ElevationChunk {
  color: string;
  coords: L.LatLng[];
}

/** Grade-bucket colours: deep green (steep descent) → red (steep climb). */
const BUCKET_COLORS: Record<number, string> = {
  [-3]: '#1d7d4f',
  [-2]: '#37995a',
  [-1]: '#6fae5f',
  [0]: '#98a08b',
  [1]: '#d1913a',
  [2]: '#cc6633',
  [3]: '#bf3b2b',
};

/** True when enough of the geometry carries altitude to colour it. */
export function hasElevationData(coords: L.LatLng[]): boolean {
  if (coords.length < 2) return false;
  let withAlt = 0;
  for (const c of coords) if (typeof c.alt === 'number') withAlt++;
  return withAlt / coords.length > 0.5;
}

/**
 * Splits a route into runs of similar gradient, each with the colour of its
 * grade bucket. Gradients are smoothed over a small window so GPS/elevation
 * noise doesn't produce confetti.
 */
export function elevationChunks(coords: L.LatLng[]): ElevationChunk[] {
  if (coords.length < 2) return [];

  const grades: number[] = [];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const d = a.distanceTo(b);
    grades.push(
      typeof a.alt === 'number' && typeof b.alt === 'number' && d >= 1
        ? (b.alt - a.alt) / d
        : 0,
    );
  }

  const smoothed = grades.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(grades.length - 1, i + 2); j++) {
      sum += grades[j];
      n++;
    }
    return sum / n;
  });

  const chunks: ElevationChunk[] = [];
  let start = 0;
  let bucket = bucketOf(smoothed[0]);
  for (let i = 1; i <= smoothed.length; i++) {
    const b = i < smoothed.length ? bucketOf(smoothed[i]) : NaN;
    if (b !== bucket) {
      chunks.push({
        color: BUCKET_COLORS[bucket],
        coords: coords.slice(start, i + 1),
      });
      start = i;
      bucket = b;
    }
  }
  return chunks;
}

function bucketOf(grade: number): number {
  const abs = Math.abs(grade);
  const mag = abs >= 0.06 ? 3 : abs >= 0.025 ? 2 : abs >= 0.008 ? 1 : 0;
  return grade < 0 ? -mag : mag;
}
