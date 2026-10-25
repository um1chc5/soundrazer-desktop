# Desktop App — Technical Plan (`aloso/soundrazer-desktop`)

## Goal
Package Sound Razor into a standalone Windows `.exe` installer so non-technical users can install and run it without touching Python, venv, or PATH.

## Three pieces

### 1. Bootstrap installer (Inno Setup, ~5-10 MB)
A tiny installer that does NOT bundle the heavy deps. Instead it:
- Installs Python 3.11 (if missing) via embedded Python embeddable package
- Installs `uv` and the sound-razor package with all extras (`separation`, `guitars`, `youtube`)
- Installs FFmpeg (bundled or downloaded)
- Creates Start Menu + Desktop shortcuts
- On first launch, downloads model weights (~424 MB) automatically

User experience: double-click `SoundRazor-Setup.exe`, click Next a few times, wait a few minutes, done.

### 2. Native desktop window (pywebview)
Wrap the existing web UI in the OS's built-in WebView (EdgeHTML on Windows). Reuses 100% of the existing frontend with minimal changes:
- One import + a few lines in `ui.py` to open a native window instead of `webbrowser.open()`
- No Electron/Chromium bundle (saves ~150 MB)
- Feels like a real app: taskbar icon, window controls, no browser chrome

**Why not Tauri?** Tauri would require rewriting the backend in Rust and installing the Rust toolchain — a much bigger lift for an existing Python codebase. pywebview reuses the existing web UI with minimal changes.

### 3. Size reduction
| Technique | Savings |
|---|---|
| Don't bundle torch/onnxruntime in installer | ~500 MB → installer is ~5 MB |
| Download deps at install time | Only pay for what user runs |
| Strip debug symbols from PyInstaller build | ~10-20% |
| UPX-compress the bootstrap exe | ~30% on the small installer |
| Lazy-load model weights (already done) | ~424 MB not in installer |

## Files to create
- `installer/SoundRazor.iss` — Inno Setup script
- `installer/bootstrap.ps1` — download + install logic
- `sound_razor/ui.py` — add pywebview wrapper (optional, behind a flag)

## Deliverable
`SoundRazor-Setup-x64.exe` — a ~5-10 MB bootstrap installer.
First launch downloads ~500 MB of Python deps + FFmpeg + models in the background.
Total disk usage after install: ~600 MB (deps + models + app).

## Build flow (developer)
```sh
# 1. (Optional) Build a frozen single-file exe with PyInstaller for faster first launch
pyinstaller --onefile --windowed sound_razor/ui_entrypoint.py

# 2. Compile the Inno Setup bootstrap installer
iscc SoundRazor.iss
```

## Technical risks
- pywebview on Windows requires Edge WebView2 runtime (may need to bundle or download)
- Inno Setup must handle long paths and Windows filename restrictions
- Model downloads can be slow on poor connections — need progress UI
- The frozen exe must locate FFmpeg at runtime (bundled next to the exe)