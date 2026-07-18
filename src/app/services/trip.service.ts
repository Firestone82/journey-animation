import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import * as L from 'leaflet';
import 'leaflet-routing-machine';

import { TRAVEL_MODES, TravelMode } from '../core/travel-modes';
import { RouteAnimator, AnimatorFrame } from '../core/route-animator';
import { LegRoute, LegRouter, RoutedLeg } from '../core/leg-router';
import { JourneySnapshot, parseSnapshot } from '../core/journey';
import { LegHitTester } from '../core/leg-hit-tester';
import { elevationChunks, hasElevationData } from '../core/elevation';
import { ContextMenuService, MenuEntry } from './context-menu.service';

/** LRM's runtime route object carries more than the published IRoute type. */
interface RouteResult extends L.Routing.IRoute {
  inputWaypoints?: L.Routing.Waypoint[];
}

export type CameraMode = 'off' | 'follow' | 'cinematic';

/** The in-progress journey survives reloads via this key. */
const CURRENT_KEY = 'route-reel:current';

/** Per-leg playback-speed choices offered in the leg context menu. */
export const LEG_SPEED_CHOICES = [0.5, 0.75, 1.25, 1.5, 2];

/** Full editor state captured for undo/redo (unlike JourneySnapshot it may
 *  hold fewer than 2 waypoints). */
interface EditorState {
  modeId: string;
  waypoints: { lat: number; lng: number }[];
  legModes: Record<number, string>;
  legSpeeds: Record<number, number>;
}

/**
 * Owns all trip state and the Leaflet routing/playback machinery.
 * Components stay thin: they render the signals and call the commands below.
 */
@Injectable({ providedIn: 'root' })
export class TripService {
  private readonly zone = inject(NgZone);
  private readonly menu = inject(ContextMenuService);

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
  /** Per-leg playback-speed multipliers; absent legs use the trip speed. */
  readonly legSpeeds = signal<Record<number, number>>({});
  /** Leg the cursor is over (map or route browser), for highlighting. */
  readonly hoveredLeg = signal<number | null>(null);

  readonly playing = signal(false);
  readonly progress = signal(0); // 0..1
  readonly travelled = signal(0); // metres
  readonly caption = signal('');
  readonly camera = signal<CameraMode>('cinematic');
  readonly speed = signal(1);
  readonly stopTicks = signal<number[]>([]);
  /** Cinematic tilt is applied only while actually playing. */
  readonly tilted = computed(() => this.playing() && this.camera() === 'cinematic');

  /** Elevation colouring (green descents / red climbs). */
  readonly showElevation = signal(false);
  readonly hasElevation = signal(false);

  readonly canUndo = signal(false);
  readonly canRedo = signal(false);

  // --- Leaflet internals ------------------------------------------------
  private map!: L.Map;
  private plan!: L.Routing.Plan;
  private control!: L.Routing.Control;
  private travelMarker: L.Marker | null = null;
  private markerModeId = '';
  private hitTester: LegHitTester | null = null;
  private highlightLine: L.Polyline | null = null;
  private elevationLayer: L.LayerGroup | null = null;
  private lastHoverCheck = 0;

  /** In-progress drag from the route line (inserts a stop on release). */
  private lineDrag: {
    legIndex: number;
    startPoint: L.Point;
    latlng: L.LatLng;
    started: boolean;
    ghost: L.Marker | null;
  } | null = null;
  private suppressNextClick = false;

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

  // --- Undo/redo --------------------------------------------------------
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private present = '';
  private restoring = false;

  // --- Map wiring (called once by RouteMapComponent) --------------------

  attachMap(container: HTMLElement): void {
    this.zone.runOutsideAngular(() => this.initMap(container));
    this.present = this.serializeState();
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

    this.hitTester = new LegHitTester(this.map);

    this.plan = L.Routing.plan([], {
      draggableWaypoints: true,
      addWaypoints: true,
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
          // LRM would insert a stop on a mere line *click*; the drag-to-insert
          // below (onLineMouseDown & friends) replaces it with drag-only.
          addWaypoints: false,
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

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      if (this.suppressNextClick) return;
      this.appendWaypoint(e.latlng);
    });
    this.map.on('contextmenu', (e: L.LeafletMouseEvent) => this.onMapContextMenu(e));
    this.map.on('mousedown', (e: L.LeafletMouseEvent) => this.onLineMouseDown(e));
    this.map.on('mousemove', (e: L.LeafletMouseEvent) => this.onMapHover(e));

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
        this.trimLegOverrides();
        if (this.waypointCount() < 2) this.clearRouteState();
        this.recordState();
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
    this.recordState();
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
    this.recordState();
    this.reroute();
  }

  /** Playback speed multiplier for one leg; `null` returns to trip speed. */
  setLegSpeed(legIndex: number, factor: number | null): void {
    const current = this.legSpeeds();
    if ((current[legIndex] ?? null) === factor) return;
    const next = { ...current };
    if (factor === null) delete next[legIndex];
    else next[legIndex] = factor;
    this.legSpeeds.set(next);
    this.rebuildAnimator();
    this.recordState();
    this.autosaveCurrent();
  }

  setCamera(mode: CameraMode): void {
    this.camera.set(mode);
  }

  toggleElevation(): void {
    this.showElevation.set(!this.showElevation());
    this.zone.runOutsideAngular(() => this.rebuildElevationLayer());
  }

  clearAll(): void {
    this.resetPlayback();
    this.legModes.set({});
    this.legSpeeds.set({});
    this.zone.runOutsideAngular(() => this.plan.setWaypoints([]));
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

  /** Zooms the map to one leg (used by the route browser). */
  focusLeg(legIndex: number): void {
    const coords = this.legGeometries[legIndex];
    if (!coords?.length) return;
    this.zone.runOutsideAngular(() =>
      this.map.fitBounds(L.latLngBounds(coords), { padding: [64, 64] }),
    );
  }

  zoomToRoute(): void {
    if (!this.routeCoords.length) return;
    this.zone.runOutsideAngular(() =>
      this.map.fitBounds(L.latLngBounds(this.routeCoords), { padding: [48, 48] }),
    );
  }

  /** Highlights one leg on the map (route-browser rows call this on hover). */
  highlightLeg(legIndex: number | null): void {
    this.hoveredLeg.set(legIndex);
    this.zone.runOutsideAngular(() => this.setHighlightLine(legIndex));
  }

  // --- Waypoint commands (context menus, route browser) -----------------

  addStopAt(latlng: L.LatLng): void {
    this.zone.runOutsideAngular(() => this.appendWaypoint(latlng));
  }

  setStartAt(latlng: L.LatLng): void {
    this.resetPlayback();
    this.zone.runOutsideAngular(() => {
      if (this.placedWaypoints().length >= 1) {
        this.plan.spliceWaypoints(0, 1, L.Routing.waypoint(latlng));
      } else {
        this.appendWaypoint(latlng);
      }
    });
  }

  setFinishAt(latlng: L.LatLng): void {
    this.resetPlayback();
    this.zone.runOutsideAngular(() => {
      const wps = this.placedWaypoints();
      if (wps.length >= 2) {
        this.plan.spliceWaypoints(wps.length - 1, 1, L.Routing.waypoint(latlng));
      } else {
        this.appendWaypoint(latlng);
      }
    });
  }

  /** Appends a final waypoint at the start position — a round trip. */
  closeLoop(): void {
    const wps = this.placedWaypoints();
    if (wps.length < 2 || this.isLoopClosed()) return;
    this.resetPlayback();
    this.zone.runOutsideAngular(() => this.appendWaypoint(wps[0].latLng));
  }

  isLoopClosed(): boolean {
    const wps = this.placedWaypoints();
    return wps.length >= 2 && wps[0].latLng.equals(wps[wps.length - 1].latLng);
  }

  /** Swaps a waypoint with its neighbour (delta -1 = earlier, +1 = later). */
  moveWaypoint(index: number, delta: -1 | 1): void {
    const wps = this.placedWaypoints();
    const j = index + delta;
    if (index < 0 || j < 0 || index >= wps.length || j >= wps.length) return;
    const next = [...wps];
    [next[index], next[j]] = [next[j], next[index]];
    this.resetPlayback();
    this.zone.runOutsideAngular(() => this.plan.setWaypoints(next));
  }

  removeWaypoint(index: number): void {
    this.resetPlayback();
    this.zone.runOutsideAngular(() => this.plan.spliceWaypoints(index, 1));
  }

  // --- Undo / redo ------------------------------------------------------

  undo(): void {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(this.present);
    this.present = prev;
    this.applyState(prev);
    this.syncHistorySignals();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.present);
    this.present = next;
    this.applyState(next);
    this.syncHistorySignals();
  }

  private serializeState(): string {
    const state: EditorState = {
      modeId: this.mode().id,
      waypoints: this.plan
        ? this.placedWaypoints().map((w) => ({ lat: w.latLng.lat, lng: w.latLng.lng }))
        : [],
      legModes: this.legModes(),
      legSpeeds: this.legSpeeds(),
    };
    return JSON.stringify(state);
  }

  private recordState(): void {
    if (this.restoring) return;
    const s = this.serializeState();
    if (s === this.present) return;
    this.undoStack.push(this.present);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.present = s;
    this.redoStack = [];
    this.syncHistorySignals();
  }

  private applyState(serialized: string): void {
    const state = JSON.parse(serialized) as EditorState;
    const mode = TRAVEL_MODES.find((m) => m.id === state.modeId) ?? TRAVEL_MODES[0];
    this.restoring = true;
    try {
      this.mode.set(mode);
      this.legModes.set(state.legModes ?? {});
      this.legSpeeds.set(state.legSpeeds ?? {});
      this.resetPlayback();
      this.zone.runOutsideAngular(() =>
        this.plan.setWaypoints(
          state.waypoints.map((p) => L.Routing.waypoint(L.latLng(p.lat, p.lng))),
        ),
      );
      if (state.waypoints.length < 2) this.clearRouteState();
    } finally {
      this.restoring = false;
    }
  }

  private syncHistorySignals(): void {
    this.canUndo.set(this.undoStack.length > 0);
    this.canRedo.set(this.redoStack.length > 0);
  }

  // --- Context menus ----------------------------------------------------

  pinLabel(index: number): string {
    const n = Math.max(this.waypointCount(), 2);
    return index === 0 ? 'A' : index === n - 1 ? 'B' : String(index);
  }

  openPinMenu(index: number, x: number, y: number): void {
    const n = this.waypointCount();
    const title = index === 0 ? 'Start' : index === n - 1 ? 'Finish' : `Stop ${index}`;
    const entries: MenuEntry[] = [{ kind: 'header', label: `${title} (${this.pinLabel(index)})` }];
    if (index === 0) {
      entries.push({
        kind: 'item',
        icon: '🏁',
        label: 'Finish trip here (close the loop)',
        disabled: n < 2 || this.isLoopClosed(),
        action: () => this.closeLoop(),
      });
    }
    entries.push(
      {
        kind: 'item',
        icon: '⬆',
        label: 'Move earlier',
        disabled: index === 0,
        action: () => this.moveWaypoint(index, -1),
      },
      {
        kind: 'item',
        icon: '⬇',
        label: 'Move later',
        disabled: index === n - 1,
        action: () => this.moveWaypoint(index, 1),
      },
      { kind: 'sep' },
      {
        kind: 'item',
        icon: '✕',
        label: 'Remove point',
        danger: true,
        action: () => this.removeWaypoint(index),
      },
    );
    this.menu.open(x, y, entries);
  }

  openLegMenu(legIndex: number, x: number, y: number): void {
    const override = this.legModes()[legIndex] as string | undefined;
    const speedOverride = this.legSpeeds()[legIndex] as number | undefined;
    const entries: MenuEntry[] = [
      {
        kind: 'header',
        label: `Leg ${this.pinLabel(legIndex)} → ${this.pinLabel(legIndex + 1)}`,
      },
      { kind: 'header', label: 'Travel mode' },
      {
        kind: 'item',
        label: `Trip mode (${this.mode().label})`,
        checked: !override,
        action: () => this.setLegMode(legIndex, null),
      },
      ...TRAVEL_MODES.map<MenuEntry>((m) => ({
        kind: 'item',
        icon: m.icon,
        label: m.label,
        checked: override === m.id,
        action: () => this.setLegMode(legIndex, m.id),
      })),
      { kind: 'header', label: 'Playback speed' },
      {
        kind: 'item',
        label: 'Trip speed (1×)',
        checked: speedOverride === undefined,
        action: () => this.setLegSpeed(legIndex, null),
      },
      ...LEG_SPEED_CHOICES.map<MenuEntry>((f) => ({
        kind: 'item',
        label: `${f}×`,
        checked: speedOverride === f,
        action: () => this.setLegSpeed(legIndex, f),
      })),
      { kind: 'sep' },
      {
        kind: 'item',
        icon: '🔍',
        label: 'Zoom to this leg',
        action: () => this.focusLeg(legIndex),
      },
    ];
    this.menu.open(x, y, entries);
  }

  private openMapMenu(x: number, y: number, latlng: L.LatLng): void {
    const n = this.waypointCount();
    const entries: MenuEntry[] = [
      { kind: 'item', icon: '📍', label: 'Add stop here', action: () => this.addStopAt(latlng) },
      { kind: 'item', icon: '🟢', label: 'Set start here', action: () => this.setStartAt(latlng) },
      {
        kind: 'item',
        icon: '🏁',
        label: 'Set finish here',
        disabled: n === 0,
        action: () => this.setFinishAt(latlng),
      },
      { kind: 'sep' },
      {
        kind: 'item',
        icon: '🔁',
        label: 'Finish at the start (loop)',
        disabled: n < 2 || this.isLoopClosed(),
        action: () => this.closeLoop(),
      },
      {
        kind: 'item',
        icon: '🔍',
        label: 'Zoom to route',
        disabled: !this.hasRoute(),
        action: () => this.zoomToRoute(),
      },
      { kind: 'sep' },
      { kind: 'item', icon: '↶', label: 'Undo', disabled: !this.canUndo(), action: () => this.undo() },
      { kind: 'item', icon: '↷', label: 'Redo', disabled: !this.canRedo(), action: () => this.redo() },
      {
        kind: 'item',
        icon: '🗑',
        label: 'Clear route',
        danger: true,
        disabled: n === 0,
        action: () => this.clearAll(),
      },
    ];
    this.menu.open(x, y, entries);
  }

  private onMapContextMenu(e: L.LeafletMouseEvent): void {
    const oe = e.originalEvent;
    oe.preventDefault();
    const leg = this.hitTester?.legAt(e.latlng) ?? null;
    this.push(() => {
      if (leg !== null) this.openLegMenu(leg, oe.clientX, oe.clientY);
      else this.openMapMenu(oe.clientX, oe.clientY, e.latlng);
    });
  }

  // --- Drag a stop out of the route line --------------------------------

  private onLineMouseDown(e: L.LeafletMouseEvent): void {
    if (e.originalEvent.button !== 0 || this.lineDrag) return;
    const legIndex = this.hitTester?.legAt(e.latlng);
    if (legIndex === null || legIndex === undefined) return;
    // Claim the gesture: no map pan while pulling a new stop off the line.
    this.map.dragging.disable();
    this.lineDrag = {
      legIndex,
      startPoint: e.containerPoint,
      latlng: e.latlng,
      started: false,
      ghost: null,
    };
    window.addEventListener('mouseup', this.onLineMouseUp);
  }

  private onLineDragMove(e: L.LeafletMouseEvent): void {
    const drag = this.lineDrag!;
    drag.latlng = e.latlng;
    if (!drag.started) {
      if (e.containerPoint.distanceTo(drag.startPoint) < 6) return;
      drag.started = true;
      drag.ghost = L.marker(e.latlng, {
        interactive: false,
        zIndexOffset: 1000,
        icon: L.divIcon({
          className: '',
          html: `<div class="wp-pin wp-via wp-ghost">+</div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 36],
        }),
      }).addTo(this.map);
    }
    drag.ghost?.setLatLng(e.latlng);
  }

  private readonly onLineMouseUp = (): void => {
    window.removeEventListener('mouseup', this.onLineMouseUp);
    const drag = this.lineDrag;
    if (!drag) return;
    this.lineDrag = null;
    this.map.dragging.enable();
    drag.ghost?.remove();
    // Swallow the click Leaflet synthesises right after this mouseup, so a
    // plain click on the line no longer drops a waypoint at the route's end.
    this.suppressNextClick = true;
    setTimeout(() => (this.suppressNextClick = false));
    if (!drag.started) return;
    this.resetPlayback();
    this.plan.spliceWaypoints(drag.legIndex + 1, 0, L.Routing.waypoint(drag.latlng));
  };

  // --- Hover highlight --------------------------------------------------

  private onMapHover(e: L.LeafletMouseEvent): void {
    if (this.lineDrag) {
      this.onLineDragMove(e);
      return;
    }
    const now = performance.now();
    if (now - this.lastHoverCheck < 60) return;
    this.lastHoverCheck = now;
    const leg = this.hitTester?.legAt(e.latlng) ?? null;
    if (leg === this.hoveredLeg()) return;
    this.map.getContainer().style.cursor = leg !== null ? 'pointer' : '';
    this.setHighlightLine(leg);
    this.push(() => this.hoveredLeg.set(leg));
  }

  private setHighlightLine(legIndex: number | null): void {
    this.highlightLine?.remove();
    this.highlightLine = null;
    if (legIndex === null || !this.legGeometries[legIndex]?.length) return;
    this.highlightLine = L.polyline(this.legGeometries[legIndex], {
      className: 'route-highlight',
      color: '#5ec9ff',
      weight: 7,
      opacity: 1,
      interactive: false,
    }).addTo(this.map);
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
      legSpeeds: { ...this.legSpeeds() },
    };
  }

  loadJourney(journey: JourneySnapshot): void {
    const mode = TRAVEL_MODES.find((m) => m.id === journey.modeId) ?? TRAVEL_MODES[0];
    this.mode.set(mode);
    this.legModes.set({ ...(journey.legModes ?? {}) });
    this.legSpeeds.set({ ...(journey.legSpeeds ?? {}) });
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
        // The teardrop's tip sits ~21px below the box centre (30×30 square
        // rotated 45°) — anchor there so the pin points at its spot.
        iconAnchor: [15, 36],
      }),
    });

    // Left and right click both open the pin menu (which offers closing the
    // loop from the start pin, reordering and removal).
    const openMenu = (ev: L.LeafletMouseEvent) => {
      const oe = ev.originalEvent;
      oe.preventDefault();
      this.push(() => this.openPinMenu(i, oe.clientX, oe.clientY));
    };
    marker.on('click', openMenu);
    marker.on('contextmenu', openMenu);
    return marker;
  }

  private trimLegOverrides(): void {
    const legCount = Math.max(0, this.placedWaypoints().length - 1);
    const trim = <T>(record: Record<number, T>): Record<number, T> | null => {
      const stale = Object.keys(record).filter((k) => Number(k) >= legCount);
      if (!stale.length) return null;
      const next = { ...record };
      for (const k of stale) delete next[Number(k)];
      return next;
    };
    const modes = trim(this.legModes());
    if (modes) this.legModes.set(modes);
    const speeds = trim(this.legSpeeds());
    if (speeds) this.legSpeeds.set(speeds);
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
    this.hitTester?.setLegs(this.legGeometries);
    this.setHighlightLine(null);

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
    this.animator = this.buildAnimator();

    // Rebuild decoration layers after LRM has (re)drawn its line so they
    // stay stacked above it.
    setTimeout(() => this.rebuildElevationLayer());

    this.push(() => {
      this.routing.set(false);
      this.error.set(null);
      this.hasRoute.set(this.routeCoords.length > 1);
      this.distance.set(dist);
      this.duration.set(time);
      this.legs.set(legs);
      this.hasElevation.set(hasElevationData(this.routeCoords));
      this.hoveredLeg.set(null);
      this.progress.set(0);
      this.travelled.set(0);
      this.caption.set('');
      this.stopTicks.set(this.computeStopTicks());
    });

    this.autosaveCurrent();
  }

  private buildAnimator(): RouteAnimator {
    return new RouteAnimator(
      this.routeCoords,
      this.waypointIndices,
      (f) => this.onAnimationFrame(f),
      { legSpeedFactor: (leg) => this.legSpeeds()[leg] ?? 1 },
    );
  }

  private rebuildAnimator(): void {
    if (!this.routeCoords.length) return;
    this.resetPlayback();
    this.animator = this.buildAnimator();
    this.progress.set(0);
    this.travelled.set(0);
    this.caption.set('');
    this.stopTicks.set(this.computeStopTicks());
  }

  private rebuildElevationLayer(): void {
    this.elevationLayer?.remove();
    this.elevationLayer = null;
    if (!this.showElevation() || !this.hasElevation() || !this.routeCoords.length) {
      return;
    }
    const lines = elevationChunks(this.routeCoords).map((chunk) =>
      L.polyline(chunk.coords, {
        color: chunk.color,
        weight: 5,
        opacity: 1,
        interactive: false,
      }),
    );
    this.elevationLayer = L.layerGroup(lines).addTo(this.map);
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
    this.hitTester?.setLegs([]);
    this.zone.runOutsideAngular(() => {
      this.setHighlightLine(null);
      this.elevationLayer?.remove();
      this.elevationLayer = null;
    });
    this.hasRoute.set(false);
    this.distance.set(0);
    this.duration.set(0);
    this.legs.set([]);
    this.hoveredLeg.set(null);
    this.hasElevation.set(false);
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

    if (!f.finished) {
      const cam = this.camera();
      if (cam === 'follow') {
        this.map.panTo(f.position, { animate: false });
      } else if (cam === 'cinematic') {
        this.cinematicPan(f.position);
      }
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

  /**
   * Keeps the rider in view without hard-centering: inside a generous dead
   * zone the camera doesn't move at all; outside it, it eases gently toward
   * the rider. No sudden centering — no motion sickness.
   */
  private cinematicPan(position: L.LatLng): void {
    const size = this.map.getSize();
    const p = this.map.latLngToContainerPoint(position);
    const dx = p.x - size.x / 2;
    const dy = p.y - size.y / 2;
    const deadX = size.x * 0.18;
    const deadY = size.y * 0.18;
    const ex = Math.abs(dx) > deadX ? dx - Math.sign(dx) * deadX : 0;
    const ey = Math.abs(dy) > deadY ? dy - Math.sign(dy) * deadY : 0;
    if (ex || ey) {
      this.map.panBy([ex * 0.06, ey * 0.06], { animate: false });
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
    if (!this.animator || this.waypointIndices.length <= 2) return [];
    const animator = this.animator;
    return this.waypointIndices
      .slice(1, -1)
      .map((idx) => animator.progressAt(idx) * 100);
  }

  /** Re-enters the Angular zone so signal writes trigger change detection. */
  private push(fn: () => void): void {
    this.zone.run(fn);
  }
}
