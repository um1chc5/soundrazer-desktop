# Architecture — Sound Razor Core

## Data flow
```
User → CLI/UI → pipeline.separate() → FFmpeg normalize → audio-separator → model inference → stems
```

## Module responsibilities

### `audio/pipeline.py`
- `select_model()` — picks the right model based on requested stems
- `normalize()` — FFmpeg: stereo 44.1kHz 16-bit PCM WAV
- `output_directory()` — where to write results
- `separate()` — main function: downloads model if needed, runs inference, saves stems
- `combine_other()` — folds unselected stems into "Other" using FFmpeg amix filter

### `audio/model_cache.py`
- `create_separator()` — instantiates `audio_separator.separator.Separator` with our settings
- Manages model download URLs and SHA-256 checksums
- Three model families: Demucs (`.yaml` + `.th`), MDX (`.onnx`), RoFormer (`.ckpt`)

### `audio/guitar_split.py`
- Loads vendored Mel-Band RoFormer directly with PyTorch
- Processes 3-second windows with 50% overlap
- Predicts lead guitar, subtracts from input to get rhythm
- Uses 4 CPU threads

### `webui/server.py` and `webui/library.py`
- HTTP server (stdlib `http.server`) on 127.0.0.1:8765
- Serves static frontend from `web/` using generic safe static serving
- API endpoints for: listing projects, importing audio, starting separation, getting status, deleting projects, finding metadata
- Spawns CLI as subprocess for actual separation

### `projects/store.py`
- Project folder discovery, description, and safe project operations

### `setup_env.py`
- First-run dependency detection and setup-stage jobs

### `projects/metadata.py`
- MusicBrainz API (rate-limited to 1 req/sec)
- Cover Art Archive for album art
- Returns title, artist, album, year, cover image

### `audio/sources.py`
- yt-dlp wrapper for YouTube audio download
- Extracts to `original.wav` in a new project folder

## Models
| Model | File | Purpose | Backend |
|---|---|---|---|
| htdemucs_6s | htdemucs_6s.yaml + 5c90dfd2.th | 6 stems (vocals, drums, bass, guitar, piano, other) | PyTorch (Demucs) |
| htdemucs | htdemucs.yaml + 955717e8.th | 4 stems (vocals, drums, bass, other) | PyTorch (Demucs) |
| UVR_MDXNET_KARA_2 | UVR_MDXNET_KARA_2.onnx | 2 stems (vocals + instrumental) | ONNX Runtime |
| lead_rhythm_listra92 | lead_rhythm_listra92.ckpt | Split guitar into lead + rhythm | PyTorch (RoFormer) |

## Frontend (`web/`)
- `web/js/` — vanilla ES modules, including project management, import, separation controls, and audio playback
- `web/css/` — five stylesheets for the app and views
- `index.html` — page structure
- SoundTouchJS worklet — pitch-preserving speed change (MPL-2.0)

The Python split into `audio/`, `projects/`, and `webui/` is complete, as is the web module/CSS split.

## Dependencies
- `audio-separator[cpu]` — the main inference library (wraps Demucs + MDX)
- `torch` — PyTorch for Demucs and RoFormer
- `onnxruntime` — for MDX model
- `yt-dlp` — YouTube downloads
- `librosa`, `soundfile`, `numpy` — audio processing
- `einops`, `rotary-embedding-torch`, `beartype` — RoFormer architecture deps
