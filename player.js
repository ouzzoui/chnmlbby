// ---------------------------------------------------------------------------
// Home page: the bracelet is both artwork and transport dial.
//
// Twelve pendants sit at fixed angles in the artwork. The playhead is the
// lightbulb in the background photo, at 12 o'clock. Selecting a track rotates
// that pendant up to the bulb, then the bracelet spins clockwise while the
// track plays.
//
// Playback runs off a single <audio> element. A track with no `src` falls back
// to SIMULATED playback, where the clock runs off its listed duration.
// assets/audio/ currently holds PLACEHOLDER tracks (11–12 repeat 01–02) — swap in the real
// files under the same names (or change `src` below).
//
// Wrapped in an IIFE because loader.js runs p5 in global mode, and p5
// overwrites globals such as `select` when it initialises.
// ---------------------------------------------------------------------------

(function () {
"use strict";

// Measured off the artwork: angles clockwise from 3 o'clock, screen
// coordinates (y grows downward).
const PENDANT_ANGLES = [
  15.0, 49.0, 75.5, 97.5, 129.5, 148.5,
  165.0, 200.5, 228.5, 262.5, 296.0, 316.0,
];
const TASSEL_ANGLE = 355.5; // rest position, not a track
const INDICATOR_ANGLE = 0; // 3 o'clock, where the playhead sits

const TRACK_DATA = [
  ["NOT CUTE!", 161],
  ["formidable opponent", 192],
  ["fleabag iii", 178],
  ["hello hello hello", 225],
  ["(the dealer)", 112],
  ["protean", 243],
  ["flamenco ii", 147],
  ["mix 2 guitar break (i could give you everything)", 208],
  ["black cop", 186],
  ["windup", 169],
  ["what", 98],
  ["i feel like", 261],
];

const ROMAN = ["I", "II", "III", "IV", "V", "VI",
               "VII", "VIII", "IX", "X", "XI", "XII"];

const TRACKS = TRACK_DATA.map(([title, duration], i) => ({
  title,
  duration,
  angle: PENDANT_ANGLES[i],
  n: ROMAN[i],
  src: `assets/audio/${String(i + 1).padStart(2, "0")}.mp3`,
}));

const audio = new Audio();
audio.preload = "auto";

// Real length once the file's metadata is in; the listed one until then.
function trackDuration(t) {
  return t.src && audio.src.endsWith(t.src) && Number.isFinite(audio.duration)
    ? audio.duration
    : t.duration;
}

const SPIN_DEG_PER_SEC = 24;
const SNAP_MS = 620;

const dial = document.getElementById("dial");
const bracelet = document.getElementById("bracelet");
const playhead = document.getElementById("playhead");
const list = document.getElementById("tracklist");
const npTitle = document.getElementById("npTitle");
const playBtn = document.getElementById("playBtn");
const playIcon = document.getElementById("playIcon");
const pauseIcon = document.getElementById("pauseIcon");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const scrub = document.getElementById("scrub");
const scrubHandle = document.getElementById("scrubHandle");
const curTime = document.getElementById("curTime");
const durTime = document.getElementById("durTime");

let rotation = INDICATOR_ANGLE - TASSEL_ANGLE; // tassel starts at the bulb
let selected = null;
let playing = false;
let elapsed = 0;

let dragging = false;
// While dragging, the highlight follows the pendant nearest the playhead
// without committing a selection: null = not previewing, {index} = previewing
// (index may itself be null, meaning the tassel).
let preview = null;
let dragStartPointer = 0;
let dragStartRotation = 0;
let moved = false;
let scrubbing = false;
let snap = null;

// --- rotation --------------------------------------------------------------

function apply() {
  bracelet.style.transform =
    `translate(-49.37%, -51.64%) rotate(${rotation}deg)`;
}

// Shortest signed distance from a to b, in (-180, 180].
function delta(a, b) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

function rotationFor(angle) {
  return INDICATOR_ANGLE - angle;
}

function nearestStop(rot) {
  const stops = TRACKS.map((t, i) => ({ index: i, angle: t.angle }));
  stops.push({ index: null, angle: TASSEL_ANGLE });
  let best = stops[0];
  let bestErr = Infinity;
  for (const s of stops) {
    const err = Math.abs(delta(s.angle + rot, INDICATOR_ANGLE));
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  return best;
}

function rotateTo(angle) {
  // Land on the nearest equivalent rotation so it never takes the long way.
  const target = rotation + delta(rotation, rotationFor(angle));
  snap = { from: rotation, to: target, start: performance.now() };
}

// --- transport -------------------------------------------------------------

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function selectTrack(index, { play = false, keepTime = false } = {}) {
  selected = index;
  if (!keepTime) elapsed = 0;
  const src = index === null ? null : TRACKS[index].src;
  if (src && !audio.src.endsWith(src)) audio.src = src;
  if (src && !keepTime) audio.currentTime = 0;
  rotateTo(index === null ? TASSEL_ANGLE : TRACKS[index].angle);
  if (index === null) setPlaying(false);
  else if (play) setPlaying(true);
  render();
}

function setPlaying(next) {
  const was = playing;
  playing = next && selected !== null;
  playIcon.hidden = playing;
  pauseIcon.hidden = !playing;
  playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  playBtn.setAttribute("aria-pressed", String(playing));
  playhead.classList.toggle("is-playing", playing);
  // Coming to rest: wind the current pendant back under the playhead, since
  // spinning will have carried it away.
  if (was && !playing && selected !== null) rotateTo(TRACKS[selected].angle);
  if (playing && TRACKS[selected].src) audio.play().catch(() => setPlaying(false));
  else audio.pause();
}

function step(dir) {
  if (selected === null) {
    selectTrack(dir > 0 ? 0 : TRACKS.length - 1, { play: true });
    return;
  }
  // Pressing back more than 3s in restarts the track, as players usually do.
  if (dir < 0 && elapsed > 3) {
    elapsed = 0;
    if (TRACKS[selected].src) audio.currentTime = 0;
    render();
    return;
  }
  const next = (selected + dir + TRACKS.length) % TRACKS.length;
  selectTrack(next, { play: playing });
}

function seekToRatio(r) {
  if (selected === null) return;
  elapsed = Math.min(1, Math.max(0, r)) * trackDuration(TRACKS[selected]);
  if (TRACKS[selected].src) audio.currentTime = elapsed;
  render();
}

function renderHighlight() {
  const shown = preview ? preview.index : selected;
  for (const li of list.children) {
    li.classList.toggle("is-current", Number(li.dataset.index) === shown);
  }
}

function render() {
  const t = selected === null ? null : TRACKS[selected];
  npTitle.textContent = t ? t.title : "drag disc or hit spacebar to listen";
  curTime.textContent = fmt(t ? elapsed : 0);
  durTime.textContent = fmt(t ? trackDuration(t) : 0);
  const ratio = t ? elapsed / trackDuration(t) : 0;
  scrubHandle.style.left = `${ratio * 100}%`;
  renderHighlight();
}

// --- interaction -----------------------------------------------------------

function pointerAngle(ev) {
  const r = dial.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  return (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI;
}

dial.addEventListener("pointerdown", (ev) => {
  dragging = true;
  moved = false;
  snap = null;
  dragStartPointer = pointerAngle(ev);
  dragStartRotation = rotation;
  dial.setPointerCapture(ev.pointerId);
  dial.classList.add("is-dragging");
});

dial.addEventListener("pointermove", (ev) => {
  if (!dragging) return;
  const d = delta(dragStartPointer, pointerAngle(ev));
  if (Math.abs(d) > 1.5) moved = true;
  rotation = dragStartRotation + d;
  apply();
  // Show which track the disc has turned to, before it is committed.
  preview = { index: nearestStop(rotation).index };
  renderHighlight();
});

function endDrag(ev) {
  if (!dragging) return;
  dragging = false;
  preview = null;
  dial.releasePointerCapture?.(ev.pointerId);
  dial.classList.remove("is-dragging");
  if (!moved) {
    setPlaying(!playing);
    return;
  }
  const stop = nearestStop(rotation);
  selectTrack(stop.index, { play: stop.index !== null });
}

dial.addEventListener("pointerup", endDrag);
dial.addEventListener("pointercancel", endDrag);

// Spacebar toggles playback; arrows step between tracks. Ignored while the
// loading screen is up, or while something is being typed into.
document.addEventListener("keydown", (ev) => {
  const isSpace = ev.code === "Space" || ev.key === " ";
  const isPrev = ev.key === "ArrowLeft";
  const isNext = ev.key === "ArrowRight";
  if (!isSpace && !isPrev && !isNext) return;
  if (document.getElementById("loader")) return;

  const el = document.activeElement;
  const tag = el ? el.tagName : "";
  if (el && (el.isContentEditable || tag === "INPUT" || tag === "TEXTAREA")) return;
  // Only space clashes with a focused control — the browser already fires
  // those on space, and handling it here too would toggle twice.
  if (isSpace && (tag === "BUTTON" || tag === "A")) return;

  ev.preventDefault();
  if (isSpace) {
    if (selected === null) selectTrack(0, { play: true });
    else setPlaying(!playing);
  } else {
    step(isNext ? 1 : -1);
  }
});

playBtn.addEventListener("click", () => {
  if (selected === null) selectTrack(0, { play: true });
  else setPlaying(!playing);
});
prevBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));

function scrubFromEvent(ev) {
  const r = scrub.getBoundingClientRect();
  seekToRatio((ev.clientX - r.left) / r.width);
}
scrub.addEventListener("pointerdown", (ev) => {
  scrubbing = true;
  scrub.setPointerCapture(ev.pointerId);
  scrubFromEvent(ev);
});
scrub.addEventListener("pointermove", (ev) => {
  if (scrubbing) scrubFromEvent(ev);
});
function endScrub(ev) {
  if (!scrubbing) return;
  scrubbing = false;
  scrub.releasePointerCapture?.(ev.pointerId);
}
scrub.addEventListener("pointerup", endScrub);
scrub.addEventListener("pointercancel", endScrub);

for (const [i, t] of TRACKS.entries()) {
  const li = document.createElement("li");
  li.dataset.index = String(i);
  li.textContent = `${t.n}. ${t.title}`;
  li.addEventListener("click", () => selectTrack(i, { play: true }));
  list.appendChild(li);
}

// --- loop ------------------------------------------------------------------

let last = performance.now();
function frame(now) {
  const dt = (now - last) / 1000;
  last = now;

  if (snap) {
    const p = Math.min(1, (now - snap.start) / SNAP_MS);
    rotation = snap.from + (snap.to - snap.from) * (1 - Math.pow(1 - p, 3));
    if (p >= 1) snap = null;
    apply();
  } else if (playing && !dragging) {
    rotation += SPIN_DEG_PER_SEC * dt;
    apply();
  }

  if (playing && !scrubbing && selected !== null) {
    if (TRACKS[selected].src) {
      elapsed = audio.currentTime; // track end is handled by the "ended" event
      render();
    } else {
      elapsed += dt;
      if (elapsed >= TRACKS[selected].duration) step(1);
      else render();
    }
  }

  requestAnimationFrame(frame);
}

audio.addEventListener("loadedmetadata", render); // show the real duration

// Read every file's real length up front, replacing the listed durations, so
// the times are right before a track is ever played.
for (const t of TRACKS) {
  if (!t.src) continue;
  const probe = new Audio();
  probe.preload = "metadata";
  probe.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(probe.duration)) t.duration = probe.duration;
    render();
    probe.removeAttribute("src"); // release the connection
    probe.load();
  }, { once: true });
  // Missing/unplayable file: fall back to simulated playback for this track.
  probe.addEventListener("error", () => { t.src = null; }, { once: true });
  probe.src = t.src;
}
audio.addEventListener("ended", () => step(1));

apply();
render();
requestAnimationFrame(frame);

})();
