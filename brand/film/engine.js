// Deterministic canvas engine: draw(t) redraws the whole frame from scratch for any t.
const W = 1920;
const H = 1080;
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");

const C = {
  bg: "#16181D",
  ink: "#F7F6F2",
  g1: "#9A9A9A",
  g2: "#5E5E5E",
  g3: "#2A2A2A",
  room: "#16181D",
  sky: "#202A44",
  panel: "#1F2229",
  panel2: "#2A2E37",
  track: "#12141A",
  line: "#343944",
  blue: "#5B8DEF",
  amber: "#F0B429",
  violet: "#B07CF0",
  green: "#3ECF7A",
  red: "#FF4B3A",
  orange: "#FF8A3D",
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const prog = (t, a, b) => clamp01((t - a) / (b - a));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = {
  linear: (p) => p,
  out_cubic: (p) => 1 - (1 - p) ** 3,
  in_cubic: (p) => p ** 3,
  in_out_cubic: (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
  in_out_sine: (p) => -(Math.cos(Math.PI * p) - 1) / 2,
  out_expo: (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
  in_expo: (p) => (p <= 0 ? 0 : 2 ** (10 * p - 10)),
  out_back: (p) => 1 + 2.2 * (p - 1) ** 3 + 1.2 * (p - 1) ** 2,
};
function spring_t(dt, damp = 7, freq = 2.2) {
  if (dt <= 0) return 0;
  return 1 - Math.exp(-damp * dt) * Math.cos(2 * Math.PI * freq * dt);
}
// keys: [[t, v0, v1, ...], ...]; eased between neighbouring keys, held outside them.
function track(t, keys, fn = ease.in_out_cubic) {
  if (t <= keys[0][0]) return keys[0].slice(1);
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const p = fn(prog(t, keys[i - 1][0], keys[i][0]));
      return keys[i].slice(1).map((v, k) => lerp(keys[i - 1][k + 1], v, p));
    }
  }
  return keys[keys.length - 1].slice(1);
}
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const sans = (w, s) => `${w} ${s}px Inter, sans-serif`;
const mono = (w, s) => `${w} ${s}px "DejaVu Sans Mono", monospace`;

function rr(x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
function fill_rr(x, y, w, h, r, col, a = 1) {
  ctx.save();
  ctx.globalAlpha *= a;
  rr(x, y, w, h, r);
  ctx.fillStyle = col;
  ctx.fill();
  ctx.restore();
}
function stroke_rr(x, y, w, h, r, col, lw) {
  rr(x, y, w, h, r);
  ctx.strokeStyle = col;
  ctx.lineWidth = lw;
  ctx.stroke();
}
function circle(x, y, r, col) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
}
// draws fn at alpha a without leaking state
function with_alpha(a, fn) {
  if (a <= 0.003) return;
  ctx.save();
  ctx.globalAlpha *= a;
  fn();
  ctx.restore();
}
function txt(s, x, y, o) {
  ctx.font = o.mono ? mono(o.w || 400, o.size) : sans(o.w || 500, o.size);
  ctx.fillStyle = o.color || C.ink;
  ctx.textAlign = o.align || "left";
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = `${o.ls || 0}px`;
  ctx.fillText(s, x, y);
  ctx.letterSpacing = "0px";
}
function txt_w(s, o) {
  ctx.font = o.mono ? mono(o.w || 400, o.size) : sans(o.w || 500, o.size);
  ctx.letterSpacing = `${o.ls || 0}px`;
  const w = ctx.measureText(s).width;
  ctx.letterSpacing = "0px";
  return w;
}

// Words rise out of a clip mask with a stagger; the exit lifts them out again.
function kinetic(str, x, y, t, t0, t1, o) {
  const words = str.split(" ");
  const gap = txt_w(" ", o);
  let cx = x;
  const lh = o.size * 1.4;
  words.forEach((wd, i) => {
    const ww = txt_w(wd, o);
    const pin = ease.out_cubic(prog(t, t0 + i * 0.07, t0 + i * 0.07 + 0.55));
    const pout = ease.in_cubic(prog(t, t1 + i * 0.04, t1 + i * 0.04 + 0.4));
    const dy = (1 - pin) * o.size * 1.3 - pout * o.size * 1.6;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - 6, y - o.size * 0.95, ww + 12, lh);
    ctx.clip();
    txt(wd, cx, y + dy, o);
    ctx.restore();
    cx += ww + gap;
  });
}
// One-line headline on a flat dark capsule, so it reads over the sky and the cloud alike.
function headline(str, t, t0, t1) {
  const o = { size: 76, w: 800, color: C.ink, ls: -1 };
  const w = txt_w(str, o);
  const pin = ease.out_cubic(prog(t, t0 - 0.1, t0 + 0.5));
  const pout = ease.in_cubic(prog(t, t1, t1 + 0.35));
  const a = pin * (1 - pout);
  if (a <= 0.003) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const x = 80;
  const y = 58;
  const bw = w + 76;
  with_alpha(a, () => fill_rr(x, y, bw, 96, 48, C.bg));
  ctx.beginPath();
  rr(x, y, bw, 96, 48);
  ctx.clip();
  kinetic(str, x + 38, y + 69, t, t0, t1, o);
  ctx.restore();
}

function press_amt(t, tc) {
  if (t < tc) return ease.in_out_sine(prog(t, tc - 0.12, tc));
  return 1 - ease.out_cubic(prog(t, tc, tc + 0.25));
}
function ripple(x, y, t, tc) {
  const p = prog(t, tc, tc + 0.55);
  if (p <= 0 || p >= 1) return;
  ctx.save();
  ctx.globalAlpha *= 1 - p;
  ctx.beginPath();
  ctx.arc(x, y, 12 + 60 * ease.out_cubic(p), 0, Math.PI * 2);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}
function draw_cursor(x, y, press = 0) {
  ctx.save();
  ctx.translate(x, y);
  const s = 1 - 0.12 * press;
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 34);
  ctx.lineTo(9, 26);
  ctx.lineTo(15, 40);
  ctx.lineTo(22, 37);
  ctx.lineTo(16, 24);
  ctx.lineTo(28, 24);
  ctx.closePath();
  ctx.fillStyle = C.ink;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = C.bg;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();
}

// Icons are hand-drawn paths.
function check_icon(cx, cy, s, col, p = 1, lw = 0) {
  const pts = [
    [-0.36, 0.02],
    [-0.1, 0.3],
    [0.38, -0.26],
  ];
  const l1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  const l2 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
  const d = (l1 + l2) * p;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (d <= l1) {
    const q = d / l1;
    ctx.lineTo(lerp(pts[0][0], pts[1][0], q), lerp(pts[0][1], pts[1][1], q));
  } else {
    ctx.lineTo(pts[1][0], pts[1][1]);
    const q = (d - l1) / l2;
    ctx.lineTo(lerp(pts[1][0], pts[2][0], q), lerp(pts[1][1], pts[2][1], q));
  }
  ctx.lineWidth = lw || 0.16;
  ctx.strokeStyle = col;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();
}
function check_badge(cx, cy, r, t, t0) {
  const sc = spring_t(t - t0, 9, 2.4);
  if (sc <= 0.01) return;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(sc, sc);
  circle(0, 0, r, C.green);
  check_icon(
    0,
    0,
    r * 1.15,
    C.bg,
    ease.out_cubic(prog(t, t0 + 0.05, t0 + 0.3)),
    0.2,
  );
  ctx.restore();
}
function lock_icon(cx, cy, s, col) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  fill_rr(-0.4, -0.05, 0.8, 0.6, 0.1, col);
  ctx.beginPath();
  ctx.arc(0, -0.05, 0.25, Math.PI, 0);
  ctx.lineWidth = 0.14;
  ctx.strokeStyle = col;
  ctx.stroke();
  ctx.restore();
}
function link_icon(cx, cy, s, col) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.lineWidth = 0.17;
  ctx.strokeStyle = col;
  rr(-0.62, -0.22, 0.7, 0.44, 0.22);
  ctx.stroke();
  rr(-0.08, -0.22, 0.7, 0.44, 0.22);
  ctx.stroke();
  ctx.restore();
}
function pr_icon(cx, cy, s, col) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.strokeStyle = col;
  ctx.lineWidth = 0.14;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  [
    [-0.4, -0.5],
    [-0.4, 0.5],
    [0.4, 0.5],
  ].forEach(([x, y]) => {
    ctx.beginPath();
    ctx.arc(x, y, 0.15, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.beginPath();
  ctx.moveTo(-0.4, -0.35);
  ctx.lineTo(-0.4, 0.35);
  ctx.moveTo(0.4, 0.35);
  ctx.lineTo(0.4, -0.15);
  ctx.quadraticCurveTo(0.4, -0.35, 0.2, -0.35);
  ctx.lineTo(0.0, -0.35);
  ctx.moveTo(0.12, -0.5);
  ctx.lineTo(-0.04, -0.35);
  ctx.lineTo(0.12, -0.2);
  ctx.stroke();
  ctx.restore();
}
function spinner(cx, cy, r, ang, col) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(247,246,242,0.18)";
  ctx.lineWidth = r * 0.26;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r, ang, ang + Math.PI * 0.55);
  ctx.strokeStyle = col;
  ctx.lineCap = "round";
  ctx.stroke();
}
function progress_bar(x, y, w, h, p, col) {
  fill_rr(x, y, w, h, h / 2, C.track);
  if (p > 0.001) fill_rr(x, y, Math.max(h, w * p), h, h / 2, col);
}

// The mark and wordmark paths come from brand/ (embedded by build.py).
function draw_mark(cx, cy, size, col) {
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 32, size / 32);
  ctx.fillStyle = col;
  ctx.fill(new Path2D(LOGO.markd));
  ctx.restore();
}
function draw_lockup(cx, cy, width, p_mark, p_word, col) {
  const s = width / LOGO.vb[0];
  const h = LOGO.vb[1] * s;
  ctx.save();
  ctx.translate(cx - width / 2, cy - h / 2);
  ctx.scale(s, s);
  ctx.fillStyle = col;
  if (p_mark > 0.001) {
    const k = ease.out_back(clamp01(p_mark));
    const mx = LOGO.mark[0] + 16 * LOGO.mark[2];
    const my = LOGO.mark[1] + 16 * LOGO.mark[2];
    ctx.save();
    ctx.translate(mx, my);
    ctx.scale(k, k);
    ctx.translate(-mx, -my);
    ctx.translate(LOGO.mark[0], LOGO.mark[1]);
    ctx.scale(LOGO.mark[2], LOGO.mark[2]);
    ctx.fill(new Path2D(LOGO.markd));
    ctx.restore();
  }
  if (p_word > 0.001) {
    ctx.save();
    const q = ease.out_cubic(clamp01(p_word));
    ctx.beginPath();
    ctx.rect(30 * 1, 0, 60 * q + 1, 35);
    ctx.clip();
    ctx.translate(LOGO.word[0] - 5 * (1 - q), LOGO.word[1]);
    ctx.scale(LOGO.word[2], LOGO.word[2]);
    ctx.globalAlpha *= q;
    ctx.fill(new Path2D(LOGO.wordd));
    ctx.restore();
  }
  ctx.restore();
}
