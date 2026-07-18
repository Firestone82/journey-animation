import * as L from 'leaflet';
import 'leaflet-routing-machine';

export interface HybridRouterOptions {
  /** Preferred network — e.g. the OSRM bike profile. */
  primary: L.Routing.IRouter;
  /** Network allowed only around user-placed points — e.g. the foot profile. */
  fallback: L.Routing.IRouter;
  /**
   * If the primary profile has to snap a user-placed point further than this
   * (metres), the point is considered unreachable on the preferred network
   * and the legs around it are re-routed with the fallback profile.
   */
  snapToleranceMeters?: number;
}

interface Leg {
  coordinates: L.LatLng[];
  distance: number;
  time: number;
}

/**
 * Routes with the primary profile, then inspects how far each user-placed
 * waypoint had to be snapped. Waypoints the primary network can't reach
 * (e.g. a bike route point dropped onto a footpath) get their adjacent legs
 * re-routed with the fallback profile — so foot routes are used only where
 * the user manually put a point on them, never for the route in between.
 */
export class HybridRouter implements L.Routing.IRouter {
  private readonly tolerance: number;

  constructor(private readonly options: HybridRouterOptions) {
    this.tolerance = options.snapToleranceMeters ?? 25;
  }

  route(
    waypoints: L.Routing.Waypoint[],
    callback: (err?: L.Routing.IError, routes?: L.Routing.IRoute[]) => void,
    context?: unknown,
  ): void {
    this.routeHybrid(waypoints)
      .then((routes) => callback.call(context ?? this, undefined, routes))
      .catch((err: L.Routing.IError) => callback.call(context ?? this, err));
  }

  private async routeHybrid(waypoints: L.Routing.Waypoint[]): Promise<L.Routing.IRoute[]> {
    const primary = await routeOnce(this.options.primary, waypoints);
    const snapErrors = this.snapErrors(waypoints, primary);

    const offNetwork = new Set<number>();
    snapErrors.forEach((d, i) => {
      if (d > this.tolerance) offNetwork.add(i);
    });
    if (offNetwork.size === 0) return [primary];

    const legs = await this.buildLegs(waypoints, primary, offNetwork, snapErrors);
    return [this.stitch(primary, waypoints, legs)];
  }

  /** Distance (m) between each requested waypoint and where the route snapped it. */
  private snapErrors(waypoints: L.Routing.Waypoint[], route: L.Routing.IRoute): number[] {
    // At runtime LRM reports snapped positions as Waypoint objects, while the
    // typings say LatLng[] — accept both shapes.
    const snapped: unknown[] = route.waypoints ?? [];
    const latLngOf = (v: unknown): L.LatLng | undefined =>
      v instanceof L.LatLng ? v : (v as { latLng?: L.LatLng } | undefined)?.latLng;
    return waypoints.map((wp, i) => {
      const s = latLngOf(snapped[i]);
      return wp.latLng && s ? wp.latLng.distanceTo(s) : 0;
    });
  }

  private async buildLegs(
    waypoints: L.Routing.Waypoint[],
    primary: L.Routing.IRoute,
    offNetwork: Set<number>,
    primarySnapErrors: number[],
  ): Promise<Leg[]> {
    const primaryLegs = splitIntoLegs(primary);
    const legs: Leg[] = [];

    for (let i = 0; i < waypoints.length - 1; i++) {
      const touchesOffPoint = offNetwork.has(i) || offNetwork.has(i + 1);
      let leg = primaryLegs[i];

      if (touchesOffPoint) {
        const fallbackLeg = await this.tryFallbackLeg(
          waypoints[i],
          waypoints[i + 1],
          offNetwork,
          i,
          primarySnapErrors,
        );
        if (fallbackLeg) leg = fallbackLeg;
      }
      legs.push(leg);
    }
    return legs;
  }

  private async tryFallbackLeg(
    a: L.Routing.Waypoint,
    b: L.Routing.Waypoint,
    offNetwork: Set<number>,
    legIndex: number,
    primarySnapErrors: number[],
  ): Promise<Leg | null> {
    try {
      const route = await routeOnce(this.options.fallback, [a, b]);
      const errors = this.snapErrors([a, b], route);

      // Only accept the fallback if it actually reaches the point(s) the
      // primary network couldn't.
      const endpoints: [number, number][] = [
        [legIndex, 0],
        [legIndex + 1, 1],
      ];
      const improves = endpoints.every(([wpIdx, localIdx]) => {
        if (!offNetwork.has(wpIdx)) return true;
        return errors[localIdx] < Math.min(primarySnapErrors[wpIdx], this.tolerance);
      });
      if (!improves) return null;

      return {
        coordinates: route.coordinates ?? [],
        distance: route.summary?.totalDistance ?? 0,
        time: route.summary?.totalTime ?? 0,
      };
    } catch {
      return null; // fallback failed — keep the primary leg
    }
  }

  private stitch(
    primary: L.Routing.IRoute,
    waypoints: L.Routing.Waypoint[],
    legs: Leg[],
  ): L.Routing.IRoute {
    const coordinates: L.LatLng[] = [];
    let totalDistance = 0;
    let totalTime = 0;

    for (const [i, leg] of legs.entries()) {
      const coords = i > 0 ? leg.coordinates.slice(1) : leg.coordinates;
      coordinates.push(...coords);
      totalDistance += leg.distance;
      totalTime += leg.time;
    }

    return {
      name: primary.name,
      coordinates,
      instructions: [],
      inputWaypoints: waypoints,
      waypoints: waypoints.map((w) => w.latLng),
      summary: { totalDistance, totalTime },
    } as L.Routing.IRoute;
  }
}

/** Promisified single call to an LRM router. */
export function routeOnce(
  router: L.Routing.IRouter,
  waypoints: L.Routing.Waypoint[],
): Promise<L.Routing.IRoute> {
  return new Promise((resolve, reject) => {
    router.route(waypoints, (err?: L.Routing.IError, routes?: L.Routing.IRoute[]) => {
      if (err || !routes?.length) {
        reject(err ?? { status: -1, message: 'No route found.' });
      } else {
        resolve(routes[0]);
      }
    });
  });
}

/**
 * Splits a multi-waypoint route into per-leg geometry using the coordinate
 * indices OSRM reports for each waypoint. Distance/time are apportioned by
 * leg length since OSRM only reports totals through LRM.
 */
function splitIntoLegs(route: L.Routing.IRoute): Leg[] {
  const coords = route.coordinates ?? [];
  const indices: number[] =
    (route as unknown as { waypointIndices?: number[] }).waypointIndices ??
    [0, coords.length - 1];

  const legs: Leg[] = [];
  const totalDistance = route.summary?.totalDistance ?? 0;
  const totalTime = route.summary?.totalTime ?? 0;

  const legLengths: number[] = [];
  for (let i = 0; i < indices.length - 1; i++) {
    const slice = coords.slice(indices[i], indices[i + 1] + 1);
    let d = 0;
    for (let j = 1; j < slice.length; j++) d += slice[j - 1].distanceTo(slice[j]);
    legLengths.push(d);
    legs.push({ coordinates: slice, distance: d, time: 0 });
  }

  const geomTotal = legLengths.reduce((a, b) => a + b, 0) || 1;
  for (const [i, leg] of legs.entries()) {
    const share = legLengths[i] / geomTotal;
    leg.distance = totalDistance * share || leg.distance;
    leg.time = totalTime * share;
  }
  return legs;
}
