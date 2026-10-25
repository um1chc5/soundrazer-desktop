# SoundRazer Desktop

[![Download for Windows](https://img.shields.io/github/v/release/um1chc5/soundrazer-desktop?label=Download%20for%20Windows&style=for-the-badge&color=ff8a3d)](https://github.com/um1chc5/soundrazer-desktop/releases/latest/download/SoundRazer-Setup-x64.exe)

A standalone desktop application for AI-powered audio stem separation, built on the excellent [Sound Razor](https://github.com/pedromtcosta/sound-razor) by [pedromtcosta](https://github.com/pedromtcosta).

## About

SoundRazer Desktop packages Sound Razor into a native Windows application with an enhanced, modern UI. It uses AI models (Demucs, MDX, RoFormer) to separate mixed audio into individual instrument stems - vocals, drums, bass, guitar, piano, and more. You can also split guitars into lead and rhythm parts.

## Features

- **Native Desktop App** - Runs in its own window using pywebview, no browser needed
- **Enhanced UI** - Beautiful, modern interface with improved UX
- **100% Local Processing** - All AI models run on your computer, no cloud uploads
- **Multiple Formats** - Supports WAV, MP3, FLAC, M4A, OGG, AAC and more
- **Guitar Splitting** - Separate lead and rhythm guitar parts
- **YouTube Import** - Download and separate audio directly from YouTube
- **Real-time Mixer** - Control volume, mute, and solo each stem independently
- **Playback Speed Control** - Slow down tracks without pitch change for learning
- **Project Management** - Organize all your separated tracks in one place

## Credits

This project is built upon [Sound Razor](https://github.com/pedromtcosta/sound-razor) created by **[pedromtcosta](https://github.com/pedromtcosta)**. All core audio separation functionality comes from the original Sound Razor project. SoundRazer Desktop adds a native window wrapper, improved UI design, and simplified installation.

## Installation

### For Users (Recommended)

**[Download SoundRazer-Setup-x64.exe](https://github.com/um1chc5/soundrazer-desktop/releases/latest/download/SoundRazer-Setup-x64.exe)** (latest release) and run it. The installer is tiny and works offline:

- Copies the app and an embedded Python runtime to a folder you choose (default: `%LocalAppData%\SoundRazer Desktop`; no administrator elevation needed)
- Creates Start Menu and Desktop shortcuts and registers an uninstaller

On first launch the app window opens immediately and shows a one-time setup screen. You explicitly consent to download and install the remaining pieces — FFmpeg and the PyTorch/audio-separation stack (~1.6 GB total) — before anything downloads. Library and Separate stay visible but inactive until setup is approved. AI models (~500 MB) are then downloaded on first separation, as before.

### For Developers

```bash
# Clone or copy this project
cd soundrazer-desktop

# Create virtual environment
uv venv --python 3.11 .venv

# Install dependencies
uv pip install --python .venv/Scripts/python.exe -e ".[full]"

# Run the app
.\.venv\Scripts\soundrazer.exe
```

## System Requirements

- **OS**: Windows 10/11 (64-bit)
- **RAM**: 8GB minimum, 16GB recommended
- **Storage**: ~10GB free space (for dependencies and models)
- **CPU**: Modern 64-bit processor (4+ cores recommended)
- **GPU**: Optional (CPU works fine)

## Technology Stack

- **Backend**: Python with Flask-style HTTP server (inherited from Sound Razor)
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Desktop Wrapper**: [pywebview](https://pywebview.flowrl.com/)
- **AI Models**: [Demucs](https://github.com/facebookresearch/demucs), [MDX-Net](https://github.com/kuielab/mdx-net), [RoFormer](https://github.com/lucidrains/BS-RoFormer)
- **Audio Processing**: [audio-separator](https://github.com/nomadkaraoke/python-audio-separator), PyTorch, ONNX Runtime

## License

MIT License - See [LICENSE](LICENSE) file for details.

Original Sound Razor is also MIT licensed by pedromtcosta.
