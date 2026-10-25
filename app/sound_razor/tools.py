"""Locate FFmpeg when it is not on PATH (e.g. the installer's copy, WinGet, Scoop)."""

import glob
import os
from pathlib import Path
import shutil
import sys

EXE = ".exe" if os.name == "nt" else ""


def _candidates():
    here = Path(__file__).resolve()
    roots = [Path.cwd(), here.parents[1], here.parents[2], *Path(sys.executable).resolve().parents[:3]]
    for root in roots:
        yield root
        yield root / "ffmpeg" / "bin"
        yield root / "bin"
    if os.name == "nt":
        local = Path(os.environ.get("LOCALAPPDATA", ""))
        yield local / "Microsoft" / "WinGet" / "Links"
        yield from map(Path, glob.glob(str(local / "Microsoft" / "WinGet" / "Packages" / "*FFmpeg*" / "**" / "bin"), recursive=True))
        yield Path(os.environ.get("USERPROFILE", "")) / "scoop" / "shims"
        yield Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "chocolatey" / "bin"
        yield Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "ffmpeg" / "bin"
        yield Path(r"C:\ffmpeg\bin")
    else:
        yield Path("/opt/homebrew/bin")
        yield Path("/usr/local/bin")


def ensure_ffmpeg_on_path() -> bool:
    """Prepend a folder holding ffmpeg and ffprobe to PATH (also for child processes)."""
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return True
    for folder in _candidates():
        if (folder / f"ffmpeg{EXE}").is_file() and (folder / f"ffprobe{EXE}").is_file():
            os.environ["PATH"] = f"{folder}{os.pathsep}{os.environ.get('PATH', '')}"
            return True
    return False


MISSING_FFMPEG = ("FFmpeg was not found. Install it (for example: winget install Gyan.FFmpeg) "
                  "or put ffmpeg.exe and ffprobe.exe in the SoundRazer folder, then restart the app.")
