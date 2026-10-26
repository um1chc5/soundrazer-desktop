# Sound Razor — Project Overview

## What it is
A local audio stem separation tool. Takes a song recording and splits it into separate WAV stems (vocals, guitar, bass, drums, piano, other). Has a web UI for managing projects and a CLI.

## Two layers

### 1. Python application package
- **Python CLI** — package CLI entry point. Commands include `separate`, `split-guitar`, and `ui`.
- **Separation pipeline** — `audio/pipeline.py`. FFmpeg normalizes input → `audio-separator` loads a pretrained model → runs inference → writes stems.
- **Guitar splitting** — `audio/guitar_split.py`. Separate lead/rhythm guitar using a vendored Mel-Band RoFormer model.
- **Web UI** — `webui/server.py` serves the local HTTP API and static `web/` frontend (vanilla ES modules, no framework).
- **Metadata lookup** — `projects/metadata.py` handles project metadata and lookup responsibilities.
- **YouTube import** — `audio/sources.py` uses yt-dlp to download audio.

### 2. Desktop application
- Wraps the core into a standalone Windows installer.
- Adds a native desktop window (pywebview) instead of just a browser URL.
- Bootstrap installer downloads Python + deps + FFmpeg + models on first run.

## Project structure
```
soundrazer-desktop/
├── app/sound_razor/       # Python application package
│   ├── audio/             # Separation/audio modules
│   │   ├── pipeline.py
│   │   ├── guitar_split.py
│   │   ├── model_cache.py
│   │   └── sources.py
│   ├── projects/          # Project store and metadata
│   │   ├── store.py
│   │   └── metadata.py
│   ├── webui/             # Local HTTP server and library/jobs
│   │   ├── server.py
│   │   └── library.py
│   ├── setup_env.py       # First-run setup jobs
│   └── web/               # Static frontend: js/ ES modules; css/ five stylesheets
├── tests/                 # Unit tests
├── pyproject.toml         # Package config + extras
└── README.md              # Full docs
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
