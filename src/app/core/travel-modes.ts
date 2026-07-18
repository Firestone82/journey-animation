import * as L from 'leaflet';
import 'leaflet-routing-machine';
import { StraightLineRouter } from './straight-line-router';
import { HybridRouter } from './hybrid-router';
import { BRouterRouter } from './brouter-router';

/**
 * A travel mode bundles everything routing + playback need to know.
 *
 * Adding a new mode (e.g. on-foot, flying, train…) means adding one entry
 * to TRAVEL_MODES — nothing else in the app has to change.
 */
export interface TravelMode {
  id: string;
  label: string;
  /** Emoji shown in the mode switcher and used as the moving marker. */
  icon: string;
  /** Fallback average speed (km/h) when the router doesn't return a duration. */
  speedKmh: number;
  /** Short hint shown under the switcher so users know how this mode snaps. */
  snapHint: string;
  /** Builds the router that does the snapping for this mode. */
  createRouter(): L.Routing.IRouter;
}

/**
 * Public OSRM instances by FOSSGIS e.V. (the routing.openstreetmap.de servers).
 * Each profile runs its own instance, so the path segment selects the profile:
 *   routed-bike → prefers cycleways, routed-car → fastest road, routed-foot → footpaths.
 * For production use, host your own OSRM/GraphHopper or use a keyed provider —
 * the demo servers are rate-limited and come with no uptime guarantee.
 */
const OSRM_BASE = 'https://routing.openstreetmap.de';

function osrm(profilePath: string): L.Routing.IRouter {
  return L.Routing.osrmv1({
    serviceUrl: `${OSRM_BASE}/${profilePath}/route/v1`,
    profile: 'driving', // path already selects the real profile on these servers
    useHints: false,
  });
}

export const TRAVEL_MODES: TravelMode[] = [
  {
    id: 'bike',
    label: 'Bike',
    icon: '🚴',
    speedKmh: 18,
    snapHint: 'Prefers dedicated bike paths (BRouter, with elevation) — OSRM fallback',
    // BRouter's trekking profile weights cycleways far above fast main roads
    // and returns elevation. If brouter.de is down, the old OSRM hybrid takes over.
    createRouter: () =>
      new BRouterRouter({
        profile: 'trekking',
        speedKmh: 18,
        fallback: new HybridRouter({
          primary: osrm('routed-bike'),
          fallback: osrm('routed-foot'),
          snapToleranceMeters: 25,
        }),
      }),
  },
  {
    id: 'car',
    label: 'Car',
    icon: '🚗',
    speedKmh: 75,
    snapHint: 'Snaps to the fastest road',
    createRouter: () => osrm('routed-car'),
  },
  {
    id: 'foot',
    label: 'On foot',
    icon: '🚶',
    speedKmh: 5,
    snapHint: 'Snaps to footpaths and trails',
    createRouter: () => osrm('routed-foot'),
  },
  {
    id: 'flight',
    label: 'Flight',
    icon: '🛩️',
    speedKmh: 220,
    snapHint: 'No snapping — great-circle line',
    createRouter: () => new StraightLineRouter(220),
  },
];
