// ---------------------------------------------------------------------------
// Loading screen: whatever the visitor draws with the pointer, in the
// black-and-white chain tile, over the background. The screen lifts after
// LOAD_MS (and once the page and ASSET_URLS have loaded); the % counter runs
// off the same clock.
//
// The chain bakes into its own layer once per bead rather than being redrawn
// every frame; only its growing tip is live.
//
// To wire in the real microsite, list its images/fonts/audio in ASSET_URLS.
// ---------------------------------------------------------------------------

const ASSET_URLS = [
  // "assets/cd-sleeve.png",
  // "assets/logo.svg",
];
const LOAD_MS = 5000; // the screen lifts at this mark

const DRAW_TILE_PX = 66; // one repeat of the pointer-drawn chain
const DRAW_OVERLAP = 0.97;

let drawLayer;
let drawTile = null;
let chain = null;

let startedAt = 0;
let armed = false;
let pctEl, loaderEl, uiEl;
let ready = false;

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent("loader");
  drawLayer = createGraphics(windowWidth, windowHeight);

  pctEl = document.getElementById("loader-pct");
  loaderEl = document.getElementById("loader");
  uiEl = document.getElementById("loader-ui");

  startedAt = millis();
  armDismiss();

  loadTile("assets/bead.svg")
    .then((t) => {
      drawTile = t;
      chain = new ChainStamper({
        tile: t,
        tileLengthPx: DRAW_TILE_PX,
        overlap: DRAW_OVERLAP,
        onBakeRepeat: (uStart, path) =>
          renderTile(t, path, uStart, DRAW_TILE_PX, drawLayer, null),
      });
    })
    .catch(reportTileError);
}

function reportTileError(err) {
  console.error("Could not load a bead tile — serve over http, not file://", err);
}

function draw() {
  clear(); // the #loader div's CSS background shows through

  const progress = Math.min(1, (millis() - startedAt) / LOAD_MS);
  if (pctEl) pctEl.textContent = `${Math.round(progress * 100)}%`;

  image(drawLayer, 0, 0);

  // The still-growing tip of the pointer chain: only beads the path reaches.
  if (chain) {
    renderTile(
      drawTile,
      chain.path,
      chain.nextRepeatAt,
      DRAW_TILE_PX,
      undefined,
      chain.path.totalLength
    );
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  const previous = drawLayer;
  drawLayer = createGraphics(windowWidth, windowHeight);
  drawLayer.image(previous, 0, 0); // keep what the visitor has drawn
  previous.remove();
}

function mouseMoved() {
  if (chain) chain.moveTo(mouseX, mouseY);
}

function touchMoved() {
  if (chain) chain.moveTo(mouseX, mouseY);
  return false; // prevent page scroll while drawing
}

function armDismiss() {
  if (armed) return;
  armed = true;
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
  if (pctEl) pctEl.textContent = "100%";
  uiEl.style.transform = "translateY(-100%)";
  loaderEl.style.transform = "translateY(-100%)";
  setTimeout(() => {
    noLoop(); // the canvas is about to be detached; stop redrawing it
    loaderEl.remove();
    uiEl.remove();
    window.dispatchEvent(new CustomEvent("loader:complete"));
  }, 950);
}
