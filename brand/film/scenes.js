// One continuous world drawn through a moving camera. Every scene function reads only t.

const WIN = { w: 660, h: 335 };
const WIN_S = 0.72; // size of a bot window on the laptop screen
// Eight bots, each with its own heavy step. `at` is the window centre on the laptop screen.
const AGENTS = [
  {
    title: "bot · docs",
    job: "install",
    col: C.blue,
    at: [-440, -170],
    log: [
      "pnpm install",
      "resolving packages",
      "fetching tarballs",
      "linking deps",
    ],
  },
  {
    title: "bot · api",
    job: "build",
    col: C.amber,
    at: [-85, -225],
    log: ["pnpm build", "compiling", "bundling", "writing output"],
  },
  {
    title: "bot · web",
    job: "build",
    col: C.violet,
    at: [270, -175],
    log: ["pnpm build", "compiling", "bundling", "optimizing assets"],
  },
  {
    title: "bot · tests",
    job: "test",
    col: C.green,
    at: [-330, 45],
    log: [
      "pnpm test",
      "starting tests",
      "running suites",
      "collecting results",
    ],
  },
  {
    title: "bot · lint",
    job: "lint",
    col: C.blue,
    at: [55, -20],
    log: ["pnpm lint", "checking files", "checking types", "formatting"],
  },
  {
    title: "bot · design",
    job: "install",
    col: C.amber,
    at: [440, 45],
    log: [
      "pnpm install",
      "fetching tarballs",
      "linking deps",
      "building tokens",
    ],
  },
  {
    title: "bot · deps",
    job: "install",
    col: C.violet,
    at: [-150, 235],
    log: [
      "pnpm install",
      "resolving packages",
      "fetching tarballs",
      "linking deps",
    ],
  },
  {
    title: "bot · e2e",
    job: "test",
    col: C.green,
    at: [255, 255],
    log: [
      "pnpm test:e2e",
      "starting browser",
      "running suites",
      "collecting results",
    ],
  },
];
const N_BOTS = AGENTS.length;
const ROW_NAMES = ["Claude Code", "CI", "tests"];
const SPR_W = 320;
const SPR_H = 250;

// ---- phases of the overload --------------------------------------------------
const arrive = (i) => T.spawn[i] + 0.1 + T.token; // when bot i's token reaches CPU (MEM is 0.12 s later)
const load_at = (t, lag = 0) =>
  T.bot_w.reduce(
    (s, w, i) =>
      s + w * ease.out_cubic(prog(t, arrive(i) + lag, arrive(i) + lag + 0.4)),
    0,
  );
const heat_raw = (t) => ease.in_out_sine(clamp01((load_at(t) - 0.2) / 0.8));
const calm_p = (t) => ease.in_out_cubic(prog(t, T.calm[0], T.calm[1]));
const heat = (t) => heat_raw(t) * (1 - calm_p(t));
const lerp_col = (a, b, p) => {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, k) => Math.round(lerp(v, pb[k], p))).join(",")})`;
};
const meter_col = (v) =>
  v < 0.6
    ? lerp_col(C.green, C.amber, v / 0.6)
    : lerp_col(C.amber, C.red, (v - 0.6) / 0.4);
const cpu_val = (t) => {
  const idle = 0.2 + 0.03 * Math.sin(t * 1.3);
  const up = lerp(idle, 0.99, load_at(t));
  return lerp(up, 0.1 + 0.02 * Math.sin(t * 1.1), calm_p(t));
};
const mem_val = (t) => {
  const idle = 0.28 + 0.03 * Math.sin(t * 0.9 + 1);
  const up = lerp(idle, 0.97, load_at(t, 0.12));
  return lerp(up, 0.16 + 0.02 * Math.sin(t * 0.8), calm_p(t));
};

// seconds of work an agent window has done; it slows with the heat, stops at the freeze and resumes once lifted
function alive(i, t) {
  let a = 0;
  for (let u = T.spawn[i] + 0.05; u < t; u += 0.1) {
    const r = u < T.freeze ? 1 - 0.85 * heat_raw(u) : u >= T.lift[i] ? 1 : 0;
    a += r * 0.1;
  }
  return a;
}
const drift = (t) => 7 * Math.sin(t * 0.55);

// ---- agent windows ---------------------------------------------------------------
function agent_window(i, x, y, s, rot, t, a_alive, grey) {
  const g = AGENTS[i];
  const h_ = heat(t);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(s, s);
  ctx.translate(-WIN.w / 2, -WIN.h / 2);
  fill_rr(0, 0, WIN.w, WIN.h, 16, C.panel);
  ctx.save();
  rr(0, 0, WIN.w, WIN.h, 16);
  ctx.clip();
  ctx.fillStyle = C.panel2;
  ctx.fillRect(0, 0, WIN.w, 48);
  [26, 48, 70].forEach((dx) => circle(dx, 24, 6, C.g2));
  txt(g.title, 100, 33, { size: 26, w: 700 });
  // the heavy step this bot just started
  const flash = 1 - ease.out_cubic(prog(t, T.spawn[i] + 0.1, T.spawn[i] + 1.0));
  fill_rr(WIN.w - 232, 10, 150, 30, 15, lerp_col(C.track, C.amber, flash));
  txt(g.job, WIN.w - 157, 32, {
    size: 20,
    w: 700,
    align: "center",
    color: lerp_col(C.g1, C.bg, flash),
  });
  const col = lerp_col(g.col, C.orange, h_ * 0.85);
  spinner(WIN.w - 36, 24, 9, 4 * a_alive, col);
  const p = clamp01(0.1 + 0.052 * a_alive);
  progress_bar(28, 74, WIN.w - 56, 14, p, col);
  ctx.save();
  ctx.beginPath();
  ctx.rect(20, 104, WIN.w - 40, 212);
  ctx.clip();
  const L = a_alive * 1.1 + i * 2;
  const idx = Math.floor(L);
  const fr = L - idx;
  for (let j = 0; j < 6; j++) {
    const k = idx - j;
    const line = g.log[((k % g.log.length) + g.log.length) % g.log.length];
    const ly = 290 - j * 38 + (1 - fr) * 38;
    const al = j === 0 ? fr : j === 5 ? 1 - fr : 1;
    with_alpha(al * (j === 0 ? 1 : 0.35 + 0.65 * (1 - j / 5)), () => {
      txt(`> ${line}`, 30, ly, {
        mono: true,
        size: 22,
        color: j <= 1 ? C.ink : C.g1,
      });
    });
  }
  ctx.restore();
  if (grey > 0.003) {
    ctx.fillStyle = `rgba(112,118,130,${0.62 * grey})`;
    ctx.fillRect(0, 0, WIN.w, WIN.h);
  }
  ctx.restore();
  ctx.save();
  stroke_rr(
    0,
    0,
    WIN.w,
    WIN.h,
    16,
    lerp_col("#343944", C.orange, h_),
    2 + 2 * h_,
  );
  ctx.restore();
  ctx.restore();
}

function slot_center(i) {
  return AGENTS[i].at;
}
// the sprite a bot lands in: bots 0-3 take the four sprites, bots 4-7 share them
const spr_of = (i) => i % 4;
function sprite_pos(sp, t) {
  return [sp.x, sp.y + drift(t)];
}
// where window i is at time t: on the laptop, flying to its sprite, or gone (landed)
function window_pose(i, t) {
  const t0 = T.lift[i];
  const t1 = t0 + T.flight;
  const [cx, cy] = slot_center(i);
  if (t < T.spawn[i]) return null;
  if (t < t0) {
    const A =
      5 *
      ease.in_out_sine(prog(t, T.shake[0], T.shake[0] + 1.0)) *
      (1 - ease.in_out_sine(prog(t, T.freeze - 0.3, T.freeze + 0.2)));
    const pop = Math.max(spring_t(t - T.spawn[i], 11, 2.4), 0.01);
    return {
      x: cx + A * Math.sin(t * 38 + i * 1.7),
      y: cy + A * 0.6 * Math.sin(t * 31 + i),
      s: WIN_S * Math.min(pop, 1.06),
      rot: 0,
      flying: false,
    };
  }
  if (t >= t1) return null;
  const p = ease.in_out_cubic(prog(t, t0, t1));
  const sp = SPR[spr_of(i)];
  const [sx0, sy0] = sprite_pos(sp, t);
  const sx = sx0 + (i < 4 ? -72 : 72);
  const sy = sy0 + 80;
  const mx = (cx + sx) / 2 + (cx < 0 ? -380 : 380) * (i % 2 === 0 ? 1 : 0.7);
  const my = Math.min(cy, sy) - 320 - i * 40;
  const u = 1 - p;
  const x = u * u * cx + 2 * u * p * mx + p * p * sx;
  const y = u * u * cy + 2 * u * p * my + p * p * sy;
  const s = lerp(WIN_S, 132 / WIN.w, ease.in_out_cubic(prog(p, 0.25, 1)));
  return {
    x,
    y,
    s,
    rot: 0.06 * Math.sin(Math.PI * p) * (i % 2 ? 1 : -1),
    flying: true,
  };
}

// ---- the laptop ----------------------------------------------------------------------
const METER = {
  y: -385,
  cpu: { x: 130, w: 240 },
  mem: { x: 470, w: 230 },
};
function draw_laptop(t) {
  const h_ = heat(t);
  fill_rr(-740, -430, 1480, 860, 40, C.g3);
  fill_rr(-820, 436, 1640, 36, 18, "#3A3A3A");
  fill_rr(-110, 436, 220, 14, 7, C.g3);
  fill_rr(-710, -400, 1420, 800, 16, "#1B2230");
  // wallpaper shapes and the menu bar with the CPU and memory meters
  ctx.save();
  rr(-710, -400, 1420, 800, 16);
  ctx.clip();
  circle(-380, 230, 260, "#202B3E");
  circle(420, -120, 200, "#1F293B");
  ctx.fillStyle = "#10131A";
  ctx.fillRect(-710, -400, 1420, 44);
  ctx.restore();
  const c = cpu_val(t);
  const m = mem_val(t);
  txt("CPU", METER.cpu.x - 62, -368, { size: 22, w: 700, color: C.g1 });
  progress_bar(METER.cpu.x, METER.y, METER.cpu.w, 16, c, meter_col(c));
  txt("MEM", METER.mem.x - 62, -368, { size: 22, w: 700, color: C.g1 });
  progress_bar(METER.mem.x, METER.y, METER.mem.w, 16, m, meter_col(m));
  // heat: a warm tint and a hot edge
  if (h_ > 0.003) {
    ctx.fillStyle = `rgba(255,120,40,${0.09 * h_})`;
    rr(-710, -400, 1420, 800, 16);
    ctx.fill();
    stroke_rr(
      -710,
      -400,
      1420,
      800,
      16,
      `rgba(255,75,58,${h_ * (0.75 + 0.25 * Math.sin(t * 5))})`,
      10,
    );
  }
}

// once the work has left, the laptop shows its own idle meters, large enough to read from the wide shot
function draw_idle(t) {
  const a = ease.out_cubic(prog(t, T.calm[1] + 0.2, T.calm[1] + 0.9));
  if (a <= 0.003) return;
  with_alpha(a, () => {
    fill_rr(-330, -120, 660, 260, 22, C.panel);
    stroke_rr(-330, -120, 660, 260, 22, C.line, 2);
    circle(-290, -76, 9, C.green);
    txt("Idle", -268, -66, { size: 34, w: 700 });
    [
      ["CPU", cpu_val(t)],
      ["MEM", mem_val(t)],
    ].forEach(([n, v], k) => {
      const y = -10 + k * 70;
      txt(n, -290, y + 14, { size: 28, w: 700, color: C.g1 });
      progress_bar(-190, y, 460, 22, v, meter_col(v));
    });
  });
}

function draw_windows(t) {
  AGENTS.forEach((_, i) => {
    const w = window_pose(i, t);
    if (!w) return;
    const a_ = alive(i, t);
    const grey =
      prog(t, T.freeze, T.freeze + 0.6) *
      (1 - prog(t, T.lift[i], T.lift[i] + 1.0));
    agent_window(i, w.x, w.y, w.s, w.rot, t, a_, grey);
  });
}

// each new bot sends a "+" to the CPU meter and another to the memory meter: the cause, drawn
function token_pos(i, t, lag, dest) {
  const u = (t - T.spawn[i] - 0.1 - lag) / T.token;
  if (u < 0 || u > 1) return null;
  const e = ease.in_out_cubic(u);
  const [sx, sy] = AGENTS[i].at;
  return [
    lerp(sx, dest[0], e),
    lerp(sy - 40, dest[1], e) - 70 * Math.sin(Math.PI * e),
    u,
  ];
}
function draw_tokens(t) {
  const kinds = [
    ["cpu", 0, C.amber, cpu_val],
    ["mem", 0.12, C.blue, mem_val],
  ];
  for (let i = 0; i < N_BOTS; i++) {
    // a ring where the bot appears
    const ra = prog(t, T.spawn[i], T.spawn[i] + 0.5);
    if (ra > 0 && ra < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - ra;
      ctx.beginPath();
      ctx.arc(
        AGENTS[i].at[0],
        AGENTS[i].at[1],
        50 + 130 * ease.out_cubic(ra),
        0,
        Math.PI * 2,
      );
      ctx.strokeStyle = AGENTS[i].col;
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.restore();
    }
    for (const [k, lag, col, val] of kinds) {
      const m = METER[k];
      const dest = [m.x + m.w * val(arrive(i) + lag + 0.4), METER.y + 8];
      for (let tr = 5; tr >= 0; tr--) {
        const p = token_pos(i, t - tr * 0.035, lag, dest);
        if (!p) continue;
        const a = tr === 0 ? 1 : 0.32 * (1 - tr / 6);
        with_alpha(a, () => circle(p[0], p[1], tr === 0 ? 17 : 11 - tr, col));
        if (tr === 0) {
          with_alpha(1, () => {
            ctx.fillStyle = C.bg;
            ctx.fillRect(p[0] - 9, p[1] - 2, 18, 4);
            ctx.fillRect(p[0] - 2, p[1] - 9, 4, 18);
          });
        }
      }
      // a ring on the meter when the "+" lands
      const la = prog(t, arrive(i) + lag, arrive(i) + lag + 0.45);
      if (la > 0 && la < 1) {
        ctx.save();
        ctx.globalAlpha = 1 - la;
        ctx.beginPath();
        ctx.arc(dest[0], dest[1], 10 + 34 * ease.out_cubic(la), 0, Math.PI * 2);
        ctx.strokeStyle = col;
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.restore();
      }
    }
  }
}

function draw_dialog(t) {
  const p = spring_t(t - T.dialog, 10, 2.2);
  const out = prog(t, T.dialog_out - 0.4, T.dialog_out);
  if (p <= 0.01 || out >= 1) return;
  ctx.save();
  ctx.globalAlpha *= 1 - out;
  ctx.translate(0, 20);
  ctx.scale(Math.min(p, 1.04), Math.min(p, 1.04));
  fill_rr(-290, -125, 580, 250, 22, C.panel2);
  stroke_rr(-290, -125, 580, 250, 22, C.red, 3);
  spinner(-200, 0, 34, 4 * T.dialog + 0.6, C.ink);
  txt("Not responding", -140, 14, { size: 44, w: 700 });
  fill_rr(-140, 44, 320, 12, 6, C.track);
  ctx.restore();
}

// ---- the cloud and its sprites -------------------------------------------------------
const SPR = [];
[-540, -180, 180, 540].forEach((x, i) =>
  SPR.push({ x, y: -1560, tag: "", agent: i, appear: 0 }),
);
[
  [-360, "web", "sprite_web"],
  [0, "api", "sprite_api"],
  [360, "docs", "sprite_docs"],
].forEach(([x, tag, key], k) =>
  SPR.push({ x, y: -1260, tag, agent: -1, appear: T[key], key, k }),
);

function draw_cloud(t) {
  const dy = drift(t);
  ctx.save();
  ctx.translate(0, dy);
  ctx.fillStyle = C.ink;
  rr(-1010, -1800, 2020, 710, 230);
  ctx.fill();
  [
    [-700, -1800, 230],
    [-300, -1900, 300],
    [250, -1920, 320],
    [700, -1820, 240],
    [900, -1720, 180],
  ].forEach(([x, y, r]) => circle(x, y, r, C.ink));
  // the "Sky" badge sits in the cloud's right margin, clear of the top edge and the sprites
  // (x >= 790 keeps it out of the rise shot, whose view ends at x = 768)
  fill_rr(790, -1540, 210, 80, 40, C.bg);
  draw_mark(822, -1500, 40, C.ink);
  txt("Sky", 850, -1482, { size: 50, w: 800, ls: -1 });
  ctx.restore();
}

function row_spec(sp, k) {
  if (sp.agent >= 0) {
    const s = T.run + sp.agent * T.stagger + k * T.step;
    return { start: s, done: s + T.step };
  }
  if (sp.key === "sprite_web") {
    const starts = [T.web_run, T.web_done[0], T.web_done[1]];
    return {
      start: starts[k],
      done: T.web_done[k],
      pause: k === 0 ? [T.waiting, T.resumed] : null,
    };
  }
  const s = sp.appear + 0.5 + k * 0.85;
  return { start: s, done: s + 0.85 };
}

function sprite_done_t(sp) {
  return row_spec(sp, 2).done;
}

function draw_sprite(sp, t) {
  const landed = sp.agent >= 0 ? T.lift[sp.agent] + T.flight : sp.appear;
  const pop = sp.agent >= 0 ? 1 : spring_t(t - sp.appear, 9, 2.2);
  if (pop <= 0.01) return;
  const [cx, cy] = sprite_pos(sp, t);
  const all_done = t >= sprite_done_t(sp);
  const running = t >= landed - 0.2 && !all_done;
  ctx.save();
  ctx.translate(cx, cy);
  const k = Math.min(pop, 1.05);
  ctx.scale(k, k);
  fill_rr(-SPR_W / 2, -SPR_H / 2, SPR_W, SPR_H, 22, C.panel);
  stroke_rr(-SPR_W / 2, -SPR_H / 2, SPR_W, SPR_H, 22, C.line, 2);
  fill_rr(-SPR_W / 2 + 20, -SPR_H / 2 - 38, 132, 40, 10, C.bg);
  txt("sprite", -SPR_W / 2 + 86, -SPR_H / 2 - 9, {
    size: 24,
    w: 700,
    align: "center",
  });
  if (sp.tag)
    txt(sp.tag, -SPR_W / 2 + 168, -SPR_H / 2 - 10, {
      mono: true,
      size: 24,
      w: 700,
      color: C.g1,
    });
  const pulse = 0.65 + 0.35 * Math.sin(t * 5);
  const lc = all_done ? C.green : running ? C.amber : C.g2;
  with_alpha(running ? pulse : 1, () =>
    circle(SPR_W / 2 - 34, -SPR_H / 2 - 18, 9, lc),
  );
  // rows: Claude Code, CI, tests
  for (let r = 0; r < 3; r++) {
    const spec = row_spec(sp, r);
    const y0 = -SPR_H / 2 + 22 + r * 52;
    const started = t >= spec.start;
    const done = t >= spec.done;
    const waiting = spec.pause && t >= spec.pause[0] && t < spec.pause[1];
    const border = done
      ? C.green
      : waiting
        ? C.amber
        : started
          ? C.amber
          : C.line;
    fill_rr(-SPR_W / 2 + 22, y0, 236, 42, 21, C.panel2);
    stroke_rr(-SPR_W / 2 + 22, y0, 236, 42, 21, border, 3);
    txt(ROW_NAMES[r], -SPR_W / 2 + 44, y0 + 29, {
      size: 22,
      w: 600,
      color: started ? C.ink : C.g2,
    });
    if (waiting) {
      fill_rr(SPR_W / 2 - 62, y0 + 9, 7, 24, 3, C.amber);
      fill_rr(SPR_W / 2 - 49, y0 + 9, 7, 24, 3, C.amber);
    } else if (started && !done) {
      spinner(SPR_W / 2 - 46, y0 + 21, 11, t * 5 + r, C.amber);
    }
    if (done) check_badge(SPR_W / 2 - 46, y0 + 21, 17, t, spec.done);
  }
  // the agent window that landed here, shrunk to a status strip
  // sprites in the top row hold two bots each; the extra sprites hold one
  const strips =
    sp.agent >= 0
      ? [sp.agent, sp.agent + 4]
      : [{ title: "claude code", col: C.blue }];
  strips.forEach((b, n) => {
    const bot = typeof b === "number" ? AGENTS[b] : b;
    const lt = typeof b === "number" ? T.lift[b] + T.flight : sp.appear + 0.15;
    if (typeof b === "number" && t < lt) return;
    const sc =
      typeof b === "number"
        ? 1 +
          0.06 *
            Math.exp(-8 * Math.max(0, t - lt)) *
            Math.abs(Math.cos(20 * (t - lt)))
        : 1;
    const solo = strips.length === 1;
    const w = solo ? 280 : 136;
    const x0 = solo ? 0 : n === 0 ? -72 : 72;
    ctx.save();
    ctx.translate(x0, 80);
    ctx.scale(sc, sc);
    fill_rr(-w / 2, -28, w, 56, 12, C.panel2);
    circle(-w / 2 + 14, -8, 4, C.g2);
    txt(bot.title, -w / 2 + 26, -2, { size: solo ? 20 : 15, w: 600 });
    const pall =
      typeof b === "number"
        ? clamp01((t - row_spec(sp, 0).start) / (3 * T.step))
        : clamp01(
            (t - row_spec(sp, 0).start) /
              (row_spec(sp, 2).done - row_spec(sp, 0).start),
          );
    progress_bar(
      -w / 2 + 14,
      12,
      w - 28,
      8,
      t >= lt ? lerp(0.25, 1, pall) : 0.25,
      bot.col,
    );
    ctx.restore();
  });
  ctx.restore();
}

// ---- Sky's surfaces: terminal, agent list, request, toasts, pull request ---------------------
function type_prog(t, a, b, s) {
  return Math.floor(s.length * clamp01((t - a) / (b - a)) + 0.0001);
}
function slide_in(t, t0, dy = 60) {
  const p = ease.out_expo(prog(t, t0, t0 + 0.7));
  return { a: ease.out_cubic(prog(t, t0, t0 + 0.35)), dy: (1 - p) * dy };
}
const CMD = (env) => `sky agent start ${env} --prompt=@task.md`;

function draw_terminal(t) {
  const sl = slide_in(t, T.type1[0] - 0.5);
  if (sl.a <= 0.003) return;
  with_alpha(sl.a, () => {
    ctx.save();
    ctx.translate(0, sl.dy);
    fill_rr(-930, -1030, 920, 260, 18, C.track);
    stroke_rr(-930, -1030, 920, 260, 18, C.line, 2);
    ctx.fillStyle = C.panel2;
    ctx.save();
    rr(-930, -1030, 920, 260, 18);
    ctx.clip();
    ctx.fillRect(-930, -1030, 920, 44);
    ctx.restore();
    [-904, -882, -860].forEach((x) => circle(x, -1008, 6, C.g2));
    txt("terminal", -830, -1000, { mono: true, size: 20, color: C.g1 });
    const lines = [
      [CMD("web"), T.type1[0], T.type1[1], "web"],
      [CMD("api"), T.type2[0], T.type2[1]],
      [CMD("docs"), T.type3[0], T.type3[1]],
    ];
    lines.forEach(([s, a, b], k) => {
      if (t < a - 0.05) return;
      const n = type_prog(t, a, b, s);
      const y = -950 + k * 54;
      txt("$", -902, y, { mono: true, size: 26, w: 700, color: C.green });
      txt(s.slice(0, n), -868, y, { mono: true, size: 26 });
      const last =
        k === 2 ||
        (k === 1 && t < T.type3[0] - 0.05) ||
        (k === 0 && t < T.type2[0] - 0.05);
      if (last && Math.floor(t * 2.2) % 2 === 0)
        fill_rr(
          -868 + txt_w(s.slice(0, n), { mono: true, size: 26 }) + 3,
          y - 22,
          14,
          28,
          2,
          C.ink,
        );
    });
    ctx.restore();
  });
}

function agent_state(row, t) {
  if (row === 0) {
    if (t < T.web_run) return ["starting", C.g1];
    if (t < T.waiting) return ["running", C.green];
    if (t < T.resumed) return ["waiting_approval", C.amber];
    if (t < sprite_done_t(SPR[4])) return ["running", C.green];
    return ["finished", C.g1];
  }
  const sp = SPR[row + 4];
  if (t < sprite_done_t(sp)) return ["running", C.green];
  return ["finished", C.g1];
}

function draw_list(t) {
  const sl = slide_in(t, T.list_in - 0.3);
  if (sl.a <= 0.003) return;
  with_alpha(sl.a, () => {
    ctx.save();
    ctx.translate(0, sl.dy);
    fill_rr(-930, -740, 920, 180, 18, C.track);
    stroke_rr(-930, -740, 920, 180, 18, C.line, 2);
    txt("$ sky agent list", -902, -698, { mono: true, size: 22, color: C.g1 });
    const rows = [
      ["agt_7f3k", "web", T.list_in],
      ["agt_2m8q", "api", T.sprite_api + 0.1],
      ["agt_9c1d", "docs", T.sprite_docs + 0.1],
    ];
    rows.forEach(([id, env, a], k) => {
      const p = ease.out_cubic(prog(t, a, a + 0.4));
      if (p <= 0) return;
      const [st, col] = agent_state(k, t);
      with_alpha(p, () => {
        const y = -650 + k * 40;
        txt(id, -902, y, { mono: true, size: 24 });
        circle(-664, y - 8, 7, col);
        txt(st, -644, y, {
          mono: true,
          size: 24,
          color: col === C.g1 ? C.g1 : C.ink,
        });
        txt(env, -330, y, { mono: true, size: 24, color: C.g1 });
        if (st === "waiting_approval")
          txt("1 open request", -250, y, {
            mono: true,
            size: 20,
            color: C.amber,
          });
      });
    });
    ctx.restore();
  });
}

const APPROVE = [825, -745];
function cursor_path_approve(t) {
  return track(t, [
    [T.cursor_approve[0] - 0.3, 1180, -420],
    [T.cursor_approve[1], APPROVE[0], APPROVE[1]],
    [T.click + 0.9, 905, -640],
  ]);
}

function draw_request(t) {
  const t_in = T.request;
  const t_out = T.resumed + 0.7;
  const sl = slide_in(t, t_in);
  const gone = ease.in_cubic(prog(t, t_out, t_out + 0.4));
  if (sl.a <= 0.003 || gone >= 1) return;
  with_alpha(sl.a * (1 - gone), () => {
    ctx.save();
    ctx.translate(gone * 60, sl.dy);
    fill_rr(50, -1030, 880, 330, 22, C.panel);
    stroke_rr(50, -1030, 880, 330, 22, C.line, 2);
    const ok = t >= T.click + 0.1;
    circle(112, -962, 24, ok ? C.green : C.amber);
    if (ok)
      check_icon(
        112,
        -962,
        30,
        C.bg,
        ease.out_cubic(prog(t, T.click + 0.1, T.click + 0.4)),
        0.22,
      );
    else
      txt("!", 112, -950, { size: 34, w: 800, color: C.bg, align: "center" });
    txt(ok ? "Approved" : "Approval needed", 156, -950, { size: 38, w: 700 });
    txt("agt_7f3k wants to use Bash", 82, -888, {
      mono: true,
      size: 26,
      color: C.g1,
    });
    fill_rr(82, -850, 816, 12, 6, C.track);
    const pr = press_amt(t, T.click);
    fill_rr(540, -780, 170, 70, 35, C.panel2);
    stroke_rr(540, -780, 170, 70, 35, C.g2, 2);
    txt("Deny", 625, -735, { size: 30, w: 600, align: "center" });
    ctx.save();
    ctx.translate(APPROVE[0], APPROVE[1]);
    const s = 1 - 0.07 * pr;
    ctx.scale(s, s);
    fill_rr(
      -95,
      -35,
      190,
      70,
      35,
      ok ? lerp_col(C.green, "#2FB066", 0) : C.green,
    );
    txt("Approve", 0, 11, { size: 30, w: 700, color: C.bg, align: "center" });
    ctx.restore();
    ctx.restore();
  });
}

function draw_pr(t) {
  const sl = slide_in(t, T.pr);
  if (sl.a <= 0.003) return;
  with_alpha(sl.a, () => {
    ctx.save();
    ctx.translate(0, sl.dy);
    fill_rr(50, -1030, 880, 330, 22, C.panel);
    stroke_rr(50, -1030, 880, 330, 22, C.line, 2);
    pr_icon(108, -962, 40, C.green);
    txt("PR ready", 156, -950, { size: 38, w: 700 });
    ["CI", "tests"].forEach((n, k) => {
      const x = 82 + k * 190;
      fill_rr(x, -905, 170, 52, 26, C.panel2);
      txt(n, x + 24, -870, { size: 26, w: 600 });
      check_badge(x + 134, -879, 17, t, T.pr + 0.3 + k * 0.25);
    });
    const p = ease.out_cubic(prog(t, T.preview, T.preview + 0.5));
    with_alpha(p, () => {
      fill_rr(82, -820, 520, 70, 35, C.panel2);
      stroke_rr(82, -820, 520, 70, 35, C.g2, 2);
      link_icon(130, -785, 24, C.ink);
      txt("Preview link", 172, -774, { size: 30, w: 600 });
      lock_icon(560, -785, 26, C.g1);
    });
    ctx.restore();
  });
}

function draw_toast(t, t0, label, kind) {
  const sl = slide_in(t, t0, 40);
  const sp = spring_t(t - t0, 9, 2.0);
  if (sl.a <= 0.003) return;
  with_alpha(sl.a, () => {
    ctx.save();
    ctx.translate(lerp(160, 0, Math.min(sp, 1.0)), 0);
    fill_rr(50, kind === 0 ? -640 : -548, 880, 76, 38, C.panel);
    stroke_rr(50, kind === 0 ? -640 : -548, 880, 76, 38, C.line, 2);
    check_badge(100, (kind === 0 ? -640 : -548) + 38, 18, t, t0 + 0.1);
    txt(label, 140, (kind === 0 ? -640 : -548) + 50, { size: 32, w: 600 });
    ctx.restore();
  });
}

// ---- cursor ---------------------------------------------------------------------------
function cursor_at(t) {
  const [gx, gy] = [
    AGENTS[0].at[0] - 200 * WIN_S,
    AGENTS[0].at[1] - 143 * WIN_S,
  ];
  if (t >= T.cursor_in && t < T.grab + 0.9) {
    const p = track(t, [
      [T.cursor_in, 420, 520],
      [T.grab - 0.05, gx, gy],
    ]);
    if (t < T.grab + 0.05)
      return {
        x: p[0],
        y: p[1],
        press: press_amt(t, T.grab),
        a: ease.out_cubic(prog(t, T.cursor_in, T.cursor_in + 0.3)),
      };
    const w = window_pose(0, t);
    const q = clamp01((t - T.grab) / 0.8);
    return {
      x: w ? w.x - 200 * w.s : gx,
      y: w ? w.y - 143 * w.s : gy,
      press: press_amt(t, T.grab),
      a: 1 - ease.in_cubic(prog(t, T.grab + 0.45, T.grab + 0.9)),
    };
  }
  if (t >= T.cursor_approve[0] - 0.3 && t < T.click + 1.3) {
    const p = cursor_path_approve(t);
    return {
      x: p[0],
      y: p[1],
      press: press_amt(t, T.click),
      a:
        ease.out_cubic(
          prog(t, T.cursor_approve[0] - 0.3, T.cursor_approve[0]),
        ) *
        (1 - ease.in_cubic(prog(t, T.click + 0.8, T.click + 1.3))),
    };
  }
  return null;
}

// ---- camera -----------------------------------------------------------------------------
function camera(t) {
  if (t < T.cam_up[0]) {
    // one steady wide shot: all the bots and both meters stay in frame, clear of the headline band
    return [0, -50, 1.0];
  }
  if (t < T.cam_demo[0]) {
    return track(
      t,
      [
        [T.cam_up[0], 0, -50, 1.0],
        [T.cam_up[1], 0, -1500, 1.25],
      ],
      ease.in_out_cubic,
    );
  }
  if (t < T.cam_result[0])
    return track(t, [
      [T.cam_demo[0], 0, -1500, 1.25],
      [T.cam_demo[1], 0, -1195, 0.7],
    ]);
  if (t < T.cam_brand[0])
    return track(t, [
      [T.cam_result[0], 0, -1195, 0.7],
      [T.cam_result[1], 0, -920, 0.46],
    ]);
  return track(t, [
    [T.cam_brand[0], 0, -920, 0.46],
    [T.cam_brand[1], 0, -2800, 1.0],
  ]);
}

// ---- the film ------------------------------------------------------------------------------
function world(t) {
  ctx.fillStyle = C.sky;
  ctx.fillRect(-6000, -6000, 12000, 5360);
  ctx.fillStyle = C.room;
  ctx.fillRect(-6000, -640, 12000, 4000);
  draw_cloud(t);
  SPR.forEach((sp) => draw_sprite(sp, t));
  draw_terminal(t);
  draw_list(t);
  draw_request(t);
  draw_pr(t);
  draw_toast(t, T.toast1, "Tests passed", 0);
  draw_toast(t, T.toast2, "PR ready", 1);
  draw_laptop(t);
  draw_idle(t);
  draw_windows(t);
  draw_tokens(t);
  draw_dialog(t);
  const cu = cursor_at(t);
  if (cu) {
    if (cu.press > 0 || t > T.click) ripple(cu.x + 4, cu.y + 4, t, T.click);
    with_alpha(cu.a, () => draw_cursor(cu.x, cu.y, cu.press));
  }
  ripple(
    AGENTS[0].at[0] - 200 * WIN_S + 4,
    AGENTS[0].at[1] - 143 * WIN_S + 4,
    t,
    T.grab,
  );
}

function brand(t) {
  const p_mark = prog(t, T.lockup, T.lockup + 0.6);
  const p_word = prog(t, T.lockup + 0.25, T.lockup + 0.95);
  ctx.save();
  draw_lockup(0, -2930, 900, p_mark, p_word, C.ink);
  ctx.restore();
}

function hud(t) {
  const H_ = T.head;
  headline("Your bots all build on your laptop.", t, H_.a[0], H_.a[1]);
  headline("Your laptop can't keep up.", t, H_.b[0], H_.b[1]);
  headline("Hand it to Sky.", t, H_.c[0], H_.c[1]);
  headline("Sky keeps you in the loop.", t, H_.d[0], H_.d[1]);
  headline("Your machine stays free.", t, H_.e[0], H_.e[1]);
  // brand end card: tagline, address and the disclaimer
  const a_t = ease.out_cubic(prog(t, T.tagline, T.tagline + 0.6));
  const a_u = ease.out_cubic(prog(t, T.url, T.url + 0.5));
  const a_n = ease.out_cubic(prog(t, T.note, T.note + 0.8));
  with_alpha(a_t, () =>
    txt("Your Claude Code crew, in the cloud.", W / 2, 690, {
      size: 46,
      w: 600,
      align: "center",
    }),
  );
  with_alpha(a_u, () =>
    txt("github.com/salasjustin/sky", W / 2, 770, {
      size: 40,
      w: 500,
      align: "center",
      color: C.g1,
    }),
  );
  with_alpha(a_n, () => {
    const lines = [
      "Sky is an independent open-source project.",
      "Not affiliated with, endorsed by or sponsored by Anthropic or Fly.io.",
      "Claude Code and Fly.io Sprites are names of their respective owners.",
    ];
    lines.forEach((l, k) =>
      txt(l, W / 2, 900 + k * 40, {
        size: 28,
        w: 400,
        align: "center",
        color: C.g1,
      }),
    );
  });
}

function draw(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const [cx, cy, cz] = camera(t);
  ctx.setTransform(cz, 0, 0, cz, W / 2 - cx * cz, H / 2 - cy * cz);
  world(t);
  if (t > T.cam_brand[0] - 0.5) brand(t);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  hud(t);
}
