// Шёлковое полотно в hero. Физику считает sim/cloth.c (apple-a2) и пишет в
// assets/cloth.bin; здесь только воспроизведение. Все кадры лежат в float-текстуре,
// интерполяция между кадрами и нормали считаются в вершинном шейдере —
// на CPU за кадр меняется лишь пара uniform'ов.

const VS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 aGrid;                 // (col, row)
uniform sampler2D uFrames;     // x = col + row*cols, y = кадр; rgb = xyz
uniform ivec2 uSize;           // cols, rows
uniform int uFrameA, uFrameB;
uniform float uMix;
uniform vec2 uAspect;          // масштаб в clip-space
uniform vec3 uPlace;           // смещение x, y и масштаб
uniform vec3 uPointer;         // x, y в clip-space, сила
out vec3 vN;
out vec3 vT;
out vec2 vUv;
out float vDepth;

vec3 P(int c, int r) {
  c = clamp(c, 0, uSize.x - 1);
  r = clamp(r, 0, uSize.y - 1);
  int i = c + r * uSize.x;
  vec3 a = texelFetch(uFrames, ivec2(i, uFrameA), 0).xyz;
  vec3 b = texelFetch(uFrames, ivec2(i, uFrameB), 0).xyz;
  vec3 p = mix(a, b, uMix);
  return vec3(p.x, -p.y, p.z);   // y в файле вниз → вверх
}

void main() {
  int c = int(aGrid.x), r = int(aGrid.y);
  vec3 p = P(c, r);
  vec3 dx = P(c + 1, r) - P(c - 1, r);
  vec3 dy = P(c, r - 1) - P(c, r + 1);
  vT = normalize(dx);
  vN = normalize(cross(dx, dy));
  vUv = aGrid / vec2(uSize - 1);

  // лёгкий поворот к зрителю + перспектива
  float ca = cos(-0.42), sa = sin(-0.42);
  vec3 w = vec3(p.x * 1.25, p.y * 0.95, p.z * 0.6);
  w = vec3(ca * w.x + sa * w.z, w.y, -sa * w.x + ca * w.z);
  vN = vec3(ca * vN.x + sa * vN.z, vN.y, -sa * vN.x + ca * vN.z);
  vT = vec3(ca * vT.x + sa * vT.z, vT.y, -sa * vT.x + ca * vT.z);

  vec2 s = w.xy * uPlace.z + uPlace.xy;
  // курсор отталкивает ткань
  vec2 d = s - uPointer.xy;
  float push = uPointer.z * exp(-dot(d, d) * 6.0) * smoothstep(0.0, 0.25, vUv.y);
  w.z += push * 0.45;
  s += normalize(d + 1e-4) * push * 0.05;

  float persp = 1.0 / (1.0 - w.z * 0.22);
  vDepth = w.z;
  gl_Position = vec4(s * uAspect * persp, -w.z * 0.1, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vN;
in vec3 vT;
in vec2 vUv;
in float vDepth;
uniform vec3 uC0, uC1, uC2, uC3, uPaper;
uniform float uTime;
out vec4 o;

float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
}

// Абр-икат: полосы по основе с «размытым» рваным краем, как у узелкового крашения
vec3 ikat(vec2 uv) {
  float jag = (n(vec2(uv.y * 38.0, uv.x * 3.0)) - 0.5) * 0.06;
  float u = uv.x * 5.0 + jag + sin(uv.y * 6.2831 * 1.5) * 0.12;
  float band = fract(u);
  float id = floor(u);
  vec3 a = mod(id, 2.0) < 1.0 ? uC0 : uC2;
  vec3 b = mod(id, 3.0) < 1.0 ? uC1 : uC3;
  // ромб-«глаз» в центре полосы
  float diamond = abs(band - 0.5) * 2.0 + abs(fract(uv.y * 4.0 + id * 0.5) - 0.5) * 1.6;
  float m = smoothstep(0.55, 0.62 + jag, diamond);
  return mix(b, a, m);
}

void main() {
  vec3 N = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 T = normalize(vT);
  vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 H = normalize(L + V);

  vec3 base = ikat(vUv);
  if (!gl_FrontFacing) base *= 0.55;

  float diff = 0.32 + 0.68 * max(dot(N, L), 0.0);
  // анизотропный блеск шёлка (Kajiya–Kay вдоль нити)
  float th = dot(T, H);
  float aniso = pow(sqrt(max(1.0 - th * th, 0.0)), 70.0);
  float sheen = pow(1.0 - max(dot(N, V), 0.0), 3.0);

  vec3 col = base * diff + vec3(1.0, 0.93, 0.82) * aniso * 0.38 + base * sheen * 0.35;
  col = mix(uPaper, col, smoothstep(-0.9, 0.2, vDepth) * 0.25 + 0.75);
  // мягкая кромка по нижнему краю (без пилы)
  o = vec4(col, 1.0 - smoothstep(0.96, 1.0, vUv.y) * 0.85);
}`;

function cssColor(name, ctx) {
  // токены в OKLCH → sRGB через canvas (браузер сам конвертирует)
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = v || '#000';
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}

function parseBin(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'CFCL') throw new Error('cloth.bin: bad magic');
  const version = dv.getUint16(4, true);
  if (version !== 1 && version !== 2) throw new Error('cloth.bin: version ' + version);
  const cols = dv.getUint16(6, true), rows = dv.getUint16(8, true);
  const frames = dv.getUint16(10, true), fps = dv.getUint16(12, true) || 30;
  const n = cols * rows * frames * 3;
  if (buf.byteLength < 16 + n * 2) throw new Error('cloth.bin: truncated');
  const out = new Float32Array(cols * rows * frames * 4);
  const per = cols * rows * 3;            // int16 на кадр
  const acc = new Int32Array(per);        // v2: кадр 0 целиком, дальше дельты к предыдущему
  for (let i = 0, j = 0; i < n; i += 3, j += 4) {
    const k = i % per;
    for (let a = 0; a < 3; a++) {
      const v = dv.getInt16(16 + (i + a) * 2, true);
      acc[k + a] = version === 2 && i >= per ? ((acc[k + a] + v) << 16) >> 16 : v; // дельты по модулю 2^16
      out[j + a] = acc[k + a] / 32767;
    }
  }
  return { cols, rows, frames, fps, data: out };
}

// Запасной вариант, если cloth.bin ещё не собран: аналитические волны
function procedural() {
  const cols = 32, rows = 20, frames = 120, fps = 30;
  const data = new Float32Array(cols * rows * frames * 4);
  for (let f = 0; f < frames; f++) {
    const t = (f / frames) * Math.PI * 2;
    for (let r = 0; r < rows; r++) {
      const v = r / (rows - 1);
      for (let c = 0; c < cols; c++) {
        const u = c / (cols - 1);
        const k = ((f * rows + r) * cols + c) * 4;
        const amp = v * v;
        data[k] = u * 2 - 1 + Math.sin(t + v * 4) * 0.08 * amp;
        data[k + 1] = v * 2 - 1 - Math.abs(Math.sin(t + u * 3)) * 0.05 * amp;
        data[k + 2] = (Math.sin(t * 2 + u * 7 + v * 3) * 0.25 + Math.sin(t - u * 3 + v * 9) * 0.15) * amp;
      }
    }
  }
  return { cols, rows, frames, fps, data };
}

export async function initCloth(canvas, { reducedMotion = false } = {}) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance' });
  if (!gl) return null; // без WebGL2 остаётся тёмный фон — страница работает

  let cloth, source = 'bin';
  try {
    const res = await fetch('assets/cloth.bin');
    if (!res.ok) throw new Error(res.status);
    cloth = parseBin(await res.arrayBuffer());
  } catch {
    cloth = procedural(); source = 'procedural';
  }

  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const U = (n) => gl.getUniformLocation(prog, n);

  const { cols, rows, frames, fps } = cloth;
  // сетка
  const grid = new Float32Array(cols * rows * 2);
  for (let r = 0, k = 0; r < rows; r++) for (let c = 0; c < cols; c++) { grid[k++] = c; grid[k++] = r; }
  const idx = new Uint16Array((cols - 1) * (rows - 1) * 6);
  for (let r = 0, k = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const i = r * cols + c;
    idx.set([i, i + 1, i + cols, i + 1, i + cols + 1, i + cols], k); k += 6;
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, grid, gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aGrid');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

  // все кадры — одна текстура
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols * rows, frames, 0, gl.RGBA, gl.FLOAT, cloth.data);
  cloth.data = null;
  gl.uniform1i(U('uFrames'), 0);
  gl.uniform2i(U('uSize'), cols, rows);

  const cc = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  cc.canvas.width = cc.canvas.height = 1;
  const setColors = () => {
    gl.uniform3fv(U('uC0'), cssColor('--silk-1', cc));
    gl.uniform3fv(U('uC1'), cssColor('--silk-2', cc));
    gl.uniform3fv(U('uC2'), cssColor('--silk-3', cc));
    gl.uniform3fv(U('uC3'), cssColor('--color-ink', cc));
    gl.uniform3fv(U('uPaper'), cssColor('--color-paper', cc));
  };
  setColors();

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  const uFA = U('uFrameA'), uFB = U('uFrameB'), uMix = U('uMix'), uPtr = U('uPointer');
  const uAspect = U('uAspect'), uPlace = U('uPlace');

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    const a = w / h;
    // полотно справа на десктопе, сверху по центру на телефоне
    if (a > 1.1) { gl.uniform2f(uAspect, 1 / a, 1); gl.uniform3f(uPlace, a - 0.82, 0.18, 0.6); }
    else { gl.uniform2f(uAspect, 1, a); gl.uniform3f(uPlace, 0.0, 0.55 / a, 0.62); }
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  // курсор: позиция в clip-space, сила плавно затухает
  const ptr = { x: 9, y: 9, tx: 9, ty: 9, s: 0, ts: 0 };
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    const a = r.width / r.height;
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = 1 - ((e.clientY - r.top) / r.height) * 2;
    ptr.tx = a > 1.1 ? nx * a : nx; ptr.ty = a > 1.1 ? ny : ny / a;
    ptr.ts = 1;
  };
  canvas.parentElement.addEventListener('pointermove', onMove, { passive: true });
  canvas.parentElement.addEventListener('pointerleave', () => { ptr.ts = 0; }, { passive: true });

  let t0 = performance.now();
  const draw = (now) => {
    const t = reducedMotion ? 0 : ((now - t0) / 1000) * fps;
    const fa = Math.floor(t) % frames;
    gl.uniform1i(uFA, fa);
    gl.uniform1i(uFB, (fa + 1) % frames);
    gl.uniform1f(uMix, t - Math.floor(t));
    ptr.x += (ptr.tx - ptr.x) * 0.12; ptr.y += (ptr.ty - ptr.y) * 0.12; ptr.s += (ptr.ts - ptr.s) * 0.06;
    gl.uniform3f(uPtr, ptr.x, ptr.y, reducedMotion ? 0 : ptr.s);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
  };
  draw(t0);
  canvas.classList.add('is-ready');
  return { draw, setColors, source };
}
