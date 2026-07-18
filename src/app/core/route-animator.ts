import * as L from 'leaflet';

export interface AnimatorFrame {
  /** 0..1 along the whole route (by playback time, not distance). */
  progress: number;
  /** Metres travelled so far. */
  travelled: number;
  /** Index of the last waypoint passed (0 = start). */
  lastWaypoint: number;
  position: L.LatLng;
  finished: boolean;
}

export interface AnimatorOptions {
  /** Playback-speed multiplier for one leg (1 = trip speed). */
  legSpeedFactor?(legIndex: number): number;
}

/**
 * Drives a marker along a polyline, scaled so the whole trip plays back in a
 * comfortable duration. Ground speed is not constant: uphill segments play
 * slower and downhill faster (when the geometry carries elevation), and each
 * leg can carry its own speed multiplier. Pure playback — knows nothing
 * about routing.
 */
export class RouteAnimator {
  private raf = 0;
  private startTs = 0;
  private pausedAt = 0; // progress 0..1 when paused
  private speedFactor = 1;

  private readonly segDist: number[] = []; // metres per segment
  private readonly cumDist: number[] = [];
  /** Cumulative playback-time weight — the marker moves at dDist/dWeight. */
  private readonly cumWeight: number[] = [];
  private readonly total: number = 0;
  private readonly totalWeight: number = 1;
  private readonly baseDurationMs: number;

  playing = false;

  constructor(
    private readonly coords: L.LatLng[],
    /** Coordinate indices where user waypoints sit (ascending). */
    private readonly waypointIndices: number[],
    private readonly onFrame: (frame: AnimatorFrame) => void,
    options: AnimatorOptions = {},
  ) {
    const legFactor = options.legSpeedFactor ?? (() => 1);
    let leg = 0;
    let accD = 0;
    let accW = 0;
    this.cumDist.push(0);
    this.cumWeight.push(0);
    for (let i = 1; i < coords.length; i++) {
      while (
        leg + 1 < waypointIndices.length - 1 &&
        i - 1 >= waypointIndices[leg + 1]
      ) {
        leg++;
      }
      const d = coords[i - 1].distanceTo(coords[i]);
      const factor =
        slopeFactor(coords[i - 1], coords[i], d) *
        Math.max(0.1, legFactor(leg));
      accD += d;
      accW += d / factor;
      this.segDist.push(d);
      this.cumDist.push(accD);
      this.cumWeight.push(accW);
    }
    this.total = accD;
    this.totalWeight = accW || 1;
    // 12s for a short hop, up to 40s for a long tour.
    this.baseDurationMs = Math.min(40_000, Math.max(12_000, this.total / 4));
  }

  get totalDistance(): number {
    return this.total;
  }

  /** Playback progress (0..1) at which a coordinate index is reached. */
  progressAt(coordIndex: number): number {
    const i = Math.min(Math.max(coordIndex, 0), this.cumWeight.length - 1);
    return this.cumWeight[i] / this.totalWeight;
  }

  setSpeed(factor: number): void {
    if (this.playing) {
      // Re-anchor so the change doesn't jump the marker.
      this.pausedAt = this.currentProgress();
      this.startTs = performance.now();
    }
    this.speedFactor = factor;
  }

  play(): void {
    if (this.playing) return;
    if (this.pausedAt >= 1) this.pausedAt = 0;
    this.playing = true;
    this.startTs = performance.now();
    this.tick();
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.currentProgress();
    this.stop();
  }

  restart(): void {
    this.stop();
    this.pausedAt = 0;
    this.emit(0);
  }

  destroy(): void {
    this.stop();
  }

  private stop(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }

  private currentProgress(): number {
    const elapsed = (performance.now() - this.startTs) * this.speedFactor;
    return Math.min(1, this.pausedAt + elapsed / this.baseDurationMs);
  }

  private tick = (): void => {
    const progress = this.currentProgress();
    this.emit(progress);
    if (progress >= 1) {
      this.pausedAt = 1;
      this.stop();
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private emit(progress: number): void {
    const target = progress * this.totalWeight;

    // Binary search for the segment containing `target`.
    let lo = 0;
    let hi = this.cumWeight.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumWeight[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo);
    const segStart = this.cumWeight[i - 1];
    const segLen = this.cumWeight[i] - segStart || 1;
    const t = Math.min(1, Math.max(0, (target - segStart) / segLen));

    const a = this.coords[i - 1];
    const b = this.coords[i];
    const position = L.latLng(
      a.lat + (b.lat - a.lat) * t,
      a.lng + (b.lng - a.lng) * t,
    );
    const travelled = this.cumDist[i - 1] + (this.segDist[i - 1] ?? 0) * t;

    let lastWaypoint = 0;
    for (let w = 0; w < this.waypointIndices.length; w++) {
      if (this.waypointIndices[w] <= i - 1 || progress >= 1) lastWaypoint = w;
      else break;
    }
    if (progress >= 1) lastWaypoint = this.waypointIndices.length - 1;

    this.onFrame({
      progress,
      travelled,
      lastWaypoint,
      position,
      finished: progress >= 1,
    });
  }
}

/**
 * Relative ground speed for a segment from its gradient: climbing slows the
 * rider down, descending speeds them up. 1 when no elevation data.
 */
function slopeFactor(a: L.LatLng, b: L.LatLng, dist: number): number {
  if (typeof a.alt !== 'number' || typeof b.alt !== 'number' || dist < 1) return 1;
  const grade = Math.max(-0.25, Math.min(0.25, (b.alt - a.alt) / dist));
  return Math.max(0.45, Math.min(1.7, 1 - grade * 6));
}
