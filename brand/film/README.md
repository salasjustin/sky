# Sky film

A 44.9 s, 1920×1080, 30 fps explainer drawn in code: a canvas engine where `draw(t)` is a pure function of time, a synthesized score, frames rendered in headless Chrome, and FFmpeg for the encode.

## Build

```sh
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python build.py      # out/sky.html (player; add ?render for frame mode)
.venv/bin/python audio.py      # out/score.wav + out/score.mp3, from timeline.json
.venv/bin/python build.py      # again, to embed the score
.venv/bin/python render.py     # frames/ then out/sky.mp4
```

`timeline.json` is read by both the picture and the score, so cues stay in step. `preview.py name t1,t2,…` writes a contact sheet to `sheets/`.

## Claims

Every fact on screen traces to the root `README.md`.

| On screen                                                                                                        | Source                   |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------ |
| "Your Claude Code crew, in the cloud."                                                                           | tagline, line 7          |
| Agents run Claude Code, each with its own session and branch, ask for an answer or a go-ahead, and say when done | line 9                   |
| `sky agent start`, `sky agent list`, `sky approve`                                                               | lines 148–155            |
| List rows with `running`, `waiting_approval`, `finished`                                                         | lines 157–161            |
| A Bash request waiting on a button                                                                               | `approvalPolicy: [Bash]` |
| A private preview link                                                                                           | Previews section         |
| `github.com/salasjustin/sky`                                                                                     | repo URL                 |

Illustrative, not from the README: agent ids (`agt_7f3k`), the env names `web`, `api`, `docs`, the toast wording, and the four laptop windows (`claude code`, `build`, `lint`, `test`). No counts or timings are stated.

The README says one sprite per environment; the film gives each window its own sprite, labelled with an example env name.

Product names are plain text only. No Anthropic, Claude or Fly logos, and no Claude Code mascot.

## Fonts

Inter (SIL OFL) and DejaVu Sans Mono, embedded as base64. See `assets/fonts/SOURCES.md`. The brand defines no typeface.

## Sound

Synthesized in `audio.py`; nothing downloaded. Measured, not listened to.
