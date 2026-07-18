# Route Reel

Draw a route from A to B with stops, snapped to the road network per travel
mode, then replay the trip as an animated slideshow.

## Run it

```bash
npm install
npm start          # http://localhost:4200
```

## How to use

1. Pick a travel mode — **Bike** snaps to cycle paths first, **Car** to the
   fastest road, **On foot** to footpaths, **Flight** draws a great-circle line.
2. Click the map to place the start, the finish, and any stops in between.
   In bike mode, points you drop on foot-only paths are honored: the legs
   around that point may use foot routes, while everything else keeps
   preferring cycle paths.
3. Drag the route line anywhere to reroute — a new via point is inserted and
   the route re-snaps live while you drag.
4. Click any pin (start, finish, or a dragged via point) and hit
   **Remove point** to delete it.
5. Press **Play** to animate the trip. The camera can follow the rider,
   playback speed is 0.5–4×, and the reel bar marks each stop.

## Structure

```
src/app/
  core/                     plain classes, no Angular
    travel-modes.ts           mode registry — add future modes here
    hybrid-router.ts          bike-first router with foot fallback at user points
    straight-line-router.ts   great-circle router (flight / non-snapping modes)
    route-animator.ts         constant-speed playback along a polyline
    format.ts                 km / duration formatting
  services/
    trip.service.ts           all trip state (signals) + Leaflet/LRM wiring
  components/                 each: .ts + .html + .scss in its own folder
    route-map/                thin host for the Leaflet map
    mode-switcher/            travel mode radio group
    route-summary/            stats, how-to, errors, clear
    playback-controls/        reel bar, play/restart/speed/follow
    trip-caption/             floating caption during playback
```

Components hold no logic — they render `TripService` signals and call its
commands. Adding a travel mode is one entry in `core/travel-modes.ts`.

## How the bike + foot hybrid works

`HybridRouter` routes the whole trip with the bike profile first, then checks
how far each of your points had to be snapped. If a point ended up more than
~25 m from where you placed it, the bike network can't reach it — so the legs
touching that point are re-routed with the foot profile, and accepted only if
they actually get closer to your point. Everything else stays on the bike
network, so foot routes are used exactly where you manually put a point on
them and nowhere else.

## Routing backend

Snapping uses the public OSRM instances at `routing.openstreetmap.de`
(FOSSGIS e.V.), which run separate bike / car / foot profiles. They are demo
servers: rate-limited, no SLA. For anything serious, self-host OSRM (one
instance per profile) or point `travel-modes.ts` at GraphHopper /
openrouteservice with an API key — only the `serviceUrl` values change.

## CI / deployment

`.github/workflows/ci.yml`:

- **lint + build** on every push and pull request
- **deploy to GitHub Pages** on pushes to `main` (set Pages source to
  "GitHub Actions" in the repo settings once)
- **GitHub Release** with a zipped build when you push a `v*` tag

The Pages build sets `--base-href` from the repo name automatically. Since
the app calls OSRM and the tile servers straight from the browser, every
visitor consumes their own rate limit — there's no backend to share.

## Known trade-offs

- Leaflet Routing Machine has no public API to swap routers, so mode
  switching replaces the private `_router` field and re-routes (a widely used
  pattern with LRM).
- Waypoints are unnamed (Start / Stop n / Finish). Reverse geocoding would
  need a Nominatim or commercial geocoder call per point.
