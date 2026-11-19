"""Render chosen timestamps into a 2-column contact sheet: preview.py name t1,t2,... (fails on page or console errors)."""
import base64
import glob
import io
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent


def chrome_path():
    if os.environ.get("CHROME"):
        return os.environ["CHROME"]
    found = sorted(glob.glob(os.path.expanduser("~/.cache/hyperframes/chrome/chrome-headless-shell/*/*/chrome-headless-shell")))
    return found[-1] if found else None


def launch(p):
    return p.chromium.launch(executable_path=chrome_path(), args=["--disable-dev-shm-usage", "--no-sandbox"])


def main():
    name = sys.argv[1]
    times = [float(v) for v in sys.argv[2].split(",")]
    errors = []
    with sync_playwright() as p:
        browser = launch(p)
        pg = browser.new_page(viewport={"width": 1920, "height": 1080})
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        pg.on("console", lambda m: errors.append(f"console {m.type}: {m.text}") if m.type in ("error", "warning") else None)
        pg.goto(f"file://{ROOT / 'out' / 'sky.html'}?render")
        pg.wait_for_function("window.reel_ready===true", timeout=60000)
        tiles = []
        for t in times:
            data = pg.evaluate(f'(draw_at({t}), window.canvas.toDataURL("image/png"))')
            im = Image.open(io.BytesIO(base64.b64decode(data.split(",")[1]))).convert("RGB").resize((960, 540))
            ImageDraw.Draw(im).text((12, 10), f"t={t:.2f}", fill=(255, 255, 0))
            tiles.append(im)
        browser.close()
    rows = (len(tiles) + 1) // 2
    sheet = Image.new("RGB", (1920, 540 * rows), (0, 0, 0))
    for i, im in enumerate(tiles):
        sheet.paste(im, ((i % 2) * 960, (i // 2) * 540))
    out = ROOT / "sheets"
    out.mkdir(exist_ok=True)
    path = out / f"{name}.png"
    sheet.save(path)
    print("sheet", path)
    if errors:
        print("\n".join(errors))
        sys.exit(1)


if __name__ == "__main__":
    main()
