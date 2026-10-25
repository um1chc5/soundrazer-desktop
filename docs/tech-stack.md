# Technical Stack

## Core (sound-razor/)
| Layer | Technology | Why |
|---|---|---|
| Language | Python 3.11 | Existing codebase, audio-ml ecosystem |
| CLI | argparse | stdlib, no extra deps |
| HTTP server | `http.server` (stdlib) | No framework needed, tiny attack surface |
| Frontend | Vanilla JS, HTML, CSS | No build step, no framework overhead |
| Audio playback | Web Audio API + AudioBufferSourceNode | Native browser audio, synchronized stems |
| Tempo/pitch | SoundTouchJS (MPL-2.0) | Pitch-preserving speed change in Web Audio worklet |
| Inference | audio-separator (wraps Demucs + MDX) | Pretrained models, CPU/GPU auto-detect |
| Deep learning | PyTorch (Demucs, RoFormer) + ONNX Runtime (MDX) | Industry standard, good CPU performance |
| YouTube | yt-dlp | Industry standard, handles JS challenges |
| Metadata | MusicBrainz API + Cover Art Archive | Free, open music database |

## Desktop packaging (aloso/soundrazer-desktop/)
| Layer | Technology | Why |
|---|---|---|
| Installer | Inno Setup 7 | Free, mature, creates proper Windows installers |
| Native window | pywebview | Wraps existing web UI in OS WebView, no Chromium bundle |
| Bootstrap | Python embeddable + uv | Tiny bootstrap, downloads deps at install time |
| Compression | UPX (optional) | Shrink the bootstrap exe further |

## Alternatives considered
| Option | Rejected because |
|---|---|
| Tauri | Requires Rust rewrite of the backend — too big a lift for existing Python code |
| Electron | ~150 MB Chromium bundle defeats the size-reduction goal |
| PyInstaller monolithic bundle | ~500 MB installer is too large for non-IT users |
| WPF/WinForms wrapper | Would require rewriting the UI in C# — abandons the working web UI |
| py2exe | Abandoned, Python 3.11 support poor |