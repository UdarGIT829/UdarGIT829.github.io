// Light-streak backdrop (port of the Blender prototype in PortfolioStreaks).
//
// The page decides what is shown: every element with data-streaks="<image>"
// owns a picture. Top-level ones (sections) are keypoints along the scroll;
// ones nested inside a keypoint (cards) are branches, shown while that card
// is open. Optional per-picture settings are further data-streaks-* attributes
// (see DEFAULTS, e.g. data-streaks-angle="90", data-streaks-colour="true").
// Changing any of them at runtime (devtools, or code) rebuilds that picture;
// window.streaks.reload() rebuilds them all.
//
// How a picture is made: bullets fly single file along fixed straight tracks.
// Picture tracks are parallel lines laid over the image as seen from that
// picture's viewpoint, each at its own depth, so they line up only from
// there. A bullet's brightness is the image (times noise, gaps and flicker)
// where it sits at its picture's key moment. Every picture has a clock: the
// bullets are in register when it reads 0 and slide along their tracks as it
// moves away. Faint ambient tracks cross around each picture.
//
// The camera sits exactly at a viewpoint while you read a section, flies to
// the next between sections, and flies sideways to a card's picture while the
// card is open. #streaks is removed if WebGL is unavailable.

import * as THREE from "./vendor/three.module.min.js";

// ── World layout (units as in the Blender file) ────────────────────────────
const DIST = 60;              // viewpoint -> image plane
const HALF = 10;              // image plane half-size
const DROP_Z = 40, DROP_Y = 36; // each section is further away and lower
const BRANCH_RADIUS = 80;     // cards sit on an arc this far from their section
const BRANCH_STEP_DEG = 30;
const STEP_SECONDS = 3;       // clock distance between neighbouring pictures
const PICTURE_HEIGHT = 0.62;  // fraction of the view height a picture fills
const TINT = new THREE.Color("#f2d6a2");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const small = Math.min(window.innerWidth, window.innerHeight) < 700;

// Per-picture settings; any can be overridden with data-streaks-<name>.
const DEFAULTS = {
  angle: 0,            // track direction on the picture, degrees (0 = vertical)
  tracks: 90,          // parallel picture tracks
  dashes: 150,         // bullets per track
  overhang: 0.35,      // tracks run past the picture by this (picture lengths)
  fill: 1.05,          // dash length / spacing
  thickness: 0.075,    // on the plane, world units
  near: 0.2, far: 1.0, // track depths, as fractions of the way to the plane
  speed: 6,            // world units per second along the tracks
  threshold: 0.08,     // darker bullets are dropped...
  trackfill: 0.05,     // ...except this fraction, kept faint
  trackglow: 0.025,
  breakup: 0.8,        // noise gate strength (0 = perfect sampling)
  noisescale: 10, noiselow: 0.36, noisehigh: 0.56,
  blur: 0.008,         // sample jitter, picture units
  gaps: 0.35, gapscale: 7, flicker: 0.45,
  ambient: 28,         // ambient tracks
  ambientlength: 45, ambientspread: 1.6, ambientdensity: 0.55, ambientglow: 0.35, ambientthickness: 0.03,
  flowspread: 0.45,
  colour: false,       // keep the image's own colours instead of the gold tint
};
const BRANCH_DEFAULTS = { tracks: 120 };

// ── Renderer ────────────────────────────────────────────────────────────────
const container = document.getElementById("streaks");
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
} catch (e) {
  container.remove();
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setClearColor(0x000000, 0);
container.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 2000);

// One instanced ribbon per bullet. Its position is key + velocity * clock,
// all on the GPU; the CPU only sets each picture's clock.
const ribbon = new THREE.PlaneGeometry(1, 1);
const HALO = 4.0;             // ribbon width / core width (room for the glow)
function material() {
  return new THREE.ShaderMaterial({
    // Pure additive light: add colour, leave alpha at 0, so the (premultiplied)
    // canvas only ever brightens the page behind it.
    transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    uniforms: { uClock: { value: 0 }, uPixel: { value: 0.001 }, uFade: { value: 1 } },
    vertexShader: `
      attribute vec3 aKey;
      attribute vec3 aVel;
      attribute vec2 aSize;      // length, thickness
      attribute vec3 aColor;
      uniform float uClock;
      uniform float uPixel;      // world size of one pixel at distance 1
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vCore;
      void main() {
        vec3 pos = aKey + aVel * uClock;
        vec3 dir = normalize(aVel);
        vec3 toCam = cameraPosition - pos;
        float dist = length(toCam);
        vec3 side = normalize(cross(dir, toCam / dist));
        float minWidth = dist * uPixel * 1.3;            // never thinner than ~1px (no shimmer)
        float core = max(aSize.y, minWidth);
        float energy = aSize.y / core;                    // thin far ones: dimmer, not aliased
        float nearFade = smoothstep(2.0, 9.0, dist);      // other pictures' tracks passing the camera
        vec3 world = pos + dir * position.x * aSize.x + side * position.y * core * ${HALO.toFixed(1)};
        vUv = uv;
        vCore = 1.0 / ${HALO.toFixed(1)};
        vColor = aColor * energy * nearFade;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: `
      uniform float uFade;
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vCore;
      void main() {
        float y = abs(vUv.y - 0.5) * 2.0;                 // 0 centre, 1 edge of the halo
        float core = 1.0 - smoothstep(vCore * 0.55, vCore * 1.1, y);
        float halo = exp(-y * y * 9.0) * 0.16;            // the bloom haze
        gl_FragColor = vec4(vColor * (core + halo) * uFade, 0.0);
      }`,
  });
}

// ── Noise and randomness (deterministic per picture) ───────────────────────
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
const lattice = (() => { const r = rng(1234), t = new Float32Array(4096); for (let i = 0; i < t.length; i++) t[i] = r(); return t; })();
function lat(x, y, z) { return lattice[((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) & 4095]; }
function valueNoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(lat(xi, yi, zi), lat(xi + 1, yi, zi), sx), l(lat(xi, yi + 1, zi), lat(xi + 1, yi + 1, zi), sx), sy),
           l(l(lat(xi, yi, zi + 1), lat(xi + 1, yi, zi + 1), sx), l(lat(xi, yi + 1, zi + 1), lat(xi + 1, yi + 1, zi + 1), sx), sy), sz);
}
function fbm(x, y, z, octaves = 4, rough = 0.6) {      // ~0..1, centred near 0.5, like Blender's noise
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) { sum += valueNoise(x * f, y * f, z * f) * amp; norm += amp; amp *= rough; f *= 2; }
  return sum / norm;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ── Pictures from the page ──────────────────────────────────────────────────
function options(el, branch) {
  const o = { ...DEFAULTS, ...(branch ? BRANCH_DEFAULTS : {}) };
  for (const [key, value] of Object.entries(el.dataset)) {
    if (!key.startsWith("streaks") || key === "streaks") continue;
    const name = key.slice(7).toLowerCase();
    if (!(name in DEFAULTS)) continue;
    o[name] = typeof DEFAULTS[name] === "boolean" ? value !== "false" : parseFloat(value);
  }
  if (small) { o.tracks = Math.round(o.tracks * 0.7); o.dashes = Math.round(o.dashes * 0.7); o.ambient = Math.round(o.ambient * 0.6); }
  return o;
}

const imageCache = new Map();
function loadPixels(src) {
  if (!imageCache.has(src)) {
    imageCache.set(src, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const N = 512, c = document.createElement("canvas");
        c.width = c.height = N;
        const g = c.getContext("2d");
        g.fillStyle = "#000"; g.fillRect(0, 0, N, N);
        const k = Math.min(N / img.width, N / img.height);
        g.drawImage(img, (N - img.width * k) / 2, (N - img.height * k) / 2, img.width * k, img.height * k);
        resolve({ N, data: g.getImageData(0, 0, N, N).data });
      };
      img.onerror = () => resolve(null);
      img.src = src;
    }));
  }
  return imageCache.get(src);
}

// Build one picture's bullets around viewpoint C (camera looks down -z,
// image plane at C + (0, 0, -DIST), u to +x, v to +y).
function buildPicture(px, o, C, seed) {
  const r = rng(seed);
  const D = Math.max(1, o.dashes | 0), T = Math.max(0, o.tracks | 0), A = Math.max(0, o.ambient | 0);
  const angle = THREE.MathUtils.degToRad(o.angle);
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const span = 1 + 2 * o.overhang;
  const sign = seed % 2 ? -1 : 1;
  const key = [], vel = [], size = [], col = [];
  const sample = (u, v) => {
    if (!px || u < 0 || u >= 1 || v < 0 || v >= 1) return [0, 0, 0];
    const i = ((Math.floor((1 - v) * px.N) * px.N) + Math.floor(u * px.N)) * 4;
    return [px.data[i] / 255, px.data[i + 1] / 255, px.data[i + 2] / 255];
  };
  const planeX = (u) => C.x - HALF + 2 * HALF * u, planeY = (v) => C.y - HALF + 2 * HALF * v, planeZ = C.z - DIST;
  const push = (k, v, len, th, c) => { key.push(k[0], k[1], k[2]); vel.push(v[0], v[1], v[2]); size.push(len, th); col.push(c[0], c[1], c[2]); };
  const tint = (b) => [TINT.r * b, TINT.g * b, TINT.b * b];
  const noiseW = (seed % 97) * 7.3;

  // Picture tracks.
  const dirW = [-sa * 2 * HALF, ca * 2 * HALF, 0];          // along a track, per picture length
  const dirLen = Math.hypot(dirW[0], dirW[1]);
  for (let t = 0; t < T; t++) {
    const depth = o.near + (o.far - o.near) * r();
    const speed = o.speed * sign * (0.7 + 0.6 * r());
    const v = [dirW[0] / dirLen * speed, dirW[1] / dirLen * speed, 0];
    const len = depth * dirLen * (span / D) * o.fill;
    const across = (t + 0.5) / T;
    for (let j = 0; j < D; j++) {
      const along = (j + 0.5) / D * span - o.overhang;
      const x = across - 0.5, y = along - 0.5;
      const u = 0.5 + x * ca - y * sa, w = 0.5 + x * sa + y * ca;
      const jitterU = (r() * 2 - 1) * o.blur, jitterV = (r() * 2 - 1) * o.blur;
      const c = sample(u + jitterU, w + jitterV);
      const lum = Math.max(c[0], c[1], c[2]);
      const n = fbm(across * 2.5 * o.noisescale, along * 0.6 * o.noisescale, noiseW);
      const gate = 1 - o.breakup * (1 - smooth(o.noiselow, o.noisehigh, n));
      const run = fbm(t * 3.17, along * o.gapscale, noiseW + 50, 1) > 0.25 + o.gaps * 0.35;
      const flick = 1 - o.flicker * r();
      const lit = lum * gate > o.threshold;
      const faint = r() < o.trackfill;
      if (!run || !(lit || faint)) continue;
      const b = Math.max(lum * gate * flick, o.trackglow);
      const colour = o.colour && lit ? c.map((ch) => Math.max(ch * gate * flick, o.trackglow) * 1.15) : tint(b);
      const P = [planeX(u), planeY(w), planeZ];
      push([C.x + (P[0] - C.x) * depth, C.y + (P[1] - C.y) * depth, C.z + (P[2] - C.z) * depth], v, len, o.thickness * depth, colour);
    }
  }

  // Ambient tracks: long, faint, roughly along the picture tracks.
  const flow = new THREE.Vector3(-sa + 0.25 * sign, ca, 0).normalize();
  for (let a = 0; a < A; a++) {
    const u = -o.ambientspread + (1 + 2 * o.ambientspread) * r();
    const w = -o.ambientspread + (1 + 2 * o.ambientspread) * r();
    const depth = o.near + (o.far * 1.4 - o.near) * r();
    const centre = [C.x + (planeX(u) - C.x) * depth, C.y + (planeY(w) - C.y) * depth, C.z + (planeZ - C.z) * depth];
    const d = new THREE.Vector3(flow.x + (r() * 2 - 1) * o.flowspread, flow.y + (r() * 2 - 1) * o.flowspread, (r() * 2 - 1) * o.flowspread).normalize();
    const speed = o.speed * (0.8 + 1.2 * r());
    const glow = o.ambientglow * (0.1 + 0.9 * r());
    for (let j = 0; j < D; j++) {
      if (r() >= o.ambientdensity) continue;
      const s = ((j + 0.5) / D - 0.5) * o.ambientlength;
      push([centre[0] + d.x * s, centre[1] + d.y * s, centre[2] + d.z * s], [d.x * speed, d.y * speed, d.z * speed],
           o.ambientlength / D * o.fill, o.ambientthickness, tint(glow * (1 - o.flicker * r())));
    }
  }

  const geo = new THREE.InstancedBufferGeometry();
  // Own copies of the ribbon (tiny): disposing a rebuilt picture must not free
  // buffers that the other pictures still draw with.
  geo.setIndex(ribbon.index.clone());
  geo.setAttribute("position", ribbon.getAttribute("position").clone());
  geo.setAttribute("uv", ribbon.getAttribute("uv").clone());
  geo.setAttribute("aKey", new THREE.InstancedBufferAttribute(new Float32Array(key), 3));
  geo.setAttribute("aVel", new THREE.InstancedBufferAttribute(new Float32Array(vel), 3));
  geo.setAttribute("aSize", new THREE.InstancedBufferAttribute(new Float32Array(size), 2));
  geo.setAttribute("aColor", new THREE.InstancedBufferAttribute(new Float32Array(col), 3));
  geo.instanceCount = key.length / 3;
  return geo;
}

// ── Keypoints and branches ──────────────────────────────────────────────────
const pictures = [];          // { el, branch, hub, index, C, mesh, open, blend }
const keypoints = [];

function collect() {
  const all = [...document.querySelectorAll("[data-streaks]")];
  for (const el of all) {
    const parent = el.parentElement && el.parentElement.closest("[data-streaks]");
    if (!parent) keypoints.push({ el, branches: [] });
  }
  keypoints.forEach((kp, k) => {
    const side = k % 2 ? 6 : -6;
    kp.C = new THREE.Vector3(side, -DROP_Y * k, -DROP_Z * k);
    kp.picture = { el: kp.el, branch: false, hubIndex: k, C: kp.C, seed: k + 1 };
    pictures.push(kp.picture);
  });
  for (const el of all) {
    const parent = el.parentElement && el.parentElement.closest("[data-streaks]");
    if (!parent) continue;
    const kp = keypoints.find((p) => p.el === parent);
    if (kp) kp.branches.push(el);
  }
  keypoints.forEach((kp, k) => {
    const n = kp.branches.length;
    const base = k % 2 ? 180 : 0;                          // alternate sides so neighbours never overlap
    kp.branches.forEach((el, i) => {
      const deg = (n - 1) / 2 * BRANCH_STEP_DEG - i * BRANCH_STEP_DEG;    // first card at the top
      const theta = THREE.MathUtils.degToRad(base ? 180 - deg : deg);
      const C = new THREE.Vector3(kp.C.x + BRANCH_RADIUS * Math.cos(theta), kp.C.y + BRANCH_RADIUS * Math.sin(theta), kp.C.z);
      const pic = { el, branch: true, hubIndex: k, C, seed: 100 + k * 10 + i, blend: 0, open: false };
      pictures.push(pic);
    });
  });
}

async function build(pic) {
  const src = pic.el.dataset.streaks;
  const px = src ? await loadPixels(src) : null;
  const o = options(pic.el, pic.branch);
  const geo = buildPicture(px, o, pic.C, pic.seed + hash(src || ""));
  if (pic.mesh) {
    pic.mesh.geometry.dispose();
    pic.mesh.geometry = geo;
  } else {
    pic.mesh = new THREE.Mesh(geo, material());
    pic.mesh.frustumCulled = false;
    scene.add(pic.mesh);
  }
  dirty = true;
}

function isOpen(el) {
  const head = el.querySelector(".card-head");
  return head ? head.getAttribute("aria-expanded") === "true" : el.classList.contains("open");
}

// ── Scroll -> where along the keypoints we are ──────────────────────────────
// Each keypoint has a band on the page, from its top element to its bottom
// element: the element marked data-streaks-top inside it (default: its first
// h1/h2), and the one marked data-streaks-bottom (default: the keypoint
// itself, so its own bottom edge). Bands are measured live, so open cards
// that make a section taller simply make its band longer.
//
// The picture holds exactly while the band covers the reading line (READ_LINE
// of the way down the view), trimmed by MARGIN at each end. In the space
// between one band and the next the camera flies, on a smootherstep (zero
// speed and acceleration at both ends), so it starts changing gently, builds
// to full movement and settles the same way. The hold has to be exact: the
// nearest tracks are only a few units from the camera, so even a tiny move
// smears the picture through parallax (the wobble, a pure rotation, keeps the
// view alive without that).
const READ_LINE = 0.55;       // fraction of the view height
const MARGIN = 0.2;           // of the view height, trimmed off each end of a band (longer flights)
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function bands() {
  const vh = window.innerHeight, sy = window.scrollY, m = vh * MARGIN, n = keypoints.length;
  const out = keypoints.map((kp, k) => {
    const topEl = kp.el.querySelector("[data-streaks-top]") || kp.el.querySelector("h1, h2") || kp.el;
    const botEl = kp.el.querySelector("[data-streaks-bottom]") || kp.el;
    const top = topEl.getBoundingClientRect().top + sy, bottom = botEl.getBoundingClientRect().bottom + sy;
    let start = k === 0 ? -Infinity : top + m, end = k === n - 1 ? Infinity : bottom - m;
    if (end < start) start = end = (top + bottom) / 2;          // short section: a single point
    return { start, end };
  });
  // The last band must be reachable: the reading line can't go past the end of the page.
  if (n > 1) {
    const reach = Math.max(0, document.documentElement.scrollHeight - vh) + vh * READ_LINE - 1;
    const last = out[n - 1], prev = out[n - 2];
    if (last.start > reach) {
      last.start = reach;
      if (prev.end >= last.start) prev.end = Math.max(prev.start, last.start - vh * 0.3);
    }
  }
  return out;
}

function readingLine() { return window.scrollY + window.innerHeight * READ_LINE; }

// Reading-line position (page px) -> q, a continuous keypoint coordinate.
function keypointCoordinate(y) {
  const b = bands();
  for (let k = 0; k < b.length; k++) {
    if (y < b[k].start) {
      const from = b[k - 1].end, to = b[k].start;
      return k - 1 + smoother(Math.min(1, Math.max(0, (y - from) / Math.max(1, to - from))));
    }
    if (y <= b[k].end) return k;
  }
  return b.length - 1;
}

// ── Camera ──────────────────────────────────────────────────────────────────
let wide = true, dirty = true;
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  wide = w >= 1000;
  // Fit the picture: a fixed share of the height, or of the width when narrow.
  const fit = Math.min(PICTURE_HEIGHT, camera.aspect * 0.85);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(HALF / DIST / fit));
  // Wide screens: shift the view (a lens shift) so the picture sits right of the text.
  if (wide) camera.setViewOffset(w, h, -Math.round(w * 0.27), 0, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  const pixel = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (h * renderer.getPixelRatio());
  for (const p of pictures) if (p.mesh) p.mesh.material.uniforms.uPixel.value = pixel;
  container.classList.toggle("narrow", !wide);
  dirty = true;
}

// Scroll following: a critically damped spring on the reading line, so the
// view picks up and settles smoothly however the page jumps (keys, anchors).
const SPRING = 6;             // rad/s; higher follows more tightly (the page scroll itself is smoothed by smooth-scroll.js)
let u = readingLine(), uVel = 0, last = performance.now(), lastKey = "", time = 0;
const position = new THREE.Vector3();

// Wobble: a slow, slight sway of the camera's aim, independent of scrolling.
// Turning the camera about its own position doesn't change which rays line
// up, so pictures stay formed; they just drift gently on screen.
const WOBBLE = reduceMotion ? 0 : 1;
function wobble(t) {
  const s = (a, f, p) => a * Math.sin(t * f + p);
  return {
    yaw: WOBBLE * (s(0.010, 0.23, 0.0) + s(0.005, 0.57, 1.3) + s(0.002, 1.31, 4.1)),
    pitch: WOBBLE * (s(0.007, 0.19, 2.2) + s(0.004, 0.61, 0.7) + s(0.0015, 1.17, 3.3)),
    roll: WOBBLE * (s(0.006, 0.13, 5.0) + s(0.003, 0.47, 2.6)),
  };
}
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  time += dt;
  const target = readingLine();
  if (reduceMotion) { u = target; uVel = 0; }
  else {
    // Exact critically damped step: smooth and stable at any frame rate.
    const x = u - target, k = uVel + SPRING * x, e = Math.exp(-SPRING * dt);
    u = target + (x + k * dt) * e;
    uVel = (uVel - SPRING * k * dt) * e;
  }
  const q = keypointCoordinate(u);

  // Scroll position between keypoints.
  const k0 = Math.max(0, Math.min(keypoints.length - 1, Math.floor(q)));
  const k1 = Math.min(keypoints.length - 1, k0 + 1);
  position.lerpVectors(keypoints[k0].C, keypoints[k1].C, q - k0);   // q is already eased

  // Open cards pull the camera sideways to their picture's viewpoint.
  let away = 0;
  for (const p of pictures) {
    if (!p.branch) continue;
    p.open = isOpen(p.el);
    const rate = reduceMotion ? 1 : dt / 1.1;
    p.blend = Math.min(1, Math.max(0, p.blend + (p.open ? rate : -rate)));
    // Full pull while its section is on screen (opening a card reflows the
    // page a little), fading out once you scroll half a section away.
    const near = 1 - smooth(0.45, 0.9, Math.abs(q - p.hubIndex));
    p.weight = smooth(0, 1, p.blend) * near;
    if (p.weight > 0) {
      position.lerp(p.C, p.weight);               // to the card's own viewpoint, exactly
      if (p.hubIndex === Math.round(q)) away = Math.max(away, p.weight);
    }
  }
  camera.position.copy(position);
  camera.lookAt(position.x, position.y, position.z - 1);
  const w = wobble(time);
  camera.rotateY(w.yaw);
  camera.rotateX(w.pitch);
  camera.rotateZ(w.roll);

  // Clocks: 0 when the camera is at the picture's viewpoint.
  let key = position.toArray().map((v) => v.toFixed(3)).join() + (WOBBLE ? time.toFixed(2) : "");
  for (const p of pictures) {
    if (!p.mesh) continue;
    const clock = p.branch ? (1 - p.weight) * STEP_SECONDS : ((q - p.hubIndex) + (p.hubIndex === Math.round(q) ? away : 0)) * STEP_SECONDS;
    p.mesh.material.uniforms.uClock.value = clock;
    p.mesh.visible = Math.abs(clock) < STEP_SECONDS * 2.5;          // far from the view: skip
    key += p.mesh.visible ? clock.toFixed(3) : "-";
  }
  if (key !== lastKey || dirty) {
    renderer.render(scene, camera);
    lastKey = key;
    dirty = false;
  }
  requestAnimationFrame(frame);
}

// ── Start, and rebuild on attribute changes ─────────────────────────────────
collect();
window.addEventListener("resize", resize);
if (keypoints.length) {
  // Sections first (in order), then cards in the background.
  (async () => {
    for (const p of pictures.filter((x) => !x.branch)) await build(p);
    resize();
    requestAnimationFrame(frame);
    container.classList.add("live");
    for (const p of pictures.filter((x) => x.branch)) await build(p);
    resize();
  })();
  new MutationObserver((records) => {
    const changed = new Set();
    for (const rec of records) {
      if (rec.attributeName === "aria-expanded") { dirty = true; continue; }
      const pic = pictures.find((p) => p.el === rec.target);
      if (pic) changed.add(pic);
    }
    for (const p of changed) build(p).then(resize);
  }).observe(document.body, { subtree: true, attributes: true,
    attributeFilter: ["aria-expanded", ...new Set(["data-streaks", ...Object.keys(DEFAULTS).map((k) => `data-streaks-${k}`)])] });
} else {
  container.remove();
}

window.streaks = { reload: () => Promise.all(pictures.map(build)).then(resize), pictures, renderer, camera, scene };
