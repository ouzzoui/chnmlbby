// ---------------------------------------------------------------------------
// v2 loading screen: a bead curtain. Strands of the bead tile hang from above
// the viewport, and the pointer parts them as it moves through — each strand
// is a verlet rope, and the tile is warped along it with the same
// "vertex x -> distance along the path, vertex y -> offset along the normal"
// mapping core.js uses for the pointer-drawn chain in v1.
//
// After LOAD_MS (and once the page and ASSET_URLS have loaded) the curtain
// parts down the middle: each half's rail slides off its side of the screen
// and the strands trail after it under the same physics. The % counter runs
// off the same clock. No p5 here — plain canvas,
// so the physics and drawing share one requestAnimationFrame loop.
// ---------------------------------------------------------------------------

(() => {
  const ASSET_URLS = [
    // "assets/cd-sleeve.png",
  ];
  const LOAD_MS = 3000; // the curtain parts at this mark

  const TILE_PX = 66; // one repeat of the bead tile along a strand
  const OVERLAP = 0.97;
  const STRAND_GAP = 26; // px between strands
  const LINK_PX = 11; // rope particle spacing
  const SHAPE_POINTS = 48; // per bead outline — plenty at this size

  const STEP = 1 / 120; // fixed physics timestep
  const GRAVITY = 2400;
  const DAMPING = 0.988; // per step; lower = beads settle faster
  const ITERATIONS = 16; // constraint passes per step; fewer lets strands stretch
  const HAND_R = 34; // how wide a path the pointer clears
  const HAND_PUSH = 0.03; // sideways nudge, share of the overlap per step
  const HAND_DRAG = 0.3; // how fast beads take on the pointer's velocity
  const BREEZE = 14; // idle sway, px/s²

  const PART_MS = 1800; // from the first strand moving to the last one stopping
  const PART_LEAD = 0.4; // share of PART_MS the middle strands start ahead of the edges
  const PART_MARGIN = 90; // how far past the edge the bunched rails stop
  const PART_BUNCH = 0.15; // spacing left between strands once bunched
  const PART_TIMEOUT = 2200; // after PART_MS, stragglers fade rather than wait

  const loaderEl = document.getElementById("loader");
  const uiEl = document.getElementById("loader-ui");
  const pctEl = document.getElementById("loader-pct");
  const canvas = document.createElement("canvas");
  loaderEl.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  let W = 0;
  let H = 0;
  let dpr = 1;
  let tile = null;
  let strands = [];
  let rafId = 0;
  let ready = false;
  let partedAt = null; // when the curtain began to part
  let done = false;
  const startedAt = performance.now();

  // The pointer, as of now and as of the last physics step; the segment
  // between them is swept so a fast flick can't tunnel through a strand.
  let hand = null;
  let handPrev = null;

  // ---- tile ----------------------------------------------------------------

  // loadTile samples each outline densely for v1's big brush strokes; dozens
  // of strands redrawn every frame want far fewer vertices.
  // Bead colour schemes, picked with ?beads=1 or ?beads=2 (default 2).
  // 1 is bead.svg as drawn: black beads (#231f20) and white tubes (#e5e5e5).
  // 2 recolours those to wood. bead.svg itself is shared with v1, so it stays.
  const SCHEMES = {
    1: {},
    2: {
      "rgb(35, 31, 32)": "#5a3720", // chocolate wood
      "rgb(229, 229, 229)": "#d6c4a8", // tan wood
    },
  };
  const RECOLOR =
    SCHEMES[new URLSearchParams(location.search).get("beads")] || SCHEMES[2];

  function lighten(t) {
    return {
      viewBox: t.viewBox,
      shapes: t.shapes.map((s) => {
        const every = Math.max(1, Math.round(s.pts.length / SHAPE_POINTS));
        const fill = RECOLOR[s.fill] || s.fill;
        return { fill, pts: s.pts.filter((_, i) => i % every === 0) };
      }),
    };
  }

  // ---- strands -------------------------------------------------------------

  function build() {
    strands = [];
    const repeat = TILE_PX * OVERLAP;
    const count = Math.ceil(W / STRAND_GAP) + 1;
    const left = (W - (count - 1) * STRAND_GAP) / 2;
    for (let i = 0; i < count; i++) {
      const x = left + i * STRAND_GAP + (Math.random() - 0.5) * 4;
      // Random start above the top edge, so beads don't line up across strands.
      const top = -Math.random() * repeat;
      // Every strand runs a little past the bottom edge.
      const hem = H * (1.04 + Math.random() * 0.06);
      const reps = Math.max(1, Math.round((hem - top - TILE_PX) / repeat) + 1);
      const length = (reps - 1) * repeat + TILE_PX;
      const n = Math.ceil(length / LINK_PX) + 2;
      const xs = new Float32Array(n);
      const ys = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        xs[j] = x;
        ys[j] = top + j * LINK_PX;
      }
      strands.push({
        homeX: x,
        ax: x,
        ay: top,
        reps,
        n,
        xs,
        ys,
        pxs: xs.slice(),
        pys: ys.slice(),
        phase: Math.random() * Math.PI * 2,
        minX: x,
        maxX: x,
      });
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    build();
  }

  // ---- physics -------------------------------------------------------------

  let clock = 0;

  function simulate(dt) {
    clock += dt;
    const g = GRAVITY * dt * dt;

    let hx0, hy0, hx1, hy1, hvx, hvy, hMinX, hMaxX;
    if (hand && handPrev) {
      hx0 = handPrev.x;
      hy0 = handPrev.y;
      hx1 = hand.x;
      hy1 = hand.y;
      hvx = hx1 - hx0;
      hvy = hy1 - hy0;
      hMinX = Math.min(hx0, hx1) - HAND_R;
      hMaxX = Math.max(hx0, hx1) + HAND_R;
    }
    const segLen2 = hand && handPrev ? hvx * hvx + hvy * hvy : 0;

    for (const s of strands) {
      const { xs, ys, pxs, pys, n } = s;
      const breeze = Math.sin(clock * 0.6 + s.phase) * BREEZE * dt * dt;

      // Integrate.
      let minX = Infinity;
      let maxX = -Infinity;
      for (let j = 1; j < n; j++) {
        const vx = (xs[j] - pxs[j]) * DAMPING;
        const vy = (ys[j] - pys[j]) * DAMPING;
        pxs[j] = xs[j];
        pys[j] = ys[j];
        xs[j] += vx + breeze * (j / n);
        ys[j] += vy + g;
        if (xs[j] < minX) minX = xs[j];
        if (xs[j] > maxX) maxX = xs[j];
      }
      s.minX = minX;
      s.maxX = maxX;

      // The hand: beads inside its swept path have their velocity eased
      // toward the hand's, and are nudged sideways off it. Neither is a hard
      // wall, so a strand swings away and falls back rather than draping
      // over the cursor or being bulldozed across the screen.
      if (hand && handPrev && maxX >= hMinX && minX <= hMaxX) {
        for (let j = 1; j < n; j++) {
          let cx = hx0;
          let cy = hy0;
          if (segLen2 > 0) {
            let t = ((xs[j] - hx0) * hvx + (ys[j] - hy0) * hvy) / segLen2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            cx = hx0 + hvx * t;
            cy = hy0 + hvy * t;
          }
          const dx = xs[j] - cx;
          const dy = ys[j] - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= HAND_R * HAND_R) continue;
          const d = Math.sqrt(d2);
          const k = 1 - d / HAND_R;
          const side = dx > 0 ? 1 : dx < 0 ? -1 : j % 2 ? 1 : -1;
          xs[j] += (hvx - (xs[j] - pxs[j])) * HAND_DRAG * k + side * (HAND_R - d) * HAND_PUSH;
          ys[j] += (hvy - (ys[j] - pys[j])) * HAND_DRAG * k * 0.5;
        }
      }

      // Keep links at length, top particle pinned to the rail.
      for (let k = 0; k < ITERATIONS; k++) {
        xs[0] = s.ax;
        ys[0] = s.ay;
        for (let j = 1; j < n; j++) {
          const dx = xs[j] - xs[j - 1];
          const dy = ys[j] - ys[j - 1];
          const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
          const diff = (d - LINK_PX) / d;
          if (j === 1) {
            xs[j] -= dx * diff;
            ys[j] -= dy * diff;
          } else {
            xs[j - 1] += dx * diff * 0.5;
            ys[j - 1] += dy * diff * 0.5;
            xs[j] -= dx * diff * 0.5;
            ys[j] -= dy * diff * 0.5;
          }
        }
      }
    }

    if (hand) handPrev = { x: hand.x, y: hand.y };
  }

  // ---- drawing -------------------------------------------------------------

  // Catmull-Rom through the rope particles, so beads bend smoothly rather
  // than kinking at each link. Writes into F to avoid allocating per vertex.
  const F = { x: 0, y: 0, nx: 0, ny: 0 };
  function frameAt(s, u) {
    const { xs, ys, n } = s;
    let p = u / LINK_PX;
    if (p < 0) p = 0;
    let i = Math.floor(p);
    if (i > n - 2) i = n - 2;
    const t = p - i;
    const i0 = i > 0 ? i - 1 : 0;
    const i3 = i + 2 < n ? i + 2 : n - 1;
    const x0 = xs[i0], x1 = xs[i], x2 = xs[i + 1], x3 = xs[i3];
    const y0 = ys[i0], y1 = ys[i], y2 = ys[i + 1], y3 = ys[i3];
    const t2 = t * t;
    const t3 = t2 * t;
    const ax = 2 * x0 - 5 * x1 + 4 * x2 - x3;
    const bx = -x0 + 3 * x1 - 3 * x2 + x3;
    const ay = 2 * y0 - 5 * y1 + 4 * y2 - y3;
    const by = -y0 + 3 * y1 - 3 * y2 + y3;
    F.x = 0.5 * (2 * x1 + (x2 - x0) * t + ax * t2 + bx * t3);
    F.y = 0.5 * (2 * y1 + (y2 - y0) * t + ay * t2 + by * t3);
    const tx = (x2 - x0) + 2 * ax * t + 3 * bx * t2;
    const ty = (y2 - y0) + 2 * ay * t + 3 * by * t2;
    const m = Math.hypot(tx, ty) || 1;
    F.nx = -ty / m;
    F.ny = tx / m;
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H); // transparent: the site shows through
    if (!tile) return;

    const scale = TILE_PX / tile.viewBox.w;
    const halfH = tile.viewBox.h / 2;
    const repeat = TILE_PX * OVERLAP;
    const reach = (tile.viewBox.h / 2) * scale;

    for (const s of strands) {
      if (s.maxX < -reach || s.minX > W + reach) continue;
      drawStrand(ctx, s, scale, halfH, repeat);
    }
  }

  function drawStrand(g, s, scale, halfH, repeat) {
    for (let r = 0; r < s.reps; r++) {
      const u0 = r * repeat;
      for (const shape of tile.shapes) {
        g.fillStyle = shape.fill;
        g.beginPath();
        const pts = shape.pts;
        for (let k = 0; k < pts.length; k++) {
          const pt = pts[k];
          frameAt(s, u0 + pt.x * scale);
          const off = (pt.y - halfH) * scale;
          const vx = F.x + F.nx * off;
          const vy = F.y + F.ny * off;
          if (k === 0) g.moveTo(vx, vy);
          else g.lineTo(vx, vy);
        }
        g.closePath();
        g.fill();
      }
    }
  }

  // ---- parting -------------------------------------------------------------

  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // Each half's rail draws back to its own side, keeping strand order and
  // bunching up past the edge. Strands nearest the middle move first and
  // furthest, like a curtain pulled open from the centre.
  function part(now) {
    const mid = W / 2;
    const t = now - partedAt;
    const span = PART_MS * (1 - PART_LEAD);
    for (const s of strands) {
      const fromMid = Math.min(1, Math.abs(s.homeX - mid) / mid);
      const target =
        s.homeX < mid
          ? -PART_MARGIN - s.homeX * PART_BUNCH
          : W + PART_MARGIN + (W - s.homeX) * PART_BUNCH;
      const k = Math.max(0, Math.min(1, (t - fromMid * PART_MS * PART_LEAD) / span));
      s.ax = s.homeX + (target - s.homeX) * easeInOut(k);
    }
  }

  function curtainClear() {
    const reach = TILE_PX * 0.15;
    return strands.every((s) => s.maxX < -reach || s.minX > W + reach);
  }

  // ---- loop ----------------------------------------------------------------

  let last = performance.now();
  let acc = 0;
  function frame(now) {
    if (partedAt !== null) part(now);
    acc += Math.min(0.05, (now - last) / 1000); // don't spiral after a tab switch
    last = now;
    while (acc >= STEP) {
      simulate(STEP);
      acc -= STEP;
    }
    render();

    const progress = Math.min(1, (now - startedAt) / LOAD_MS);
    if (!ready) pctEl.textContent = `${Math.round(progress * 100)}%`;

    if (partedAt !== null && now - partedAt > PART_MS) {
      if (curtainClear()) return teardown();
      // A strand still swinging back into view fades out instead of being held for.
      if (now - partedAt > PART_MS + PART_TIMEOUT && !loaderEl.style.opacity) {
        loaderEl.style.opacity = "0";
        setTimeout(teardown, 400);
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  // ---- input ---------------------------------------------------------------

  function onMove(ev) {
    hand = { x: ev.clientX, y: ev.clientY };
    if (!handPrev) handPrev = { x: hand.x, y: hand.y };
  }
  function onLeave() {
    hand = null;
    handPrev = null;
  }
  loaderEl.addEventListener("pointermove", onMove);
  loaderEl.addEventListener("pointerdown", onMove);
  loaderEl.addEventListener("pointerleave", onLeave);
  loaderEl.addEventListener("pointercancel", onLeave);
  // Touch lifts end the gesture; a mouse keeps hovering.
  loaderEl.addEventListener("pointerup", (ev) => {
    if (ev.pointerType !== "mouse") onLeave();
  });
  window.addEventListener("resize", resize);

  // ---- dismissal -----------------------------------------------------------

  function armDismiss() {
    const minTime = new Promise((res) => setTimeout(res, LOAD_MS));
    const pageLoad = new Promise((res) => {
      if (document.readyState === "complete") res();
      else window.addEventListener("load", res, { once: true });
    });
    const assets = ASSET_URLS.map(
      (src) =>
        new Promise((res) => {
          const img = new Image();
          img.onload = img.onerror = res;
          img.src = src;
        })
    );
    Promise.all([minTime, pageLoad, ...assets]).then(finish);
  }

  function finish() {
    if (ready) return;
    ready = true;
    pctEl.textContent = "100%";
    uiEl.style.opacity = "0";
    // The site is live from the moment the curtain starts to part.
    onLeave();
    loaderEl.style.pointerEvents = "none";
    partedAt = performance.now();
  }

  function teardown() {
    if (done) return;
    done = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener("resize", resize);
    loaderEl.remove();
    uiEl.remove();
    window.dispatchEvent(new CustomEvent("loader:complete"));
  }

  // ---- go ------------------------------------------------------------------

  resize();
  armDismiss();
  rafId = requestAnimationFrame(frame);
  loadTile("assets/bead.svg")
    .then((t) => {
      tile = lighten(t);
    })
    .catch((err) =>
      console.error("Could not load the bead tile — serve over http, not file://", err)
    );
})();
