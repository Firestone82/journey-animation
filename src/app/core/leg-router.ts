import * as L from 'leaflet';
import 'leaflet-routing-machine';

import { TravelMode } from './travel-modes';
import { routeOnce } from './hybrid-router';

/** One routed leg between two consecutive user waypoints. */
export interface RoutedLeg {
  coordinates: L.LatLng[];
  /** Metres. */
  distance: number;
  /** Seconds. */
  time: number;
  /** The travel mode this leg was routed with. */
  modeId: string;
}

/** The stitched route LegRouter hands back to Leaflet Routing Machine. */
export interface LegRoute extends L.Routing.IRoute {
  legs: RoutedLeg[];
  /** Index of each user waypoint inside `coordinates`. */
  waypointIndices: number[];
  inputWaypoints: L.Routing.Waypoint[];
}

export interface LegRouterOptions {
  /** Mode to route leg `legIndex` with (global mode or a per-leg override). */
  modeForLeg(legIndex: number): TravelMode;
  /** Max cached legs before the oldest are evicted. */
  cacheSize?: number;
}

/**
 * Routes every pair of consecutive waypoints as its own request and caches
 * the result per (mode, from, to). Moving, adding or removing one waypoint
 * therefore only re-fetches the legs that actually touch it — the rest of
 * the journey is served from cache. Routing per leg is also what makes
 * per-leg travel modes possible: each leg simply asks its own mode's router.
 */
export class LegRouter implements L.Routing.IRouter {
  private readonly routers = new Map<string, L.Routing.IRouter>();
  private readonly cache = new Map<string, Promise<RoutedLeg>>();
  private readonly cacheSize: number;

  constructor(private readonly options: LegRouterOptions) {
    this.cacheSize = options.cacheSize ?? 300;
  }

  route(
    waypoints: L.Routing.Waypoint[],
    callback: (err?: L.Routing.IError, routes?: L.Routing.IRoute[]) => void,
    context?: unknown,
  ): void {
    const legPromises: Promise<RoutedLeg>[] = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      legPromises.push(this.leg(waypoints[i], waypoints[i + 1], this.options.modeForLeg(i)));
    }

    Promise.all(legPromises)
      .then((legs) => callback.call(context ?? this, undefined, [stitch(waypoints, legs)]))
      .catch((err: L.Routing.IError) => callback.call(context ?? this, err));
  }

  clearCache(): void {
    this.cache.clear();
  }

  private leg(
    a: L.Routing.Waypoint,
    b: L.Routing.Waypoint,
    mode: TravelMode,
  ): Promise<RoutedLeg> {
    const key = `${mode.id}|${coordKey(a.latLng)}|${coordKey(b.latLng)}`;
    const hit = this.cache.get(key);
    if (hit) {
      // Refresh recency so hot legs survive eviction.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }

    // Cache the promise itself so concurrent requests for the same leg
    // (e.g. while dragging) share one network call.
    const pending = this.fetchLeg(a, b, mode).catch((err) => {
      this.cache.delete(key);
      throw err;
    });
    this.cache.set(key, pending);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return pending;
  }

  private async fetchLeg(
    a: L.Routing.Waypoint,
    b: L.Routing.Waypoint,
    mode: TravelMode,
  ): Promise<RoutedLeg> {
    // Fresh waypoint objects keep inner routers from mutating the plan's.
    const route = await routeOnce(this.routerFor(mode), [
      L.Routing.waypoint(a.latLng, a.name),
      L.Routing.waypoint(b.latLng, b.name),
    ]);
    const coordinates = route.coordinates ?? [];
    const distance = route.summary?.totalDistance ?? pathLength(coordinates);
    const time =
      route.summary?.totalTime && route.summary.totalTime > 0
        ? route.summary.totalTime
        : distance / (mode.speedKmh / 3.6);
    return { coordinates, distance, time, modeId: mode.id };
  }

  private routerFor(mode: TravelMode): L.Routing.IRouter {
    let router = this.routers.get(mode.id);
    if (!router) {
      router = mode.createRouter();
      this.routers.set(mode.id, router);
    }
    return router;
  }
}

function stitch(waypoints: L.Routing.Waypoint[], legs: RoutedLeg[]): LegRoute {
  const coordinates: L.LatLng[] = [];
  const waypointIndices: number[] = [0];
  let totalDistance = 0;
  let totalTime = 0;

  for (const leg of legs) {
    // Legs routed with different modes may snap the shared waypoint to
    // different spots, so keep both endpoints instead of deduplicating.
    coordinates.push(...leg.coordinates);
    waypointIndices.push(Math.max(0, coordinates.length - 1));
    totalDistance += leg.distance;
    totalTime += leg.time;
  }

  return {
    name: 'Journey',
    coordinates,
    instructions: [],
    inputWaypoints: waypoints,
    waypoints: waypoints.map((w) => w.latLng),
    summary: { totalDistance, totalTime },
    legs,
    waypointIndices,
  } as LegRoute;
}

function coordKey(p: L.LatLng): string {
  return `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}

function pathLength(coords: L.LatLng[]): number {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += coords[i - 1].distanceTo(coords[i]);
  return d;
}
