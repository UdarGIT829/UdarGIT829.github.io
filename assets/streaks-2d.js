// Canvas 2D renderer for the streaks backdrop: the fallback when WebGL isn't
// available at full speed (hardware acceleration off, blocked GPUs, VMs and
// remote desktops). Same scene, same maths as the WebGL shader, done on the
// CPU: each bullet moves by key + velocity * clock, both ends are projected
// with the camera's view-projection matrix, and dashes are drawn as additive
// ("lighter") lines. To stay fast, dashes are batched into one path per
// colour and width bucket, and the caller builds fewer, thicker bullets for
// this tier (see DENSITY in streaks.js).

import { HALO } from "./streaks-gl.js";

const LEVELS = 15;            // colour quantisation per channel (batching)

export function create2DRenderer(container) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;
  container.appendChild(canvas);
  const pictures = new Map();  // id -> { key, vel, size, col, count, dir }
  let W = 0, H = 0;
  const buckets = new Map();   // "r,g,b,w" -> Float32Array-ish list of x0,y0,x1,y1
  let halo = true;

  return {
    tier: "2d",
    canvas,
    pixelRatio: 1,
    set halo(on) { halo = on; },

    setPicture(id, d) {
      const dir = new Float32Array(d.count * 3);       // unit direction of travel, precomputed
      for (let i = 0; i < d.count; i++) {
        const x = d.vel[3 * i], y = d.vel[3 * i + 1], z = d.vel[3 * i + 2];
        const l = Math.hypot(x, y, z) || 1;
        dir[3 * i] = x / l; dir[3 * i + 1] = y / l; dir[3 * i + 2] = z / l;
      }
      pictures.set(id, { ...d, dir });
    },

    resize(w, h) {
      W = canvas.width = Math.round(w);
      H = canvas.height = Math.round(h);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
    },

    render(f) {
      const m = f.viewProj, cam = f.cam, pixel = f.pixel;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, W, H);
      buckets.clear();
      const add = (key, x0, y0, x1, y1) => {
        let list = buckets.get(key);
        if (!list) buckets.set(key, (list = []));
        list.push(x0, y0, x1, y1);
      };
      for (const { id, clock } of f.pictures) {
        const p = pictures.get(id);
        if (!p) continue;
        const { key, vel, size, col, dir, count } = p;
        for (let i = 0; i < count; i++) {
          const i3 = 3 * i;
          const px = key[i3] + vel[i3] * clock, py = key[i3 + 1] + vel[i3 + 1] * clock, pz = key[i3 + 2] + vel[i3 + 2] * clock;
          const dx = cam[0] - px, dy = cam[1] - py, dz = cam[2] - pz;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist < 2) continue;                              // nearFade = 0
          const half = size[2 * i] * 0.5;
          const ax = px - dir[i3] * half, ay = py - dir[i3 + 1] * half, az = pz - dir[i3 + 2] * half;
          const bx = px + dir[i3] * half, by = py + dir[i3 + 1] * half, bz = pz + dir[i3 + 2] * half;
          const aw = m[3] * ax + m[7] * ay + m[11] * az + m[15];
          const bw = m[3] * bx + m[7] * by + m[11] * bz + m[15];
          if (aw < 0.5 || bw < 0.5) continue;                  // behind the camera
          const sx0 = ((m[0] * ax + m[4] * ay + m[8] * az + m[12]) / aw * 0.5 + 0.5) * W;
          const sy0 = (0.5 - (m[1] * ax + m[5] * ay + m[9] * az + m[13]) / aw * 0.5) * H;
          const sx1 = ((m[0] * bx + m[4] * by + m[8] * bz + m[12]) / bw * 0.5 + 0.5) * W;
          const sy1 = (0.5 - (m[1] * bx + m[5] * by + m[9] * bz + m[13]) / bw * 0.5) * H;
          if ((sx0 < -20 && sx1 < -20) || (sx0 > W + 20 && sx1 > W + 20) ||
              (sy0 < -20 && sy1 < -20) || (sy0 > H + 20 && sy1 > H + 20)) continue;
          // Same width rules as the shader: at least ~1.3 px, dimmer when widened.
          const th = size[2 * i + 1];
          const minW = dist * pixel * 1.3;
          const core = Math.max(th, minW);
          const energy = th / core;
          const t = Math.min(1, (dist - 2) / 7), nearFade = t * t * (3 - 2 * t);
          const k = energy * nearFade;
          const r = Math.min(LEVELS, Math.round(col[i3] * k * LEVELS));
          const g = Math.min(LEVELS, Math.round(col[i3 + 1] * k * LEVELS));
          const b = Math.min(LEVELS, Math.round(col[i3 + 2] * k * LEVELS));
          if (r + g + b === 0) continue;
          const wpx = Math.min(12, Math.round(core / (dist * pixel) * 2) / 2);   // core width in px, 0.5 steps
          add(`${r},${g},${b},${wpx}`, sx0, sy0, sx1, sy1);
        }
      }
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "butt";
      for (const [k, list] of buckets) {
        const [r, g, b, w] = k.split(",").map(Number);
        const rr = Math.round(r / LEVELS * 255), gg = Math.round(g / LEVELS * 255), bb = Math.round(b / LEVELS * 255);
        ctx.beginPath();
        for (let j = 0; j < list.length; j += 4) { ctx.moveTo(list[j], list[j + 1]); ctx.lineTo(list[j + 2], list[j + 3]); }
        if (halo) {                                          // the bloom haze: wide and faint
          ctx.lineWidth = w * HALO * 0.55;
          ctx.strokeStyle = `rgba(${rr},${gg},${bb},0.16)`;
          ctx.stroke();
        }
        ctx.lineWidth = Math.max(1, w);
        ctx.strokeStyle = `rgb(${rr},${gg},${bb})`;
        ctx.stroke();
      }
    },
  };
}
