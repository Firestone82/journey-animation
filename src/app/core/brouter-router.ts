import * as L from 'leaflet';
import 'leaflet-routing-machine';

export interface BRouterOptions {
  /** BRouter profile, e.g. 'trekking' (strongly prefers cycle paths). */
  profile: string;
  /** Fallback average speed (km/h) when the server omits a duration. */
  speedKmh: number;
  /** Router used when the BRouter request fails (e.g. the OSRM hybrid). */
  fallback?: L.Routing.IRouter;
  serviceUrl?: string;
}

/**
 * Routes via the public BRouter server (brouter.de). Unlike the OSRM car/bike
 * profiles, BRouter's trekking profile heavily weights dedicated cycleways
 * over fast main roads, and its geometry carries per-point elevation — which
 * feeds the elevation colouring and the slope-aware playback speed.
 */
export class BRouterRouter implements L.Routing.IRouter {
  private readonly serviceUrl: string;

  constructor(private readonly options: BRouterOptions) {
    this.serviceUrl = options.serviceUrl ?? 'https://brouter.de/brouter';
  }

  route(
    waypoints: L.Routing.Waypoint[],
    callback: (err?: L.Routing.IError, routes?: L.Routing.IRoute[]) => void,
    context?: unknown,
  ): void {
    this.fetchRoute(waypoints)
      .then((route) => callback.call(context ?? this, undefined, [route]))
      .catch((err: L.Routing.IError) => {
        if (this.options.fallback) {
          this.options.fallback.route(waypoints, callback, (context ?? this) as object);
        } else {
          callback.call(context ?? this, err);
        }
      });
  }

  private async fetchRoute(waypoints: L.Routing.Waypoint[]): Promise<L.Routing.IRoute> {
    const lonlats = waypoints
      .map((w) => `${w.latLng.lng.toFixed(6)},${w.latLng.lat.toFixed(6)}`)
      .join('|');
    const url =
      `${this.serviceUrl}?lonlats=${lonlats}` +
      `&profile=${this.options.profile}&alternativeidx=0&format=geojson`;

    const res = await fetch(url);
    if (!res.ok) {
      throw { status: res.status, message: `BRouter: HTTP ${res.status}` };
    }
    const geo = (await res.json()) as {
      features?: {
        geometry?: { coordinates?: [number, number, number?][] };
        properties?: Record<string, string>;
      }[];
    };
    const feature = geo.features?.[0];
    const raw = feature?.geometry?.coordinates;
    if (!raw?.length) {
      throw { status: -1, message: 'BRouter returned no route.' };
    }

    // GeoJSON is [lng, lat, alt]; keep the altitude on the LatLng.
    const coordinates = raw.map(([lng, lat, alt]) => L.latLng(lat, lng, alt));
    let pathLen = 0;
    for (let i = 1; i < coordinates.length; i++) {
      pathLen += coordinates[i - 1].distanceTo(coordinates[i]);
    }
    const distance = Number(feature?.properties?.['track-length']) || pathLen;
    const time =
      Number(feature?.properties?.['total-time']) ||
      distance / (this.options.speedKmh / 3.6);

    return {
      name: 'BRouter',
      coordinates,
      instructions: [],
      inputWaypoints: waypoints,
      waypoints: waypoints.map((w) => w.latLng),
      summary: { totalDistance: distance, totalTime: time },
    } as L.Routing.IRoute;
  }
}
