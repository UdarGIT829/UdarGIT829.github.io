// WebGL renderer for the streaks backdrop (WebGL 2, or WebGL 1 with
// ANGLE_instanced_arrays). One instanced ribbon per bullet; its position is
// key + velocity * clock, computed on the GPU, so the CPU only passes each
// picture's clock. The shader is GLSL ES 1.00, which both versions accept.
//
// createGLRenderer(container, version) returns null if that version isn't
// available at full speed (failIfMajorPerformanceCaveat: a software-only
// WebGL is slower here than the Canvas 2D renderer).

export const HALO = 4.0;      // ribbon width / core width (room for the glow)
const STRIDE = 11;            // floats per bullet: key xyz, vel xyz, length, thickness, rgb

const VERTEX = `
attribute vec2 aCorner;       // x along the dash (-0.5..0.5), y across (-0.5..0.5)
attribute vec3 aKey;
attribute vec3 aVel;
attribute vec2 aSize;         // length, thickness
attribute vec3 aColor;
uniform mat4 uViewProj;
uniform vec3 uCam;
uniform float uClock;
uniform float uPixel;         // world size of one pixel at distance 1
varying float vY;
varying vec3 vColor;
void main() {
  vec3 pos = aKey + aVel * uClock;
  vec3 dir = normalize(aVel);
  vec3 toCam = uCam - pos;
  float dist = length(toCam);
  vec3 side = normalize(cross(dir, toCam / dist));
  float minWidth = dist * uPixel * 1.3;             // never thinner than ~1px (no shimmer)
  float core = max(aSize.y, minWidth);
  float energy = aSize.y / core;                     // thin far ones: dimmer, not aliased
  float nearFade = smoothstep(2.0, 9.0, dist);       // other pictures' tracks passing the camera
  vec3 world = pos + dir * aCorner.x * aSize.x + side * aCorner.y * core * ${HALO.toFixed(1)};
  vY = aCorner.y * 2.0;
  vColor = aColor * energy * nearFade;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
varying float vY;
varying vec3 vColor;
void main() {
  float y = abs(vY);                                 // 0 centre, 1 edge of the halo
  float c = 1.0 / ${HALO.toFixed(1)};
  float core = 1.0 - smoothstep(c * 0.55, c * 1.1, y);
  float halo = exp(-y * y * 9.0) * 0.16;             // the bloom haze
  gl_FragColor = vec4(vColor * (core + halo), 0.0);  // add light, leave alpha at 0
}`;

export function createGLRenderer(container, version) {
  const canvas = document.createElement("canvas");
  const attrs = { alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false,
                  powerPreference: "high-performance", failIfMajorPerformanceCaveat: true };
  let gl = null;
  try { gl = canvas.getContext(version === 2 ? "webgl2" : "webgl", attrs); } catch (e) { gl = null; }
  if (!gl) return null;
  let inst = null;                                     // instancing entry points
  if (version === 2) {
    inst = { divisor: (i, d) => gl.vertexAttribDivisor(i, d), draw: (n) => gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n) };
  } else {
    const ext = gl.getExtension("ANGLE_instanced_arrays");
    if (!ext) return null;
    inst = { divisor: (i, d) => ext.vertexAttribDivisorANGLE(i, d), draw: (n) => ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, n) };
  }

  const pictures = new Map();                          // id -> { data, count, buffer }
  let prog, loc, corners;
  let lost = false;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function init() {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    // Slot 0 must be a per-vertex attribute: some drivers draw nothing when
    // attribute 0 is instanced.
    gl.bindAttribLocation(prog, 0, "aCorner");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    loc = {};
    for (const a of ["aCorner", "aKey", "aVel", "aSize", "aColor"]) loc[a] = gl.getAttribLocation(prog, a);
    for (const u of ["uViewProj", "uCam", "uClock", "uPixel"]) loc[u] = gl.getUniformLocation(prog, u);
    corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    for (const p of pictures.values()) upload(p);
  }

  function upload(p) {
    p.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, p.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, p.data, gl.STATIC_DRAW);
  }

  try { init(); } catch (e) { return null; }

  // Self-test: draw one streak across a tiny canvas and read it back. Some
  // drivers create a context that accepts every call yet draws nothing; then
  // the caller falls back to the next tier instead of showing a blank page.
  function selfTest() {
    canvas.width = canvas.height = 8;
    const id = "__test";
    api.setPicture(id, { count: 1, key: [0, 0, 0], vel: [1, 0, 0], size: [2, 1], col: [1, 1, 1] });
    const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    api.render({ viewProj: I, cam: [0, 0, 5], pixel: 0.0001, pictures: [{ id, clock: 0 }] });
    const px = new Uint8Array(4);
    gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const p = pictures.get(id);
    if (p && p.buffer) gl.deleteBuffer(p.buffer);
    pictures.delete(id);
    return gl.getError() === gl.NO_ERROR && px[0] + px[1] + px[2] > 30;
  }

  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener("webglcontextrestored", () => {
    try { init(); lost = false; } catch (e) { /* stays blank; the page still works */ }
  });
  const api = {
    tier: version === 2 ? "gl2" : "gl1",
    canvas,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 1.75),

    setPicture(id, d) {
      const data = new Float32Array(d.count * STRIDE);
      for (let i = 0, o = 0; i < d.count; i++, o += STRIDE) {
        data[o] = d.key[3 * i]; data[o + 1] = d.key[3 * i + 1]; data[o + 2] = d.key[3 * i + 2];
        data[o + 3] = d.vel[3 * i]; data[o + 4] = d.vel[3 * i + 1]; data[o + 5] = d.vel[3 * i + 2];
        data[o + 6] = d.size[2 * i]; data[o + 7] = d.size[2 * i + 1];
        data[o + 8] = d.col[3 * i]; data[o + 9] = d.col[3 * i + 1]; data[o + 10] = d.col[3 * i + 2];
      }
      const old = pictures.get(id);
      if (old && old.buffer && !lost) gl.deleteBuffer(old.buffer);
      const p = { data, count: d.count, buffer: null };
      if (!lost) upload(p);
      pictures.set(id, p);
    },

    resize(w, h) {
      // Stay within the GPU's limits (large monitors at high pixel ratios).
      const max = gl.getParameter(gl.MAX_VIEWPORT_DIMS) || [4096, 4096];
      this.pixelRatio = Math.min(Math.min(window.devicePixelRatio || 1, 1.75), max[0] / w, max[1] / h);
      canvas.width = Math.round(w * this.pixelRatio);
      canvas.height = Math.round(h * this.pixelRatio);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
    },

    render(f) {
      if (lost) return;
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(loc.uViewProj, false, f.viewProj);
      gl.uniform3f(loc.uCam, f.cam[0], f.cam[1], f.cam[2]);
      gl.uniform1f(loc.uPixel, f.pixel);
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.enableVertexAttribArray(loc.aCorner);
      gl.vertexAttribPointer(loc.aCorner, 2, gl.FLOAT, false, 0, 0);
      inst.divisor(loc.aCorner, 0);
      const B = 4 * STRIDE;
      for (const { id, clock } of f.pictures) {
        const p = pictures.get(id);
        if (!p || !p.count) continue;
        gl.bindBuffer(gl.ARRAY_BUFFER, p.buffer);
        for (const [name, n, off] of [["aKey", 3, 0], ["aVel", 3, 3], ["aSize", 2, 6], ["aColor", 3, 8]]) {
          gl.enableVertexAttribArray(loc[name]);
          gl.vertexAttribPointer(loc[name], n, gl.FLOAT, false, B, off * 4);
          inst.divisor(loc[name], 1);
        }
        gl.uniform1f(loc.uClock, clock);
        inst.draw(p.count);
      }
    },
  };
  if (!selfTest()) return null;
  container.appendChild(canvas);
  return api;
}
