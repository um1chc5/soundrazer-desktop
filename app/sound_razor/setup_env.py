"""First-run setup: FFmpeg and the separation engine, installed inside the app.

Replaces installer/bootstrap.ps1. Runs as a Library job (kind "setup") so its
progress streams over the same /api/state polling the .progress-view frontend
already uses for separation jobs — no new frontend plumbing.
"""

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile
from pathlib import Path
from urllib.request import urlopen

from .tools import ensure_ffmpeg_on_path, MISSING_FFMPEG

# Mirrors installer/bootstrap.ps1: ffmpeg.exe/ffprobe.exe land next to the app
# folder (install root), where tools.py already looks for them.
FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
FFMPEG_SIZE_MB = 100
SEPARATION_SIZE_MB = 1600
YOUTUBE_SIZE_MB = 15
RUNTIME_SIZE_MB = 50

STAGE_ORDER = ("ffmpeg", "separation", "youtube")

# Progress budget: 0..90 is split across the stages being downloaded, the last
# 10 points are the verify/finalize stretch.
FINALIZE_BAND = 10


def _install_dir() -> Path:
    return Path(__file__).resolve().parents[1]


def _pyproject() -> Path:
    return _install_dir() / "pyproject.toml"


def runtime_ok() -> bool:
    """Stage 1: the embedded runtime ships with the installer; if we're running
    on it with pywebview importable, nothing to download."""
    return importlib.util.find_spec("webview") is not None


def ffmpeg_ok() -> bool:
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return True
    install = _install_dir()
    return (install / "ffmpeg.exe").is_file() and (install / "ffprobe.exe").is_file()


def separation_ok() -> bool:
    return importlib.util.find_spec("audio_separator") is not None


def youtube_ok() -> bool:
    return importlib.util.find_spec("yt_dlp") is not None


def stage_requirements(stage: str) -> list[str]:
    """Read pip requirements for a stage from pyproject.toml optional-dependencies,
    the source of truth for what gets installed."""
    extras = {
        "separation": ["separation", "guitars"],
        "youtube": ["youtube"],
    }[stage]
    try:
        data = tomllib.loads(_pyproject().read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Can't read {_pyproject()}: {error}") from error
    declared = data.get("project", {}).get("optional-dependencies", {})
    requirements = []
    for extra in extras:
        requirements.extend(declared.get(extra, []))
    if not requirements:
        raise RuntimeError(f"No requirements declared for the '{stage}' extra in pyproject.toml")
    return requirements


def _log(library, message: str):
    with library.lock:
        library.logs.append(message[-2000:])


def _tick(library, phase: str, stage: str | None, progress: int):
    with library.lock:
        job = library.job
        if job is None or job.get("status") not in {"running", "cancelling"}:
            return
        job["phase"] = phase
        job["stage"] = stage
        job["progress"] = max(0, min(100, int(progress)))


def _ensure_pip(library) -> None:
    """pip isn't guaranteed inside a stripped embedded Python; ensurepip ships
    with Python and works offline from its bundled wheel."""
    if importlib.util.find_spec("pip") is not None:
        return
    _log(library, "Installing pip into the embedded runtime…")
    command = [sys.executable, "-m", "ensurepip", "--upgrade"]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, errors="replace")
    with library.lock:
        library.process = process
    try:
        for line in process.stdout:
            if _cancelling(library):
                process.terminate()
                raise RuntimeError("Setup cancelled.")
            line = line.rstrip("\r\n")
            if line:
                _log(library, line)
    finally:
        if process.poll() is None:
            process.kill()
    code = process.wait()
    if code != 0:
        raise RuntimeError(f"ensurepip failed (exit {code}).")


def _cancelling(library) -> bool:
    with library.lock:
        return library.job is not None and library.job["status"] == "cancelling"


def _install_ffmpeg(library, start_progress: int, band: int) -> int:
    """Download the FFmpeg essentials zip and place ffmpeg.exe + ffprobe.exe
    next to the app folder. Returns the progress reached."""
    _tick(library, "download", "ffmpeg", start_progress)
    _log(library, f"Downloading FFmpeg from {FFMPEG_URL}…")
    with tempfile.TemporaryDirectory(prefix="sound-razor-ffmpeg-") as temporary:
        work = Path(temporary)
        archive = work / "ffmpeg.zip"
        with urlopen(FFMPEG_URL, timeout=60) as response, archive.open("wb") as stream:
            length = response.headers.get("Content-Length")
            expected = int(length) if length is not None else None
            received = 0
            while True:
                if _cancelling(library):
                    raise RuntimeError("Setup cancelled.")
                block = response.read(1024 * 1024)
                if not block:
                    break
                stream.write(block)
                received += len(block)
                if expected:
                    pct = start_progress + int((received / expected) * band)
                    _tick(library, "download", "ffmpeg", start_progress + min(band, pct - start_progress))
                elif received % (32 * 1024 * 1024) == 0:
                    _log(library, f"Downloaded {received // (1024 * 1024)} MiB…")
        if expected is not None and received != expected:
            raise RuntimeError("Incomplete FFmpeg download. Retry setup.")
        install = _install_dir()
        with zipfile.ZipFile(archive) as zip_file:
            names = zip_file.namelist()
            ffmpeg_name = next((n for n in names if n.lower().endswith("/bin/ffmpeg.exe")), None)
            ffprobe_name = next((n for n in names if n.lower().endswith("/bin/ffprobe.exe")), None)
            if not ffmpeg_name or not ffprobe_name:
                raise RuntimeError("FFmpeg archive is missing ffmpeg.exe/ffprobe.exe.")
            with zip_file.open(ffmpeg_name) as source, (install / "ffmpeg.exe").open("wb") as target:
                shutil.copyfileobj(source, target)
            with zip_file.open(ffprobe_name) as source, (install / "ffprobe.exe").open("wb") as target:
                shutil.copyfileobj(source, target)
    if not ensure_ffmpeg_on_path():
        raise RuntimeError("FFmpeg was installed but could not be added to PATH.")
    _log(library, "FFmpeg installed.")
    return start_progress + band


def _pip_install(library, requirements: list[str], stage: str, start_progress: int, band: int) -> int:
    """pip-install a requirement list, streaming progress through the job."""
    _tick(library, "install", stage, start_progress)
    quoted = " ".join(requirements)
    _log(library, f"pip install {quoted}")
    command = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *requirements]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, errors="replace")
    with library.lock:
        library.process = process
    milestones = {"Collecting": 0.25, "Installing collected packages": 0.65,
                  "Successfully installed": 1.0}
    hit = {name: False for name in milestones}
    try:
        for line in process.stdout:
            if _cancelling(library):
                process.terminate()
                raise RuntimeError("Setup cancelled.")
            line = line.rstrip("\r\n")
            if not line:
                continue
            _log(library, line)
            for name, fraction in milestones.items():
                if not hit[name] and line.startswith(name):
                    hit[name] = True
                    _tick(library, "install", stage, start_progress + int(band * fraction))
    finally:
        if process.poll() is None:
            process.kill()
    code = process.wait()
    if code != 0:
        raise RuntimeError(f"pip install failed for {stage} (exit {code}). See the setup log.")
    _tick(library, "install", stage, start_progress + band)
    return start_progress + band


def run_setup(library, stages: list[str]) -> None:
    """Run the requested setup stages, one job, streaming progress as it goes."""
    needed = [stage for stage in STAGE_ORDER if stage in stages]
    missing = [stage for stage in needed
               if (stage == "ffmpeg" and not ffmpeg_ok())
               or (stage == "separation" and not separation_ok())
               or (stage == "youtube" and not youtube_ok())]
    if not missing:
        with library.lock:
            job = library.job
            if job:
                job.update(status="succeeded", progress=100, phase="done", stage=None)
        return

    band = (100 - FINALIZE_BAND) // max(1, len(missing))
    cursor = 0
    try:
        _tick(library, "prepare", None, 0)
        _log(library, "Checking what's already installed…")

        if "ffmpeg" in missing and not ffmpeg_ok():
            cursor = _install_ffmpeg(library, cursor, band)
            _tick(library, "download", "ffmpeg", cursor)

        _ensure_pip(library)

        if "separation" in missing and not separation_ok():
            requirements = stage_requirements("separation")
            cursor = _pip_install(library, requirements, "separation", cursor, band)
            _tick(library, "install", "separation", cursor)

        if "youtube" in missing and not youtube_ok():
            requirements = stage_requirements("youtube")
            cursor = _pip_install(library, requirements, "youtube", cursor, band)
            _tick(library, "install", "youtube", cursor)

        # Finalize: make sure everything is actually usable now.
        _tick(library, "finalize", None, min(100, cursor + FINALIZE_BAND))
        if not ensure_ffmpeg_on_path():
            raise RuntimeError(MISSING_FFMPEG)
        if "separation" in missing and not separation_ok():
            raise RuntimeError("Separation engine install did not take effect; restart the app and try again.")
        if "youtube" in missing and not youtube_ok():
            raise RuntimeError("YouTube support install did not take effect; restart the app and try again.")
        _tick(library, "finalize", None, 100)

        with library.lock:
            job = library.job
            if job and job["status"] == "running":
                job.update(status="succeeded", progress=100, phase="done", stage=None)
    except Exception as error:
        with library.lock:
            job = library.job
            if job and job["status"] != "cancelling":
                job.update(status="failed", error=str(error))
