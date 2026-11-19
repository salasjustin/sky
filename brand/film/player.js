// ?render exposes a bare canvas; with no query this is a scrubbable player.
const query = new URLSearchParams(location.search);
const POSTER_T = T.poster;
const CHAPTERS = [
  [0, "Outset"],
  [T.meters_up, "Problem"],
  [T.head.c[0], "Solution"],
  [T.head.d[0], "Demo"],
  [T.head.e[0], "Result"],
  [T.cam_brand[0], "Brand"],
];

async function load_fonts() {
  await Promise.all(
    ["400", "500", "600", "700", "800"].map((w) =>
      document.fonts.load(`${w} 40px Inter`),
    ),
  );
  await Promise.all(
    ["400", "700"].map((w) =>
      document.fonts.load(`${w} 24px "DejaVu Sans Mono"`),
    ),
  );
}

function start_render_mode() {
  document.body.classList.add("render");
  window.canvas = canvas;
  window.draw_at = (t) => {
    draw(t);
  };
  draw(0);
  window.reel_ready = true;
}

function start_player() {
  const audio = typeof SCORE !== "undefined" && SCORE ? new Audio(SCORE) : null;
  const bar = document.getElementById("bar");
  const play = document.getElementById("play");
  const snd = document.getElementById("snd");
  const track_el = document.getElementById("track");
  const fill = document.getElementById("fill");
  const label = document.getElementById("time");
  let playing = false;
  let t_cur = POSTER_T;
  let t_start = 0;
  let wall0 = 0;
  let muted = false;
  if (!audio) snd.style.display = "none";
  CHAPTERS.forEach(([t, name]) => {
    const m = document.createElement("i");
    m.style.left = `${(t / T.dur) * 100}%`;
    m.title = name;
    track_el.appendChild(m);
  });
  const show = (t) => {
    t_cur = Math.max(0, Math.min(T.dur, t));
    draw(t_cur);
    fill.style.width = `${(t_cur / T.dur) * 100}%`;
    label.textContent = `${t_cur.toFixed(1)} / ${T.dur.toFixed(1)} s`;
  };
  const tick = () => {
    if (!playing) return;
    const t =
      audio && !muted
        ? audio.currentTime
        : t_start + (performance.now() - wall0) / 1000;
    if (t >= T.dur) {
      playing = false;
      play.textContent = "Play";
      show(T.dur);
      return;
    }
    show(t);
    requestAnimationFrame(tick);
  };
  const toggle = () => {
    playing = !playing;
    play.textContent = playing ? "Pause" : "Play";
    if (playing) {
      if (t_cur >= T.dur - 0.05) t_cur = 0;
      t_start = t_cur;
      wall0 = performance.now();
      if (audio && !muted) {
        audio.currentTime = t_cur;
        audio.play();
      }
      requestAnimationFrame(tick);
    } else if (audio) audio.pause();
  };
  play.onclick = toggle;
  snd.onclick = () => {
    muted = !muted;
    snd.textContent = muted ? "Sound off" : "Sound on";
    if (muted && audio) audio.pause();
    else if (audio && playing) {
      audio.currentTime = t_cur;
      audio.play();
    }
    t_start = t_cur;
    wall0 = performance.now();
  };
  const seek = (e) => {
    const r = track_el.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * T.dur;
    show(t);
    t_start = t_cur;
    wall0 = performance.now();
    if (audio) audio.currentTime = t_cur;
  };
  let drag = false;
  track_el.onpointerdown = (e) => {
    drag = true;
    seek(e);
  };
  window.addEventListener("pointermove", (e) => drag && seek(e));
  window.addEventListener("pointerup", () => {
    drag = false;
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      toggle();
    }
  });
  bar.style.display = "flex";
  show(POSTER_T);
}

load_fonts().then(() => {
  if (query.has("render")) start_render_mode();
  else start_player();
});
