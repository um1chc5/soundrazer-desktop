"""Locate FFmpeg when it is not on PATH (e.g. the installer's copy, WinGet, Scoop)."""

import glob
import os
from pathlib import Path
import shutil
import sys

EXE = ".exe" if os.name == "nt" else ""


def embedded_runtime() -> bool:
    """True on the Windows installer's embeddable Python (it ships a python*._pth file).

    That copy lives in Program Files, which the app can't write to without admin
    rights, so whatever setup downloads goes to app_data_dir() instead.
    """
    return any(Path(sys.executable).resolve().parent.glob("python*._pth"))


APP_NAME = "Unweave"
LEGACY_APP_NAME = "SoundRazer Desktop"  # the app's name up to 1.2.2


def app_version() -> str:
    """The version in pyproject.toml, which sits next to sound_razor/ in a checkout's app/
    folder and at the install root (the installer copies the repo root's one there)."""
    import tomllib
    try:
        with open(Path(__file__).resolve().parents[1] / "pyproject.toml", "rb") as stream:
            return tomllib.load(stream)["project"]["version"]
    except (OSError, KeyError, ValueError):
        return ""


def _local_app_data() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")


def app_data_dir() -> Path:
    """Per-user folder for config, models and setup downloads (ui_entrypoint.py uses it too)."""
    return _local_app_data() / APP_NAME


def migrate_legacy_data_dir() -> None:
    """Carry a pre-rename install's data over (setup's ~1.6 GB of packages, models,
    settings) by renaming the folder, so nothing is downloaded again. The installer
    does the same before removing the old version; this covers anything it missed."""
    legacy, current = _local_app_data() / LEGACY_APP_NAME, app_data_dir()
    if legacy.is_dir() and not current.exists():
        try:
            legacy.rename(current)
        except OSError:
            pass  # in use by an old copy still running; the next launch retries


def packages_prefix() -> Path:
    """pip --prefix for setup's packages on the embedded runtime; prepare_embedded_runtime()
    puts its Lib/site-packages on sys.path."""
    return app_data_dir() / "packages"


def prepare_embedded_runtime() -> None:
    """Run at interpreter start on the embedded runtime (installer/unweave.pth): keep the
    shared per-user site-packages out and put setup's own package folder on sys.path."""
    import site
    user_site = site.getusersitepackages()
    if user_site in sys.path:
        sys.path.remove(user_site)
    site.ENABLE_USER_SITE = False
    migrate_legacy_data_dir()
    packages = packages_prefix() / "Lib" / "site-packages"
    packages.mkdir(parents=True, exist_ok=True)  # on sys.path now, so setup's installs import at once
    site.addsitedir(str(packages))


def ffmpeg_dir() -> Path:
    """Where setup unpacks FFmpeg: the app data folder on the embedded runtime, else the
    install root next to the app (a writable portable folder on Linux and in dev)."""
    return app_data_dir() / "ffmpeg" if embedded_runtime() else Path(__file__).resolve().parents[1]


def _candidates():
    here = Path(__file__).resolve()
    roots = [Path.cwd(), here.parents[1], ffmpeg_dir(), *Path(sys.executable).resolve().parents[:3]]
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
                  "or put ffmpeg.exe and ffprobe.exe in the Unweave folder, then restart the app.")


def cpu_threads() -> int:
    """Return inference thread count, leaving one core free for the server/UI.

    Override with SOUND_RAZOR_THREADS env var. Falls back to 1 if cpu_count() is
    unavailable.
    """
    override = os.environ.get("SOUND_RAZOR_THREADS")
    if override:
        try:
            return max(1, int(override))
        except ValueError:
            pass
    count = os.cpu_count() or 1
    return max(1, count - 1)
