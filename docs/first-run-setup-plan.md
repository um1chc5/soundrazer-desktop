# First-run setup: what gets downloaded, and when the user approves it

SoundRazer Desktop's own installer stays tiny (a few MB — just app source files, no
runtime). Everything heavy downloads **after** install, the first time it's actually
needed, with the user's explicit go-ahead at each stage. This doc lists exactly what
that "heavy stuff" is, how big it is, and where the approval/consent screen should sit.

## Why not bundle it all in the installer?

Python + FFmpeg + PyTorch + the separation models add up to **1.5–2.5 GB**. Shipping
that in the installer would make a "lightweight setup" claim false, and would download
things a user might never need (e.g. YouTube import, or guitar splitting) regardless of
whether they ever use that feature. Downloading on first use keeps the installer honest
and avoids wasting bandwidth/disk on unused features.

## The three download stages

| # | Stage | What | Approx. size | Triggered by | Currently downloads via |
|---|-------|------|-------------:|---------------|---------------|
| 1 | **Runtime** | Embedded Python 3.11, `uv`, the app's own Python packages (`pywebview`) | ~40–60 MB | First launch after install | [bootstrap.ps1](../installer/bootstrap.ps1) |
| 2 | **FFmpeg** | `ffmpeg.exe` + `ffprobe.exe` | ~80–120 MB | First launch, if not already on the system | [bootstrap.ps1](../installer/bootstrap.ps1) |
| 3 | **Separation engine** | `torch`, `audio-separator`, `onnxruntime`, `librosa`, and friends (the `[separation]`/`[guitars]`/`[youtube]` extras — see [pyproject.toml](../pyproject.toml)) | ~1.3–1.8 GB | First launch, before the app can separate anything | [bootstrap.ps1](../installer/bootstrap.ps1) |
| 4 | **AI models** | Per-model checkpoint (Demucs/MDX/RoFormer, guitar lead-rhythm model) | ~80–500 MB *each*, only the ones actually used | The *first time* a given model/preset is used — stems vocals+drums+bass+guitar need one model, piano needs another, guitar-split needs its own | [model_cache.py](../app/sound_razor/model_cache.py) / [guitar_split.py](../app/sound_razor/guitar_split.py), already lazy and already has in-app progress UI |

Stage 4 is already built the right way: lazy, per-feature, with the app's own progress
ring. **Stages 1–3 are the gap** — they currently run via a raw PowerShell console
([bootstrap.ps1](../installer/bootstrap.ps1)) with plain `Write-Host` text, not the
app's UI, and the user never gets an explicit "yes, download ~1.5 GB" moment — it just
starts.

## What the user should explicitly approve, and where

**Not in the installer.** The Inno Setup / NSIS wizard should do nothing but copy files
and show a one-line notice ("first launch downloads what it needs — nothing yet"). No
network access during install.

**On first launch, before anything downloads — one screen, inside the app**, reusing the
existing design system (same cards/progress-ring component already built for separation
jobs):

```
┌─────────────────────────────────────────────────────────────┐
│  Set up SoundRazer Desktop                                   │
│  A few things need to download before you can separate       │
│  tracks. Everything after this is 100% local — no account,    │
│  no telemetry, no re-asking.                                  │
│                                                                │
│  ☑ Python runtime & app packages         ~50 MB               │
│  ☑ FFmpeg (audio conversion)             ~100 MB               │
│  ☑ Separation engine (PyTorch, etc.)     ~1.6 GB               │
│  ☐ YouTube import support (yt-dlp)       ~15 MB  (optional)    │
│                                                                │
│  Total: ~1.75 GB · usually 3–8 min on a typical connection     │
│                                                                │
│              [ Not now ]      [ Download & install ]          │
└─────────────────────────────────────────────────────────────┘
```

Design notes:
- The first three are **not optional** — the app can't separate anything without them —
  so they're shown checked/locked (greyed checkmark, not an actual toggle) purely for
  transparency about what's being fetched, not as a real choice.
- YouTube support is the one genuinely optional item (small, and not everyone imports
  from YouTube) — a real checkbox, unchecked by default or checked by default, open
  question for the user to decide.
- "Not now" closes the screen; the app still opens (Library/Separate UI visible) but
  every action that needs an undownloaded piece re-shows this screen scoped to just what
  that action needs, same pattern AI models already use.
- Model downloads (stage 4) stay exactly as they are today — no separate consent screen
  needed there, the per-job progress UI *is* the consent (user already clicked "Separate
  stems" knowing a model may need to download first; it's clearly part of that action).
- Progress during stages 1–3 reuses the same ring/step UI as a separation job
  (`.progress-view` in [styles.css](../app/sound_razor/web/styles.css)), not a raw
  PowerShell window.

## Implementation sketch (not yet built)

1. Ship a small embedded Python + `pywebview` *in the installer itself* (~100–150 MB
   added to the installer — still far lighter than the full ML stack) so the real app
   window can open immediately on first launch, before stages 1–3 run.
2. Replace [bootstrap.ps1](../installer/bootstrap.ps1)'s role: instead of running before
   the app starts, its logic (download/verify FFmpeg, `pip install -e ".[full]"`) moves
   into a Python module the running app calls, streaming progress over the same
   `job`/`state` polling mechanism `ui.py` already uses for separation jobs, so the
   existing progress-view component can render it with zero new frontend plumbing.
3. The one consent screen above gates that call. Until approved, the Library/Separate
   tabs stay visible but inert with a banner pointing back to setup.
4. Installer shrinks the Inno/NSIS side to just: copy files, write the one line "nothing
   downloads until you say so" notice, done.

This is the piece flagged as not-yet-built in the session that produced this plan —
everything above it (stage 4, the current bootstrap flow) already exists and works.
