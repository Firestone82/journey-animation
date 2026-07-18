import * as L from 'leaflet';

/**
 * Answers "which leg is the cursor near?" without putting interactive
 * layers over the route line (which would break LRM's drag-to-add-a-stop).
 * Legs are projected to absolute pixel space per zoom level and cached;
 * hit testing is a point-to-segment distance scan over a decimated polyline.
 */
export class LegHitTester {
  private legs: L.LatLng[][] = [];
  private projected: L.Point[][] = [];
  private cachedZoom = -1;

  constructor(private readonly map: L.Map) {}

  setLegs(legs: L.LatLng[][]): void {
    this.legs = legs;
    this.cachedZoom = -1;
  }

  legAt(latlng: L.LatLng, thresholdPx = 12): number | null {
    if (!this.legs.length) return null;
    const zoom = this.map.getZoom();
    if (zoom !== this.cachedZoom) {
      this.projected = this.legs.map((coords) => {
        const stride = Math.max(1, Math.ceil(coords.length / 150));
        const pts: L.Point[] = [];
        for (let i = 0; i < coords.length; i += stride) {
          pts.push(this.map.project(coords[i], zoom));
        }
        const last = coords[coords.length - 1];
        pts.push(this.map.project(last, zoom));
        return pts;
      });
      this.cachedZoom = zoom;
    }

    const p = this.map.project(latlng, zoom);
    for (let leg = 0; leg < this.projected.length; leg++) {
      const pts = this.projected[leg];
      for (let i = 1; i < pts.length; i++) {
        if (L.LineUtil.pointToSegmentDistance(p, pts[i - 1], pts[i]) <= thresholdPx) {
          return leg;
        }
      }
    }
    return null;
  }
}
