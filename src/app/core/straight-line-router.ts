import * as L from 'leaflet';
import 'leaflet-routing-machine';

/**
 * A Leaflet Routing Machine router that ignores the road network entirely and
 * connects waypoints with great-circle arcs. Used for the flight mode, and a
 * template for any future mode that doesn't snap to roads.
 */
export class StraightLineRouter implements L.Routing.IRouter {
  constructor(private readonly speedKmh: number) {}

  route(
    waypoints: L.Routing.Waypoint[],
    callback: (err?: L.Routing.IError, routes?: L.Routing.IRoute[]) => void,
    context?: unknown,
  ): void {
    const coordinates: L.LatLng[] = [];
    let totalDistance = 0;

    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i].latLng;
      const b = waypoints[i + 1].latLng;
      const leg = greatCircle(a, b, 96);
      if (i > 0) leg.shift(); // avoid duplicating shared waypoint
      coordinates.push(...leg);
      totalDistance += a.distanceTo(b);
    }

    const route = {
      name: 'Direct line',
      coordinates,
      instructions: [],
      inputWaypoints: waypoints,
      waypoints: waypoints.map((w) => w.latLng),
      summary: {
        totalDistance,
        totalTime: totalDistance / (this.speedKmh / 3.6),
      },
    } as L.Routing.IRoute;

    // LRM expects the callback asynchronously.
    setTimeout(() => callback.call(context ?? this, undefined, [route]), 0);
  }
}

/** Interpolates n points along the great circle between two coordinates. */
function greatCircle(a: L.LatLng, b: L.LatLng, n: number): L.LatLng[] {
  const va = toVector(a);
  const vb = toVector(b);
  const omega = Math.acos(Math.min(1, Math.max(-1, dot(va, vb))));

  if (omega < 1e-9) return [a, b];

  const points: L.LatLng[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s1 = Math.sin((1 - t) * omega) / Math.sin(omega);
    const s2 = Math.sin(t * omega) / Math.sin(omega);
    points.push(
      toLatLng([
        s1 * va[0] + s2 * vb[0],
        s1 * va[1] + s2 * vb[1],
        s1 * va[2] + s2 * vb[2],
      ]),
    );
  }
  return points;
}

type Vec3 = [number, number, number];

function toVector(p: L.LatLng): Vec3 {
  const lat = (p.lat * Math.PI) / 180;
  const lng = (p.lng * Math.PI) / 180;
  return [
    Math.cos(lat) * Math.cos(lng),
    Math.cos(lat) * Math.sin(lng),
    Math.sin(lat),
  ];
}

function toLatLng(v: Vec3): L.LatLng {
  const [x, y, z] = v;
  return L.latLng(
    (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI,
    (Math.atan2(y, x) * 180) / Math.PI,
  );
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
