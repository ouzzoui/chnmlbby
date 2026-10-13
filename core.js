// ---------------------------------------------------------------------------
// Pattern-brush engine for the bead tile exported from Illustrator
// (assets/bead.svg).
//
// How Illustrator does it: a pattern brush repeats a "side tile" along the
// path, and the artwork stretches and deforms to follow the shape of the path
// — not a rigid copy rotated at a single point.
//
// We reproduce that by warping the tile's vector outlines. The SVG is sampled
// once into polygons (via the browser's own path geometry API, so whatever you
// re-export from Illustrator just works), then every vertex is mapped through
// an arc-length frame on the drawn path: the vertex's local x becomes a
// distance along the path, and its local y becomes an offset along the normal
// there. Each bead is filled as one continuous polygon, so there are no strips
// and therefore no seams — an earlier version sliced a bitmap into strips and
// the strips fanned apart on curves, leaving visible notches and hairlines.
// ---------------------------------------------------------------------------

const SAMPLES_PER_SHAPE = 220;

// Loading a tile yields a value rather than mutating globals, so a page can
// use more than one artwork at a time.
// Needs to be served over http(s) — a file:// page can't fetch the SVG.
async function loadTile(url) {
  const res = await fetch(url);
  const markup = await res.text();
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");

  // The geometry APIs only work on a rendered element, so mount a clipped copy.
  const host = document.createElement("div");
  host.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  const svg = document.importNode(parsed.documentElement, true);
  const box = svg.viewBox.baseVal;
  const viewBox = { w: box.width, h: box.height };
  svg.setAttribute("width", box.width);
  svg.setAttribute("height", box.height);
  host.appendChild(svg);
  document.body.appendChild(host);

  const rootCTM = svg.getScreenCTM();
  const shapes = [];
  for (const el of svg.querySelectorAll("path, rect, circle, ellipse, polygon, polyline")) {
    const fill = getComputedStyle(el).fill;
    if (!fill || fill === "none") continue;
    if (typeof el.getTotalLength !== "function") continue;

    // Element-local coords to viewBox coords, so element/group transforms apply.
    const elCTM = el.getScreenCTM();
    const m =
      rootCTM && elCTM
        ? rootCTM.inverse().multiply(elCTM)
        : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const len = el.getTotalLength();
    if (!len) continue;
    const pts = [];
    let maxX = 0;
    for (let i = 0; i <= SAMPLES_PER_SHAPE; i++) {
      const p = el.getPointAtLength((len * i) / SAMPLES_PER_SHAPE);
      const x = m.a * p.x + m.c * p.y + m.e;
      const y = m.b * p.x + m.d * p.y + m.f;
      pts.push({ x, y });
      if (x > maxX) maxX = x;
    }
    shapes.push({ fill, pts, maxX });
  }
  // document order == paint order, same as Illustrator
  return { viewBox, shapes };
}

// A growing polyline that answers "where is arc length s, and which way is the
// path heading there" — the arc-length parameterization the warp needs.
const PATH_SMOOTHING = 0.35; // lower = smoother, but the chain lags the cursor more
const MIN_POINT_SPACING = 1.5;

class PathTracker {
  // smooth: true for live pointer input, false for a pre-authored curve whose
  // points are already clean (easing those would round off the shape).
  constructor({ smooth = true } = {}) {
    this.smooth = smooth;
    this.pts = [];
    this.cum = [];
    this.sx = 0;
    this.sy = 0;
  }
  addPoint(x, y) {
    const n = this.pts.length;
    if (n === 0) {
      this.sx = x;
      this.sy = y;
      this.cum.push(0);
      this.pts.push({ x, y });
      return;
    }
    if (this.smooth) {
      // Ease toward the raw cursor rather than recording it verbatim, so hand
      // jitter doesn't show up as kinks in the bead outlines.
      this.sx += (x - this.sx) * PATH_SMOOTHING;
      this.sy += (y - this.sy) * PATH_SMOOTHING;
    } else {
      this.sx = x;
      this.sy = y;
    }
    const prev = this.pts[n - 1];
    const d = Math.hypot(this.sx - prev.x, this.sy - prev.y);
    if (this.smooth && d < MIN_POINT_SPACING) return;
    if (d <= 0) return;
    this.cum.push(this.cum[n - 1] + d);
    this.pts.push({ x: this.sx, y: this.sy });
  }
  get totalLength() {
    return this.cum.length ? this.cum[this.cum.length - 1] : 0;
  }
  pointAt(s) {
    const n = this.pts.length;
    if (n < 2 || s < 0 || s > this.totalLength) return null;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo);
    const a = this.pts[i - 1];
    const b = this.pts[i];
    const segLen = this.cum[i] - this.cum[i - 1] || 1;
    const t = (s - this.cum[i - 1]) / segLen;
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }
}

// Smooths the tangent by averaging the path direction over a window either
// side of s, so hand jitter doesn't make the beads wobble.
function smoothedFrame(path, s, window) {
  const a = path.pointAt(Math.max(0, s - window));
  const b = path.pointAt(Math.min(path.totalLength, s + window));
  const here = path.pointAt(s);
  if (!here) return null;
  if (!a || !b) return here;
  return { x: here.x, y: here.y, angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

// Draws one tile repeat starting at arc length uStart, warped onto the path.
// Shapes whose far end runs past limitU are skipped, which is how the tip of
// the chain grows a bead at a time instead of popping in a whole repeat.
function renderTile(tile, path, uStart, tileLengthPx, target, limitU) {
  if (!tile) return;
  const g = target || window; // in global mode p5 puts its drawing API on window
  const scale = tileLengthPx / tile.viewBox.w;
  const halfH = tile.viewBox.h / 2;
  const smoothing = tileLengthPx * 0.12;

  for (const shape of tile.shapes) {
    if (limitU != null && uStart + shape.maxX * scale > limitU) continue;
    g.push();
    g.noStroke();
    g.fill(shape.fill);
    g.beginShape();
    for (const pt of shape.pts) {
      const frame = smoothedFrame(path, uStart + pt.x * scale, smoothing);
      if (!frame) continue;
      const offset = (pt.y - halfH) * scale;
      g.vertex(
        frame.x - Math.sin(frame.angle) * offset,
        frame.y + Math.cos(frame.angle) * offset
      );
    }
    g.endShape(CLOSE);
    g.pop();
  }
}

// Feeds pointer movement into a PathTracker and bakes each tile repeat once
// the path has run far enough to carry the whole repeat.
class ChainStamper {
  constructor({ tile, tileLengthPx, overlap, onBakeRepeat }) {
    this.tile = tile;
    this.tileLengthPx = tileLengthPx;
    this.overlap = overlap;
    this.onBakeRepeat = onBakeRepeat;
    this.path = new PathTracker();
    this.nextRepeatAt = 0;
  }
  reset() {
    this.path = new PathTracker();
    this.nextRepeatAt = 0;
  }
  moveTo(x, y) {
    this.path.addPoint(x, y);
    while (this.nextRepeatAt + this.tileLengthPx <= this.path.totalLength) {
      this.onBakeRepeat(this.nextRepeatAt, this.path);
      this.nextRepeatAt += this.tileLengthPx * this.overlap;
    }
  }
}
