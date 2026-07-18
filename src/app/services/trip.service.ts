import { Injectable, NgZone, inject, signal } from '@angular/core';
import * as L from 'leaflet';
import 'leaflet-routing-machine';

import { TRAVEL_MODES, TravelMode } from '../core/travel-modes';
import { RouteAnimator, AnimatorFrame } from '../core/route-animator';
import { LegRoute, LegRouter, RoutedLeg } from '../core/leg-router';
import { JourneySnapshot, parseSnapshot } from '../core/journey';

/** LRM's runtime route object carries more than the published IRoute type. */
interface RouteResult extends L.Routing.IRoute {
  inputWaypoints?: L.Routing.Waypoint[];
}

/** The in-progress journey survives reloads via this key. */
const CURRENT_KEY = 'route-reel:current';

/**
 * Owns all trip state and the Leaflet routing/playback machinery.
 * Components stay thin: they render the signals and call the commands below.
 */
@Injectable({ providedIn: 'root' })
export class TripService {
  private readonly zone = inject(NgZone);

  // --- State (read-only signals for components) -------------------------
  readonly mode = signal<TravelMode>(TRAVEL_MODES[0]);
  readonly waypointCount = signal(0);
  readonly hasRoute = signal(false);
  readonly routing = signal(false);
  readonly error = signal<string | null>(null);
  readonly distance = signal(0); // metres
  readonly duration = signal(0); // seconds
  /** Routed legs between consecutive pins, in order. */
  readonly legs = signal<RoutedLeg[]>([]);
  /** Per-leg mode overrides (leg index → mode id); absent legs use `mode`. */
  readonly legModes = signal<Record<number, string>>({});

  readonly playing = signal(false);
  readonly progress = signal(0); // 0..1
  readonly travelled = signal(0); // metres
  readonly caption = signal('');
  readonly follow = signal(true);
  readonly speed = signal(1);
  readonly stopTicks = signal<number[]>([]);

  // --- Leaflet internals ------------------------------------------------
  private map!: L.Map;
  private plan!: L.Routing.Plan;
  private control!: L.Routing.Control;
  private travelMarker: L.Marker | null = null;
  private markerModeId = '';

  private readonly legRouter = new LegRouter({
    modeForLeg: (i) => this.resolveLegMode(i),
  });

  private routeCoords: L.LatLng[] = [];
  private waypointIndices: number[] = [];
  private legGeometries: L.LatLng[][] = [];
  private legModeIds: string[] = [];
  private animator: RouteAnimator | null = null;
  private fittedOnce = false;
  private lastUiPush = 0;

  // --- Map wiring (called once by RouteMapComponent) --------------------

  attachMap(container: HTMLElement): void {
    this.zone.runOutsideAngular(() => this.initMap(container));
    const saved = this.readCurrent();
    if (saved) this.loadJourney(saved);
  }

  detachMap(): void {
    this.animator?.destroy();
    this.map?.remove();
  }

  private initMap(container: HTMLElement): void {
    this.map = L.map(container, {
      zoomControl: false,
      center: [50.06, 15.05],
      zoom: 8,
    });
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);

    // Center on the user if they allow it; the default view stays otherwise.
    // Skip when a saved journey is about to be restored — fitBounds wins.
    if (!this.readCurrent()) {
      this.map.locate({ setView: true, maxZoom: 13 });
    }

    this.plan = L.Routing.plan([], {
      draggableWaypoints: true,
      addWaypoints: true, // dragging the line inserts a via point
      createMarker: (i: number, wp: L.Routing.Waypoint, n: number) =>
        this.createWaypointMarker(i, wp, n),
    });

    this.control = L.Routing
      .control({
        plan: this.plan,
        router: this.legRouter,
        routeWhileDragging: true,
        show: false, // the app panel replaces LRM's itinerary
        fitSelectedRoutes: false,
        showAlternatives: false,
        lineOptions: {
          addWaypoints: true,
          missingRouteTolerance: 10,
          extendToWaypoints: true,
          // Colors come from the theme tokens via the class names (styles.scss);
          // the hex values are only the pre-CSS fallback.
          styles: [
            { className: 'route-casing', color: '#0e1f1a', opacity: 0.55, weight: 9 },
            { className: 'route-line', color: '#f2a33c', opacity: 1, weight: 5 },
          ],
        },
      })
      .addTo(this.map);

    this.map.on('click', (e: L.LeafletMouseEvent) => this.appendWaypoint(e.latlng));

    this.control.on('routingstart', () =>
      this.push(() => {
        this.routing.set(true);
        this.error.set(null);
      }),
    );

    this.control.on('routesfound', (e) =>
      this.onRoutesFound(e as unknown as L.Routing.RoutingResultEvent),
    );

    this.control.on('routingerror', (e) =>
      this.onRoutingError(e as unknown as L.Routing.RoutingErrorEvent),
    );

    this.plan.on('waypointschanged', () =>
      this.push(() => {
        this.waypointCount.set(this.placedWaypoints().length);
        this.trimLegModes();
        if (this.waypointCount() < 2) this.clearRouteState();
      }),
    );
  }

  private onRoutingError(e: L.Routing.RoutingErrorEvent): void {
    this.push(() => {
      this.routing.set(false);
      this.hasRoute.set(false);
      this.error.set(
        e?.error?.message ??
          'The routing server could not build a route between these points.',
      );
    });
  }

  // --- Commands ---------------------------------------------------------

  setMode(mode: TravelMode): void {
    if (mode.id === this.mode().id) return;
    this.mode.set(mode);
    this.resetPlayback();
    // Legs already fetched for this mode come straight from the router cache.
    this.reroute();
  }

  /** Overrides the travel mode of one leg; `null` returns it to the trip mode. */
  setLegMode(legIndex: number, modeId: string | null): void {
    const current = this.legModes();
    if ((current[legIndex] ?? null) === modeId) return;
    const next = { ...current };
    if (modeId === null) delete next[legIndex];
    else next[legIndex] = modeId;
    this.legModes.set(next);
    this.resetPlayback();
    this.reroute();
  }

  clearAll(): void {
    this.resetPlayback();
    this.legModes.set({});
    this.plan.setWaypoints([]);
    this.fittedOnce = false;
    this.clearRouteState();
    try {
      localStorage.removeItem(CURRENT_KEY);
    } catch {
      // Storage unavailable — nothing to clear.
    }
  }

  togglePlay(): void {
    if (!this.animator) return;
    if (this.playing()) {
      this.animator.pause();
      this.playing.set(false);
      return;
    }
    if (!this.travelMarker) {
      this.markerModeId = this.legModeIds[0] ?? this.mode().id;
      this.travelMarker = L.marker(this.routeCoords[0], {
        interactive: false,
        zIndexOffset: 1000,
        icon: this.travelIcon(this.markerModeId),
      });
      this.zone.runOutsideAngular(() => this.travelMarker!.addTo(this.map));
    }
    this.playing.set(true);
    this.caption.set('Rolling…');
    this.zone.runOutsideAngular(() => {
      this.animator!.setSpeed(this.speed());
      this.animator!.play();
    });
  }

  restart(): void {
    if (!this.animator) return;
    this.animator.restart();
    this.playing.set(false);
    this.progress.set(0);
    this.travelled.set(0);
    this.caption.set('');
  }

  setSpeed(factor: number): void {
    this.speed.set(factor);
    this.animator?.setSpeed(factor);
  }

  toggleFollow(): void {
    this.follow.set(!this.follow());
  }

  /** Zooms the map to one leg (used by the route browser). */
  focusLeg(legIndex: number): void {
    const coords = this.legGeometries[legIndex];
    if (!coords?.length) return;
    this.zone.runOutsideAngular(() =>
      this.map.fitBounds(L.latLngBounds(coords), { padding: [64, 64] }),
    );
  }

  // --- Journeys ---------------------------------------------------------

  /** Serializable description of the current journey (null until 2+ pins). */
  snapshot(): JourneySnapshot | null {
    const waypoints = this.placedWaypoints().map((w) => ({
      lat: w.latLng.lat,
      lng: w.latLng.lng,
    }));
    if (waypoints.length < 2) return null;
    return {
      modeId: this.mode().id,
      waypoints,
      legModes: { ...this.legModes() },
    };
  }

  loadJourney(journey: JourneySnapshot): void {
    const mode = TRAVEL_MODES.find((m) => m.id === journey.modeId) ?? TRAVEL_MODES[0];
    this.mode.set(mode);
    this.legModes.set({ ...(journey.legModes ?? {}) });
    this.resetPlayback();
    this.fittedOnce = false;
    this.zone.runOutsideAngular(() =>
      this.plan.setWaypoints(
        journey.waypoints.map((p) => L.Routing.waypoint(L.latLng(p.lat, p.lng))),
      ),
    );
  }

  private autosaveCurrent(): void {
    const snap = this.snapshot();
    try {
      if (snap) localStorage.setItem(CURRENT_KEY, JSON.stringify(snap));
    } catch {
      // Storage unavailable — skip the autosave.
    }
  }

  private readCurrent(): JourneySnapshot | null {
    try {
      const raw = localStorage.getItem(CURRENT_KEY);
      return raw ? parseSnapshot(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  // --- Waypoints --------------------------------------------------------

  private placedWaypoints(): L.Routing.Waypoint[] {
    return this.plan.getWaypoints().filter((w) => !!w.latLng);
  }

  private appendWaypoint(latlng: L.LatLng): void {
    const wps = this.plan.getWaypoints();
    const empty = wps.findIndex((w) => !w.latLng);
    if (empty >= 0) {
      this.plan.spliceWaypoints(empty, 1, L.Routing.waypoint(latlng));
    } else {
      this.plan.spliceWaypoints(wps.length, 0, L.Routing.waypoint(latlng));
    }
  }

  private createWaypointMarker(i: number, wp: L.Routing.Waypoint, n: number): L.Marker {
    const label = i === 0 ? 'A' : i === n - 1 ? 'B' : String(i);
    const kind = i === 0 ? 'start' : i === n - 1 ? 'end' : 'via';
    const marker = L.marker(wp.latLng, {
      draggable: true,
      icon: L.divIcon({
        className: '',
        html: `<div class="wp-pin wp-${kind}">${label}</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
    });

    const title = i === 0 ? 'Start' : i === n - 1 ? 'Finish' : `Stop ${i}`;
    const el = document.createElement('div');
    el.className = 'wp-popup';
    const strong = document.createElement('strong');
    strong.textContent = title;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Remove point';
    btn.addEventListener('click', () => {
      this.map.closePopup();
      this.plan.spliceWaypoints(i, 1);
    });
    el.append(strong, btn);
    marker.bindPopup(el, { closeButton: false, offset: L.point(0, -8) });
    return marker;
  }

  private trimLegModes(): void {
    const legCount = Math.max(0, this.placedWaypoints().length - 1);
    const current = this.legModes();
    const stale = Object.keys(current).filter((k) => Number(k) >= legCount);
    if (!stale.length) return;
    const next = { ...current };
    for (const k of stale) delete next[Number(k)];
    this.legModes.set(next);
  }

  private resolveLegMode(legIndex: number): TravelMode {
    const id = this.legModes()[legIndex];
    return (id && TRAVEL_MODES.find((m) => m.id === id)) || this.mode();
  }

  private reroute(): void {
    if (this.placedWaypoints().length >= 2) {
      this.zone.runOutsideAngular(() => this.control.route());
    }
  }

  // --- Routing results --------------------------------------------------

  private onRoutesFound(e: L.Routing.RoutingResultEvent): void {
    const route = e.routes[0] as RouteResult & Partial<LegRoute>;
    this.routeCoords = route.coordinates ?? [];

    // Map each user waypoint to its index in the routed geometry so the
    // playback can tell which stop was just passed. LegRouter reports the
    // exact indices; other routers fall back to a nearest-point search.
    const inputs: L.Routing.Waypoint[] = route.inputWaypoints ?? this.placedWaypoints();
    this.waypointIndices =
      route.waypointIndices ??
      inputs.filter((w) => !!w.latLng).map((w) => this.nearestCoordIndex(w.latLng));

    const legs = route.legs ?? [];
    this.legGeometries = legs.map((l) => l.coordinates);
    this.legModeIds = legs.map((l) => l.modeId);

    const dist = route.summary?.totalDistance ?? 0;
    const time =
      route.summary?.totalTime && route.summary.totalTime > 0
        ? route.summary.totalTime
        : dist / (this.mode().speedKmh / 3.6);

    if (!this.fittedOnce && this.routeCoords.length) {
      this.map.fitBounds(L.latLngBounds(this.routeCoords), { padding: [48, 48] });
      this.fittedOnce = true;
    }

    this.resetPlayback();
    this.animator = new RouteAnimator(this.routeCoords, this.waypointIndices, (f) =>
      this.onAnimationFrame(f),
    );

    this.push(() => {
      this.routing.set(false);
      this.error.set(null);
      this.hasRoute.set(this.routeCoords.length > 1);
      this.distance.set(dist);
      this.duration.set(time);
      this.legs.set(legs);
      this.progress.set(0);
      this.travelled.set(0);
      this.caption.set('');
      this.stopTicks.set(this.computeStopTicks());
    });

    this.autosaveCurrent();
  }

  private nearestCoordIndex(p: L.LatLng): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.routeCoords.length; i++) {
      const d = this.routeCoords[i].distanceTo(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private clearRouteState(): void {
    this.routeCoords = [];
    this.legGeometries = [];
    this.legModeIds = [];
    this.hasRoute.set(false);
    this.distance.set(0);
    this.duration.set(0);
    this.legs.set([]);
    this.progress.set(0);
    this.travelled.set(0);
    this.caption.set('');
    this.error.set(null);
    this.stopTicks.set([]);
  }

  // --- Playback ---------------------------------------------------------

  private resetPlayback(): void {
    this.animator?.destroy();
    this.animator = null;
    this.travelMarker?.remove();
    this.travelMarker = null;
    this.playing.set(false);
  }

  private travelIcon(modeId: string): L.DivIcon {
    const mode = TRAVEL_MODES.find((m) => m.id === modeId) ?? this.mode();
    return L.divIcon({
      className: '',
      html: `<div class="travel-marker">${mode.icon}</div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
    });
  }

  private onAnimationFrame(f: AnimatorFrame): void {
    // Runs outside Angular — touch the map directly, push UI state sparingly.
    this.travelMarker?.setLatLng(f.position);

    // Swap the marker icon when the journey enters a leg with another mode.
    if (this.legModeIds.length && this.travelMarker) {
      const leg = Math.min(f.lastWaypoint, this.legModeIds.length - 1);
      const modeId = this.legModeIds[leg] ?? this.mode().id;
      if (modeId !== this.markerModeId) {
        this.markerModeId = modeId;
        this.travelMarker.setIcon(this.travelIcon(modeId));
      }
    }

    if (this.follow() && !f.finished) {
      this.map.panTo(f.position, { animate: false });
    }

    const now = performance.now();
    if (f.finished || now - this.lastUiPush > 120) {
      this.lastUiPush = now;
      this.push(() => {
        this.progress.set(f.progress);
        this.travelled.set(f.travelled);
        this.caption.set(this.captionFor(f));
        if (f.finished) this.playing.set(false);
      });
    }
  }

  private captionFor(f: AnimatorFrame): string {
    const n = this.waypointIndices.length;
    if (f.finished) return 'Arrived at the finish';
    if (f.lastWaypoint === 0) {
      return n > 2 ? 'Leg 1 — heading to stop 1' : 'On the way to the finish';
    }
    if (f.lastWaypoint >= n - 1) return 'Arrived at the finish';
    const next = f.lastWaypoint + 1 === n - 1 ? 'the finish' : `stop ${f.lastWaypoint + 1}`;
    return `Passed stop ${f.lastWaypoint} — next up: ${next}`;
  }

  private computeStopTicks(): number[] {
    if (!this.routeCoords.length || this.waypointIndices.length <= 2) return [];
    const total = this.animator?.totalDistance ?? 0;
    if (!total) return [];
    let acc = 0;
    const cum: number[] = [0];
    for (let i = 1; i < this.routeCoords.length; i++) {
      acc += this.routeCoords[i - 1].distanceTo(this.routeCoords[i]);
      cum.push(acc);
    }
    return this.waypointIndices
      .slice(1, -1)
      .map((idx) => (cum[Math.min(idx, cum.length - 1)] / total) * 100);
  }

  /** Re-enters the Angular zone so signal writes trigger change detection. */
  private push(fn: () => void): void {
    this.zone.run(fn);
  }
}
