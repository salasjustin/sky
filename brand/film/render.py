"""Render frames/%05d.jpg from out/sky.html?render with headless Chrome, then encode out/sky.mp4.

Skips frames that already exist, so an interrupted run resumes. Usage: render.py [--encode-only]
"""
import glob
import json
import os
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
T = json.loads((ROOT / "timeline.json").read_text())
FPS, DUR = T["fps"], T["dur"]
FRAMES = ROOT / "frames"
OUT = ROOT / "out"


def chrome():
    if os.environ.get("CHROME"):
        return os.environ["CHROME"]
    hits = sorted(glob.glob(os.path.expanduser("~/.cache/hyperframes/chrome/chrome-headless-shell/*/*/chrome-headless-shell")))
    return hits[-1]


def render():
    FRAMES.mkdir(exist_ok=True)
    total = round(DUR * FPS)
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=chrome(), args=["--disable-dev-shm-usage", "--no-sandbox"])
        page = b.new_page(viewport={"width": 1920, "height": 1080})
        page.on("pageerror", lambda e: sys.exit(f"page error: {e}"))
        page.goto((OUT / "sky.html").as_uri() + "?render")
        page.wait_for_function("window.reel_ready === true", timeout=60000)
        for n in range(total):
            f = FRAMES / f"{n:05d}.jpg"
            if f.exists():
                continue
            page.evaluate(f"window.draw_at({n / FPS})")
            page.locator("canvas").screenshot(path=str(f), type="jpeg", quality=92)
            if n % 100 == 0:
                print(f"frame {n}/{total}", flush=True)
        b.close()


def encode():
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(FRAMES / "%05d.jpg"),
        "-i", str(OUT / "score.wav"), "-c:v", "libx264", "-crf", "20", "-preset", "slow", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-af", "apad", "-t", str(DUR), "-movflags", "+faststart", str(OUT / "sky.mp4"),
    ], check=True)


if __name__ == "__main__":
    if "--encode-only" not in sys.argv:
        render()
    encode()
    print("done")
