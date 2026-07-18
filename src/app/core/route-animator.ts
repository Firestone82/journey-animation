import * as L from 'leaflet';

export interface AnimatorFrame {
  /** 0..1 along the whole route. */
  progress: number;
  /** Metres travelled so far. */
  travelled: number;
  /** Index of the last waypoint passed (0 = start). */
  lastWaypoint: number;
  position: L.LatLng;
  finished: boolean;
}

/**
 * Drives a marker along a polyline at constant ground speed, scaled so the
 * whole trip plays back in a comfortable duration. Pure playback — knows
 * nothing about routing.
 */
export class RouteAnimator {
  private raf = 0;
  private startTs = 0;
  private pausedAt = 0; // progress 0..1 when paused
  private speedFactor = 1;

  private readonly cumulative: number[] = [];
  private readonly total: number = 0;
  private readonly baseDurationMs: number;

  playing = false;

  constructor(
    private readonly coords: L.LatLng[],
    /** Coordinate indices where user waypoints sit (ascending). */
    private readonly waypointIndices: number[],
    private readonly onFrame: (frame: AnimatorFrame) => void,
  ) {
    let acc = 0;
    this.cumulative.push(0);
    for (let i = 1; i < coords.length; i++) {
      acc += coords[i - 1].distanceTo(coords[i]);
      this.cumulative.push(acc);
    }
    this.total = acc;
    // 12s for a short hop, up to 40s for a long tour.
    this.baseDurationMs = Math.min(40_000, Math.max(12_000, this.total / 4));
  }

  get totalDistance(): number {
    return this.total;
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
    const target = progress * this.total;

    // Binary search for the segment containing `target`.
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo);
    const segStart = this.cumulative[i - 1];
    const segLen = this.cumulative[i] - segStart || 1;
    const t = Math.min(1, Math.max(0, (target - segStart) / segLen));

    const a = this.coords[i - 1];
    const b = this.coords[i];
    const position = L.latLng(
      a.lat + (b.lat - a.lat) * t,
      a.lng + (b.lng - a.lng) * t,
    );

    let lastWaypoint = 0;
    for (let w = 0; w < this.waypointIndices.length; w++) {
      if (this.waypointIndices[w] <= i - 1 || progress >= 1) lastWaypoint = w;
      else break;
    }
    if (progress >= 1) lastWaypoint = this.waypointIndices.length - 1;

    this.onFrame({
      progress,
      travelled: target,
      lastWaypoint,
      position,
      finished: progress >= 1,
    });
  }
}
