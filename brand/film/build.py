"""Inline fonts, the Sky logo, the timeline, the score and the three scripts into out/sky.html."""
import base64
import json
import re
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "out"


def b64(path):
    return base64.b64encode(path.read_bytes()).decode()


def logo():
    svg = (ROOT / "assets" / "sky-lockup.svg").read_text()
    groups = re.findall(r'<g transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)"><path fill="currentColor" d="([^"]+)"/></g>', svg)
    (mx, my, ms, md), (wx, wy, ws, wd) = groups
    vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', svg).group(1).split()[2:]]
    return {"markd": md, "mark": [float(mx), float(my), float(ms)], "wordd": wd, "word": [float(wx), float(wy), float(ws)], "vb": vb}


def font_faces():
    fonts = ROOT / "assets" / "fonts"
    faces = [
        ("Inter", "100 900", "Inter-var-latin.woff2"),
        ("DejaVu Sans Mono", "400", "DejaVuSansMono-Regular-subset.woff2"),
        ("DejaVu Sans Mono", "700", "DejaVuSansMono-Bold-subset.woff2"),
    ]
    return "\n".join(
        f'@font-face{{font-family:"{fam}";font-weight:{w};src:url(data:font/woff2;base64,{b64(fonts / f)}) format("woff2")}}'
        for fam, w, f in faces
    )


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sky</title>
<style>
%(fonts)s
html,body{margin:0;background:#0d0e11;color:#f7f6f2;font-family:Inter,sans-serif;height:100%%}
body.render{background:#16181D}
body.render #stage{width:1920px;height:1080px}
body.render #bar{display:none!important}
#stage{position:relative;margin:0 auto;max-width:100vw}
#c{display:block;width:100%%;height:auto;background:#16181D}
#bar{display:none;align-items:center;gap:14px;max-width:1920px;margin:10px auto 0;padding:0 12px;font-size:15px}
button{background:#2a2a2a;color:#f7f6f2;border:0;border-radius:8px;padding:8px 16px;font:600 15px Inter,sans-serif;cursor:pointer}
#track{position:relative;flex:1;height:10px;background:#2a2a2a;border-radius:5px;cursor:pointer}
#fill{height:100%%;width:0;background:#f7f6f2;border-radius:5px}
#track i{position:absolute;top:-4px;width:2px;height:18px;background:#9a9a9a}
#time{min-width:120px;text-align:right;color:#9a9a9a}
</style></head>
<body>
<div id="stage"><canvas id="c" width="1920" height="1080"></canvas></div>
<div id="bar"><button id="play">Play</button><button id="snd">Sound on</button><div id="track"><div id="fill"></div></div><span id="time"></span></div>
<script>const T=%(timeline)s;const LOGO=%(logo)s;const SCORE=%(score)s;</script>
<script>%(engine)s</script>
<script>%(scenes)s</script>
<script>%(player)s</script>
</body></html>
"""


def main():
    OUT.mkdir(exist_ok=True)
    score = OUT / "score.mp3"
    page = PAGE % {
        "fonts": font_faces(),
        "timeline": json.dumps(json.loads((ROOT / "timeline.json").read_text())),
        "logo": json.dumps(logo()),
        "score": json.dumps(f"data:audio/mpeg;base64,{b64(score)}") if score.exists() else "null",
        "engine": (ROOT / "engine.js").read_text(),
        "scenes": (ROOT / "scenes.js").read_text(),
        "player": (ROOT / "player.js").read_text(),
    }
    (OUT / "sky.html").write_text(page)
    print("wrote out/sky.html", len(page) // 1024, "KB", "with score" if score.exists() else "no score")


if __name__ == "__main__":
    main()
