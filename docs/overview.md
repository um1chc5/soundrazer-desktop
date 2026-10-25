# Sound Razor — Project Overview

## What it is
A local audio stem separation tool. Takes a song recording and splits it into separate WAV stems (vocals, guitar, bass, drums, piano, other). Has a web UI for managing projects and a CLI.

## Two layers

### 1. `sound-razor/` (the core)
- **Python CLI** — `sound_razor/cli.py` entry point. Commands: `separate`, `split-guitar`, `ui`, `train` (unimplemented).
- **Separation pipeline** — `sound_razor/pipeline.py`. FFmpeg normalizes input → `audio-separator` library loads a pretrained model → runs inference → writes stems.
- **Guitar splitting** — `sound_razor/guitar_split.py`. Separate lead/rhythm guitar using a vendored Mel-Band RoFormer model.
- **Web UI** — `sound_razor/ui.py` serves a small HTTP server + `sound_razor/web/` frontend (vanilla JS, no framework).
- **Metadata lookup** — `sound_razor/metadata_lookup.py` queries MusicBrainz + Cover Art Archive.
- **YouTube import** — `sound_razor/sources.py` uses yt-dlp to download audio.

### 2. `aloso/soundrazer-desktop/` (the desktop packaging — to be built)
- Wraps the core into a standalone Windows installer.
- Adds a native desktop window (pywebview) instead of just a browser URL.
- Bootstrap installer downloads Python + deps + FFmpeg + models on first run.

## Project structure
```
sound-razor/
├── sound_razor/          # Core Python package
│   ├── cli.py            # CLI entry point
│   ├── pipeline.py       # Audio separation pipeline
│   ├── guitar_split.py   # Lead/rhythm guitar splitter
│   ├── ui.py             # HTTP server for web UI
│   ├── model_cache.py    # Model download/checksum logic
│   ├── metadata_lookup.py# MusicBrainz + Cover Art Archive
│   ├── projects.py       # Project folder management
│   ├── sources.py        # YouTube download
│   ├── vendor/roformer/  # Vendored Mel-Band RoFormer (MIT)
│   └── web/              # Frontend assets
│       ├── app.js
│       ├── player.js     # Web audio player with tempo/pitch control
│       ├── styles.css
│       ├── index.html
│       └── vendor/soundtouch/  # SoundTouchJS (MPL-2.0) for pitch-preserving speed change
├── tests/                # Unit tests
├── pyproject.toml        # Package config + extras
└── README.md             # Full docs
```

## How separation works (simplified)
1. User imports an audio file (local or YouTube)
2. FFmpeg converts it to stereo 44.1kHz WAV
3. `audio-separator` loads a pretrained model:
   - **htdemucs_6s** (6 stems: vocals, drums, bass, guitar, piano, other) — default
   - **htdemucs** (4 stems: vocals, drums, bass, other)
   - **UVR_MDXNET_KARA_2** (2 stems: vocals + instrumental)
4. Model runs inference (PyTorch or ONNX Runtime)
5. Selected stems are saved; unselected parts fold into "Other"
6. Optional: split guitar into lead/rhythm using RoFormer model

## Key facts
- Models download automatically on first use (~424 MB total), cached in `.sound-razor/models/`
- No training — inference only
- UI server binds to loopback only (127.0.0.1:8765)
- No cloud, no API keys, no account needed