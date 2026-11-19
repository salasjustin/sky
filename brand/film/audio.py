"""Synthesize the score: sound effects on every visual cause, plus a sparse pad and pluck under them.

48 kHz stereo, two buses (music, sfx) and a reverb send. Every time comes from timeline.json,
the same file the picture reads. Writes out/score.wav and out/score.mp3.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import fftconvolve, lfilter, sosfilt, butter

ROOT = Path(__file__).parent
T = json.loads((ROOT / "timeline.json").read_text())
SR = 48000
DUR = T["dur"]
N = int(DUR * SR) + SR
rng = np.random.default_rng(7)

music = np.zeros((N, 2))
sfx = np.zeros((N, 2))
send = np.zeros(N)


def tgrid(d):
    return np.arange(int(d * SR)) / SR


def place(bus, t0, sig, pan=0.0, rev=0.0, gain=1.0):
    """Add a mono signal at t0 seconds with equal-power pan and an optional reverb send."""
    i = int(round(t0 * SR))
    if i < 0:
        sig = sig[-i:]
        i = 0
    n = min(len(sig), N - i)
    if n <= 0:
        return
    sig = sig[:n] * gain
    l = np.cos((pan + 1) * np.pi / 4)
    r = np.sin((pan + 1) * np.pi / 4)
    bus[i:i + n, 0] += sig * l
    bus[i:i + n, 1] += sig * r
    if rev:
        send[i:i + n] += sig * rev


def env_ad(n, a, d):
    t = np.arange(n) / SR
    return np.minimum(t / max(a, 1e-4), 1.0) * np.exp(-t / d)


def lp(x, fc, order=2):
    return sosfilt(butter(order, fc, "low", fs=SR, output="sos"), x)


def hp(x, fc, order=2):
    return sosfilt(butter(order, fc, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi):
    return sosfilt(butter(2, [lo, hi], "band", fs=SR, output="sos"), x)


def swept_bandpass(noise, f0, f1, q=2.5, block=256):
    """Block-wise resonant band-pass whose centre moves from f0 to f1 (log sweep)."""
    out = np.zeros_like(noise)
    zi = np.zeros(2)
    nb = int(np.ceil(len(noise) / block))
    for b in range(nb):
        s, e = b * block, min(len(noise), (b + 1) * block)
        f = f0 * (f1 / f0) ** (b / max(nb - 1, 1))
        w0 = 2 * np.pi * f / SR
        alpha = np.sin(w0) / (2 * q)
        bb = np.array([alpha, 0, -alpha])
        aa = np.array([1 + alpha, -2 * np.cos(w0), 1 - alpha])
        y, zi = lfilter(bb / aa[0], aa / aa[0], noise[s:e], zi=zi)
        out[s:e] = y
    return out


# ---- instruments -------------------------------------------------------------
def tick(t0, k=0, gain=0.5):
    n = int(0.05 * SR)
    t = np.arange(n) / SR
    burst = hp(rng.standard_normal(n), 2500) * np.exp(-t / 0.004)
    blip = np.sin(2 * np.pi * (2300 + 500 * (k % 3)) * t) * np.exp(-t / 0.006)
    place(sfx, t0, (burst * 0.7 + blip * 0.5), pan=0.1 * ((k % 5) - 2), rev=0.05, gain=gain)


def click(t0, gain=0.8, release=True):
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    thump = np.sin(2 * np.pi * (170 - 60 * t / 0.02) * t) * np.exp(-t / 0.012)
    snap = hp(rng.standard_normal(n), 3000) * np.exp(-t / 0.0025)
    place(sfx, t0, thump * 0.9 + snap * 0.7, rev=0.06, gain=gain)
    if release:
        m = int(0.06 * SR)
        u = np.arange(m) / SR
        rel = hp(rng.standard_normal(m), 4500) * np.exp(-u / 0.002) * 0.4
        place(sfx, t0 + 0.085, rel, rev=0.03, gain=gain)


def pop(t0, f=560, gain=0.6, pan=0.0, rev=0.12):
    n = int(0.22 * SR)
    t = np.arange(n) / SR
    ph = 2 * np.pi * (f * 0.42 * t + (f * 0.58 * 0.045) * (1 - np.exp(-t / 0.045)))
    sig = np.sin(ph) * np.exp(-t / 0.07) * np.minimum(t / 0.002, 1)
    sig += 0.25 * np.sin(2 * ph) * np.exp(-t / 0.03)
    place(sfx, t0, sig, pan=pan, rev=rev, gain=gain)


def chime(t0, f, gain=0.5, pan=0.0):
    n = int(1.4 * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for k, (m, a, d) in enumerate([(1, 1.0, 0.5), (2.0, 0.35, 0.3), (3.01, 0.16, 0.18), (4.2, 0.08, 0.1)]):
        sig += a * np.sin(2 * np.pi * f * m * t) * np.exp(-t / d)
    sig *= np.minimum(t / 0.003, 1)
    place(sfx, t0, sig, pan=pan, rev=0.35, gain=gain)


def whoosh(t0, d, f0, f1, gain=0.5, pan=0.0, peak=0.5):
    n = int(d * SR)
    t = np.arange(n) / SR
    sig = swept_bandpass(rng.standard_normal(n), f0, f1, q=1.6)
    p = t / d
    env = np.sin(np.pi * np.clip(p, 0, 1)) ** 1.5 * (1 - peak + peak * np.clip(p / 0.6, 0, 1))
    sig = sig / (np.abs(sig).max() + 1e-9) * env
    place(sfx, t0, sig, pan=pan, rev=0.2, gain=gain)


def riser(t0, d, gain=0.6):
    n = int(d * SR)
    t = np.arange(n) / SR
    noise = swept_bandpass(rng.standard_normal(n), 300, 7000, q=1.2)
    noise = noise / (np.abs(noise).max() + 1e-9)
    tone = np.sin(2 * np.pi * np.cumsum(180 * (10 ** (t / d * 0.95))) / SR)
    env = (t / d) ** 2.2
    place(sfx, t0, (noise * 0.7 + tone * 0.35) * env, rev=0.25, gain=gain)


def impact(t0, gain=0.9):
    n = int(1.6 * SR)
    t = np.arange(n) / SR
    sub = np.sin(2 * np.pi * (46 + 40 * np.exp(-t / 0.05)) * t) * np.exp(-t / 0.5)
    burst = lp(rng.standard_normal(n), 1800) * np.exp(-t / 0.08)
    place(sfx, t0, sub * 1.0 + burst * 0.45, rev=0.3, gain=gain)


def buzz(t0, d=0.45, f=140, gain=0.5):
    n = int(d * SR)
    t = np.arange(n) / SR
    sq = np.sign(np.sin(2 * np.pi * f * t * (1 - 0.15 * t / d))) * 0.5 + np.sign(np.sin(2 * np.pi * f * 1.5 * t)) * 0.25
    sig = lp(sq, 2400) * np.exp(-t / (d * 0.55)) * np.minimum(t / 0.003, 1)
    thump = np.sin(2 * np.pi * 70 * t) * np.exp(-t / 0.08)
    place(sfx, t0, sig + thump * 0.8, rev=0.1, gain=gain)


def arrive(i):
    """When bot i's "+" reaches the CPU meter: the picture's own formula."""
    return T["spawn"][i] + 0.1 + T["token"]


def load_curve(t):
    """The meters' load, a staircase with one eased step per bot (same weights and timing as scenes.js)."""
    out = np.zeros_like(t)
    for i, w in enumerate(T["bot_w"]):
        p = np.clip((t - arrive(i)) / 0.4, 0, 1)
        out += w * (1 - (1 - p) ** 3)
    return out


def strain_hum(t0, t1, fade_to, gain=0.28):
    """A strained mains hum plus fan noise that tightens as the meters climb and dies when the work leaves."""
    n = int((fade_to - t0) * SR)
    t = np.arange(n) / SR + t0
    heat = load_curve(t)
    stop = np.clip((t - T["lift"][0]) / (fade_to - T["lift"][0]), 0, 1)
    amp = (0.15 + 0.85 * heat) * (1 - stop) ** 2
    f0 = 52 + 14 * heat
    ph = 2 * np.pi * np.cumsum(f0) / SR
    wobble = 1 + (0.18 + 0.4 * heat) * np.sin(2 * np.pi * (5 + 9 * heat) * t)
    tone = (np.sin(ph) + 0.5 * np.sin(2 * ph) + 0.35 * np.sin(3 * ph + 0.4) + 0.2 * np.sign(np.sin(4 * ph))) * wobble
    fan = bp(rng.standard_normal(n), 300, 1800) * (0.25 + 0.9 * heat)
    dark, bright = lp(tone, 700), lp(tone, 2600)
    sig = (dark * (1 - heat) + bright * heat) * 0.55 + fan * 0.35
    sig *= amp * np.minimum((t - t0) / 0.6, 1.0)
    place(sfx, t0, sig, rev=0.05, gain=gain)


def pad(t0, t1, freqs, gain=0.12, fade=1.2):
    n = int((t1 - t0) * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for f in freqs:
        for det in (-0.004, 0.0, 0.004):
            sig += 2 * ((t * f * (1 + det)) % 1.0) - 1
    sig = lp(sig, 1100, 3) / (len(freqs) * 3)
    env = np.minimum(t / fade, 1) * np.minimum((t1 - t0 - t) / fade, 1)
    place(music, t0, sig * np.clip(env, 0, 1), rev=0.3, gain=gain)


def pluck(t0, f, gain=0.3, pan=0.0):
    n = int(1.2 * SR)
    t = np.arange(n) / SR
    sig = sum(a * np.sin(2 * np.pi * f * k * t) * np.exp(-t / d) for k, a, d in [(1, 1, 0.35), (2, 0.4, 0.2), (3, 0.2, 0.12)])
    place(music, t0, sig * np.minimum(t / 0.002, 1), pan=pan, rev=0.35, gain=gain)


def mf(m):
    return 440.0 * 2 ** ((m - 69) / 12)


# ---- the score, cue by cue ------------------------------------------------------------
CMD = ["sky agent start web --prompt=@task.md", "sky agent start api --prompt=@task.md", "sky agent start docs --prompt=@task.md"]


def typing(a, b, s, k0):
    for i in range(len(s)):
        tick(a + i * (b - a) / len(s), k0 + i, gain=0.35 + 0.1 * ((i * 7) % 3) / 2)


# headlines
for h in T["head"].values():
    whoosh(h[0] - 0.05, 0.5, 2500, 6000, gain=0.12, peak=0.3)

# outset: each new bot pops in, starts its step, and its "+" lands on the meters a beat later
for i, s in enumerate(T["spawn"]):
    pan = -0.7 + 1.4 * i / (len(T["spawn"]) - 1)
    pop(s, 560 + 45 * i, gain=0.32, pan=pan)
    tick(s + 0.1, i, gain=0.3)
    whoosh(s + 0.1, T["token"], 1800, 5200, gain=0.1, pan=pan, peak=0.5)
    pop(arrive(i), 760 + 70 * i, gain=0.22, pan=0.5, rev=0.2)

# problem: the strained hum steps up with each bot until the meters pin, then the freeze
strain_hum(T["spawn"][0], T["freeze"], T["lift"][0] + 1.0)
for t in np.arange(T["shake"][0], T["freeze"], 0.5):
    tick(t, int(t * 4), gain=0.18)
buzz(T["dialog"], 0.55, 135, 0.55)

# solution: cursor grab, windows leave, camera rises, windows land in sprites
click(T["grab"], 0.8)
whoosh(T["cam_up"][0] + 0.2, 2.6, 250, 3800, gain=0.55, peak=0.6)
for i, l in enumerate(T["lift"]):
    pan = -0.8 + 1.6 * i / (len(T["lift"]) - 1)
    whoosh(l, 0.5, 900, 3000, gain=0.16, pan=pan)
    pop(l + T["flight"], 520 + 40 * i, gain=0.34, pan=pan)
notes = [mf(m) for m in (72, 76, 79)]
for a in range(4):
    for k in range(3):
        d = T["run"] + a * T["stagger"] + (k + 1) * T["step"]
        chime(d, notes[k], gain=0.22 if a else 0.4, pan=-0.6 + 0.4 * a)
whoosh(T["cam_demo"][0], 1.4, 3500, 400, gain=0.35, peak=0.4)

# demo: the console
typing(T["type1"][0], T["type1"][1], CMD[0], 0)
tick(T["enter1"], 3, gain=0.6)
pop(T["sprite_web"], 640, gain=0.6)
tick(T["list_in"], 1, gain=0.3)
pop(T["request"], 480, gain=0.45)
pop(T["request"] + 0.12, 720, gain=0.35)
click(T["click"], 0.9)
chime(T["click"] + 0.12, mf(76), gain=0.4)
for k, t in enumerate(T["web_done"]):
    chime(t, notes[k % 3], gain=0.3)
pop(T["toast1"], 600, gain=0.4)
chime(T["toast1"] + 0.05, mf(79), gain=0.45)
pop(T["toast2"], 700, gain=0.4)
chime(T["toast2"] + 0.05, mf(83), gain=0.5)
pop(T["pr"], 520, gain=0.35)
pop(T["preview"], 800, gain=0.3)
typing(T["type2"][0], T["type2"][1], CMD[1], 5)
typing(T["type3"][0], T["type3"][1], CMD[2], 9)
pop(T["sprite_api"], 580, gain=0.55)
pop(T["sprite_docs"], 620, gain=0.55)
for s0 in (T["sprite_api"], T["sprite_docs"]):
    for k in range(3):
        chime(s0 + 0.5 + 0.85 * (k + 1), notes[k], gain=0.25)

# result and brand
whoosh(T["cam_result"][0], 1.6, 3000, 500, gain=0.4, peak=0.4)
riser(T["cam_brand"][0] + 0.2, T["lockup"] - T["cam_brand"][0] - 0.2, gain=0.55)
whoosh(T["cam_brand"][0] + 0.4, 2.0, 400, 4200, gain=0.3, peak=0.7)
impact(T["lockup"], 0.8)
chime(T["lockup"] + 0.05, mf(84), gain=0.3)

# sparse music: a pad that changes on the cuts, a few plucks on beats
BEAT = 0.5
pad(0.0, 5.0, [mf(48), mf(55), mf(63)], gain=0.10)
pad(5.0, 11.0, [mf(36), mf(37 + 12), mf(48)], gain=0.12)
pad(11.0, 19.0, [mf(51), mf(58), mf(67)], gain=0.12)
pad(19.0, 31.0, [mf(48), mf(55), mf(63), mf(70)], gain=0.09)
pad(31.0, 36.6, [mf(51), mf(58), mf(67)], gain=0.10)
pad(T["lockup"], DUR + 0.5, [mf(51), mf(55), mf(58), mf(62)], gain=0.13, fade=2.0)
for t, m in [(T["cam_demo"][1], 67), (T["request"], 63), (T["resumed"], 70), (T["pr"], 67), (T["cam_result"][1], 72)]:
    pluck(round(t / BEAT) * BEAT, mf(m), gain=0.25)

# ---- mix and master ----------------------------------------------------------------------------
ir_n = int(1.4 * SR)
ir = rng.standard_normal(ir_n) * np.exp(-np.arange(ir_n) / SR / 0.35)
ir = lp(ir, 5000) / np.sqrt(np.sum(ir ** 2))
wet = fftconvolve(send, ir)[:N]
mix = np.zeros((N, 2))
mix += music * 0.9 + sfx
mix[:, 0] += wet * 0.3
mix[:, 1] += wet * 0.3 * np.roll(np.ones(N), 0)
mix = mix[: int(DUR * SR)]
fade = np.clip((DUR - np.arange(len(mix)) / SR) / 1.5, 0, 1)
mix *= fade[:, None]
mix = np.tanh(mix * 1.1) / np.tanh(1.1)
peak = np.abs(mix).max()
mix = mix / peak * (10 ** (-2.6 / 20))
out = ROOT / "out"
out.mkdir(exist_ok=True)
wavfile.write(out / "score.wav", SR, (mix * 32767).astype(np.int16))
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(out / "score.wav"), "-b:a", "128k", str(out / "score.mp3")], check=True)

print("RMS per 2 s section (dBFS):")
for s in range(0, int(DUR), 2):
    seg = mix[s * SR:(s + 2) * SR]
    r = np.sqrt(np.mean(seg ** 2) + 1e-12)
    print(f"  {s:>2}-{s + 2:<2} s  {20 * np.log10(r):6.1f}")
print("peak dBFS", 20 * np.log10(np.abs(mix).max()))
