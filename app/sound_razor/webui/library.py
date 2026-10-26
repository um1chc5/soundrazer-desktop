"""Project library state and progress parsing for the local web UI."""

from collections import deque
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from ..projects import (atomic_json, describe_project, import_project, list_projects,
                       project_path, save_metadata, cover_path, metadata_fields)
from ..projects.metadata import MetadataLookup
from ..audio.sources import youtube_url, youtube_command
from ..tools import MISSING_FFMPEG, ensure_ffmpeg_on_path
from ..setup_env import (FFMPEG_SIZE_MB, RUNTIME_SIZE_MB, SEPARATION_SIZE_MB, YOUTUBE_SIZE_MB,
                         ffmpeg_ok, runtime_ok, separation_ok, youtube_ok, run_setup)

CUSTOM_STEMS = ("vocals", "guitar", "bass", "drums", "piano", "other")


def selection_stems(preset, stems=None):
    if preset == "vocals":
        return ["vocals", "instrumental"]
    if preset != "custom":
        raise ValueError("Choose vocals/instrumental or custom separation.")
    if not isinstance(stems, list) or not stems:
        raise ValueError("Select at least one instrument.")
    if any(not isinstance(stem, str) or stem not in CUSTOM_STEMS for stem in stems):
        raise ValueError("Unknown custom stem.")
    return list(dict.fromkeys(stems))


# tqdm bars from audio-separator, e.g. " 45%|████▌     | 23/51 [00:12<00:15,  1.80it/s]"
TQDM = re.compile(r"(\d{1,3})%\|[^|]*\|[^\[]*\[([\d:]+)<([\d:]+|\?)")
GUITAR_PROGRESS = re.compile(r"^Guitar split (\d{1,3})%")
# (marker printed by the CLI, phase, overall progress when the phase starts)
PHASE_MARKERS = (("Preparing audio", "prepare", 2), ("Loading model", "load", 6),
                 ("Downloading ", "download", 6), ("Separating with", "separate", 12),
                 ("Splitting guitar", "separate", 12), ("Writing stems", "finalize", 96))
SEPARATE_RANGE = (12, 95)
YTDLP_PROGRESS = re.compile(r"\[download\]\s+([\d.]+)%(?:.*ETA\s+([\d:]+))?")


def clock_seconds(text: str):
    try:
        parts = [int(part) for part in text.split(":")]
    except ValueError:
        return None
    total = 0
    for part in parts:
        total = total * 60 + part
    return total


class Library:
    def __init__(self, root: Path | None, config: Path, cache: Path, default_root: Path = Path("output"),
                 window=None):
        self.lock = threading.RLock()
        self.config = config.resolve()
        self.cache = cache.resolve()
        self.default_root = default_root.resolve()
        # Set by ui_entrypoint.py when running as a desktop window (None for the plain
        # `sound-razor ui` browser CLI). Lets the custom title bar's minimize/maximize/
        # close/drag buttons reach the window over the same HTTP API as everything else,
        # instead of depending on pywebview's own JS bridge (unreliable in practice:
        # window.pywebview never actually materializes in this environment).
        self.window = window
        self.root = None
        self.job = None
        self.process = None
        self.worker = None
        self.logs = deque(maxlen=160)
        self.lookup = MetadataLookup()
        if root is not None:
            self.set_root(str(root), create=True)
        elif self.config.exists():
            try:
                saved = Path(json.loads(self.config.read_text())["root"])
                if saved.is_dir():
                    self.root = saved.resolve()
            except (ValueError, KeyError, OSError):
                pass
        if self.root is None:
            try:
                self.set_root(str(self.default_root), create=True)
            except (ValueError, OSError):
                pass

    def running(self):
        return self.job is not None and self.job["status"] in {"running", "cancelling"}

    def set_root(self, value: str, create=False):
        if not isinstance(value, str) or not value.strip():
            raise ValueError("Choose a projects folder.")
        with self.lock:
            if self.running() or self.worker is not None and self.worker.is_alive():
                raise ValueError("Wait for the current job to finish or cancel it before changing folders.")
            root = Path(value).expanduser().resolve()
            if create:
                root.mkdir(parents=True, exist_ok=True)
            if not root.is_dir():
                raise ValueError("Folder does not exist. Enable ‘Create folder’ to create it.")
            # Check readable listing now, before persisting the selection.
            list(root.iterdir())
            self.config.parent.mkdir(parents=True, exist_ok=True)
            atomic_json(self.config, {"root": str(root)})
            self.root = root
            self.job = None

    def require_root(self):
        if self.root is None:
            raise ValueError("Choose a projects folder first.")
        return self.root

    def require_matching_root(self, expected_root):
        root = self.require_root()
        if expected_root != str(root):
            raise ValueError("The projects folder changed. Refresh the library and reopen this action.")
        return root

    def state(self):
        with self.lock:
            job = dict(self.job) if self.job else None
            if job:
                job["logs"] = list(self.logs)
            return {"root": str(self.root) if self.root else None, "default_root": str(self.default_root),
                    "projects": list_projects(self.root) if self.root else [], "job": job,
                    "setup": self.setup_status(), "now": time.time()}

    def _track_progress(self, line: str) -> bool:
        """Update the job's phase/progress/ETA from a CLI output line. True hides the line from the log."""
        job = self.job
        for marker, phase, floor in PHASE_MARKERS:
            if line.startswith(marker):
                job["phase"] = phase
                job["progress"] = max(job["progress"], floor)
                if phase == "separate":
                    job["phase_started"] = time.time()
                if phase in {"finalize", "download"}:
                    job["eta"] = None
                return False
        bar = TQDM.search(line)
        step = bar or GUITAR_PROGRESS.match(line)
        if not step:
            return False
        if job["phase"] == "separate":
            low, high = SEPARATE_RANGE
            percent = min(100, int(step.group(1)))
            job["progress"] = max(job["progress"], low + (high - low) * percent / 100)
            remaining = clock_seconds(bar.group(3)) if bar else None
            if remaining is None and percent:
                spent = time.time() - job.get("phase_started", job["started"])
                remaining = spent * (100 - percent) / percent
            if remaining is not None:
                job["eta"] = remaining + 3  # writing stems afterwards takes a few seconds
                job["eta_at"] = time.time()
        return True

    def start(self, identifier: str, preset: str, stems=None, *, guitar_split=False):
        with self.lock:
            if self.running() or self.worker is not None and self.worker.is_alive():
                raise ValueError("Another download or separation is already running.")
            chosen = ['lead', 'rhythm'] if guitar_split else selection_stems(preset, stems)
            project = project_path(self.require_root(), identifier)
            info = describe_project(project)
            if not guitar_split and not info["original"]:
                raise ValueError("This project needs an unambiguous original audio file.")
            if (project / "stems").is_symlink():
                raise ValueError("The stems folder must not be a symlink.")
            if guitar_split:
                if 'guitar.wav' not in {item['file'] for item in info['stems']}:
                    raise ValueError('Separate the guitar track first.')
                if any(p.is_symlink() or not p.is_file() for p in (project/'stems').iterdir()):
                    raise ValueError('The stems folder must contain regular files only.')
                if any((project/'stems'/name).exists() for name in ('lead.wav', 'rhythm.wav')):
                    raise ValueError('This project already contains lead or rhythm tracks.')
            self.logs.clear()
            self.job = {"id": uuid.uuid4().hex, "project": identifier, "status": "running",
                        "started": time.time(), "finished": None, "error": None,
                        "preset": preset, "stems": chosen, "guitar_split": guitar_split,
                        "phase": "prepare", "progress": 0, "eta": None}
            self.worker = threading.Thread(target=self._separate, args=(project, info["original"], chosen, guitar_split), daemon=True)
            self.worker.start()
            return dict(self.job)

    def import_youtube(self, data):
        url = youtube_url(data.get('url'))
        fields = metadata_fields(data)
        with self.lock:
            root = self.require_root()
            if data.get('root') != str(root):
                raise ValueError('The projects folder changed. Reopen YouTube import.')
            if self.running() or self.worker is not None and self.worker.is_alive():
                raise ValueError('Another download or separation is already running.')
            if importlib.util.find_spec('yt_dlp') is None:
                raise ValueError('Install YouTube support: uv pip install --python .venv/bin/python -e ".[youtube]"')
            if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
                raise ValueError(MISSING_FFMPEG)
            self.logs.clear()
            self.job = {'id': uuid.uuid4().hex, 'kind': 'youtube', 'project': None,
                        'status': 'running', 'started': time.time(), 'finished': None, 'error': None,
                        'phase': 'download', 'progress': 0, 'eta': None}
            self.worker = threading.Thread(target=self._youtube, args=(root, url, fields), daemon=True)
            self.worker.start()
            return dict(self.job)

    def setup_status(self):
        stages = [
            {"id": "runtime", "label": "Python runtime & app packages", "size_mb": RUNTIME_SIZE_MB,
             "required": True, "missing": not runtime_ok(), "done": runtime_ok()},
            {"id": "ffmpeg", "label": "FFmpeg (audio conversion)", "size_mb": FFMPEG_SIZE_MB,
             "required": True, "missing": not ffmpeg_ok(), "done": ffmpeg_ok()},
            {"id": "separation", "label": "Separation engine (PyTorch, etc.)", "size_mb": SEPARATION_SIZE_MB,
             "required": True, "missing": not separation_ok(), "done": separation_ok()},
            {"id": "youtube", "label": "YouTube import support (yt-dlp)", "size_mb": YOUTUBE_SIZE_MB,
             "required": False, "missing": not youtube_ok(), "done": youtube_ok()},
        ]
        return {"required": any(s["required"] and s["missing"] for s in stages),
                "stages": stages,
                "total_mb": sum(s["size_mb"] for s in stages if s["missing"])}

    def start_setup(self, stages: list[str]):
        with self.lock:
            if self.running() or self.worker is not None and self.worker.is_alive():
                raise ValueError("Another download or separation is already running.")
            allowed = {"ffmpeg", "separation", "youtube"}
            stages = [stage for stage in stages if stage in allowed]
            if not stages:
                raise ValueError("Nothing to set up.")
            self.logs.clear()
            self.job = {"id": uuid.uuid4().hex, "kind": "setup", "project": None,
                        "status": "running", "started": time.time(), "finished": None, "error": None,
                        "phase": "prepare", "progress": 0, "eta": None,
                        "stages": stages, "stage": None}
            self.worker = threading.Thread(target=self._setup, args=(stages,), daemon=True)
            self.worker.start()
            return dict(self.job)

    def _setup(self, stages: list[str]):
        try:
            run_setup(self, stages)
        except Exception as error:
            with self.lock:
                if self.job and self.job["status"] != "cancelling":
                    self.job.update(status="failed", error=str(error))
        finally:
            with self.lock:
                if self.job and self.job["status"] == "cancelling":
                    self.job["status"] = "cancelled"
                if self.job:
                    self.job["finished"] = time.time()
                self.process = None

    def _youtube(self, root, url, fields):
        try:
            with tempfile.TemporaryDirectory(prefix='.youtube-', dir=root) as temporary:
                work = Path(temporary)
                with self.lock:
                    if self.job['status'] == 'cancelling':
                        return
                    self.process = subprocess.Popen(youtube_command(url, work), stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, text=True, errors='replace',
                        env=dict(os.environ, PYTHONUNBUFFERED='1'), start_new_session=True)
                    process = self.process
                for line in process.stdout:
                    line = line.strip()
                    with self.lock:
                        download = YTDLP_PROGRESS.search(line)
                        if download:
                            self.job['progress'] = max(self.job['progress'], float(download.group(1)))
                            self.job['eta'] = clock_seconds(download.group(2)) if download.group(2) else None
                            self.job['eta_at'] = time.time()
                        elif line:
                            self.logs.append(line[-2000:])
                code = process.wait()
                process.stdout.close()
                with self.lock:
                    if self.job['status'] == 'cancelling':
                        return
                    if code:
                        raise ValueError(f'YouTube download failed (exit {code}). See the download log.')
                    info = json.loads((work/'source.info.json').read_text())
                    defaults = {'title': info.get('track') or info.get('title') or 'YouTube recording',
                                'artist': info.get('artist') or info.get('creator') or '',
                                'album': info.get('album') or '',
                                'year': str(info.get('release_year') or info.get('release_date') or '')[:4]}
                    chosen = {key: fields[key] or str(defaults[key])[:500] for key in defaults}
                    result = import_project(root, work/'source.wav', 'original.wav', chosen,
                                            origin={'provider': 'YouTube', 'url': url})
                    self.job.update(status='succeeded', project=result['id'])
        except Exception as error:
            with self.lock:
                if self.job['status'] != 'cancelling':
                    self.job.update(status='failed', error=str(error))
        finally:
            with self.lock:
                if self.job['status'] == 'cancelling':
                    self.job['status'] = 'cancelled'
                self.job['finished'] = time.time()
                self.process = None

    def _separate(self, project: Path, original: str, stems: list[str], guitar_split=False):
        try:
            with tempfile.TemporaryDirectory(prefix=".separation-", dir=project) as temporary:
                stage = Path(temporary) / "stems"
                if guitar_split:
                    shutil.copytree(project/'stems', stage)
                    command = [sys.executable, '-m', 'sound_razor', 'split-guitar',
                               '--file', str(stage/'guitar.wav'), '--output', str(stage), '--cache', str(self.cache)]
                else:
                    command = [sys.executable, "-m", "sound_razor", "separate", "--file", str(project / original),
                               "--output", str(stage), "--cache", str(self.cache), "--stems", *stems]
                env = dict(os.environ, PYTHONUNBUFFERED="1", ORT_DISABLE_TELEMETRY="1")
                with self.lock:
                    if self.job["status"] == "cancelling":
                        return
                    self.process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                                    text=True, errors="replace", env=env, start_new_session=True)
                    process = self.process
                for line in process.stdout:
                    line = line.strip()
                    with self.lock:
                        if line and not self._track_progress(line):
                            self.logs.append(line[-2000:])
                code = process.wait()
                process.stdout.close()
                with self.lock:
                    if self.job["status"] == "cancelling":
                        return
                if code != 0:
                    raise RuntimeError(f"Separation CLI exited with code {code}. See the process log.")
                for stem in stems:
                    path = stage / f"{stem}.wav"
                    if not path.is_file() or path.stat().st_size <= 44:
                        raise RuntimeError(f"CLI did not produce {stem}.wav.")
                # Publish only a successful run; preserve the old stems on failure.
                with self.lock:
                    if self.job["status"] == "cancelling":
                        return
                    destination = project / "stems"
                    backup = Path(temporary) / "previous-stems"
                    if destination.exists():
                        destination.rename(backup)
                    try:
                        stage.rename(destination)
                    except BaseException:
                        if backup.exists():
                            backup.rename(destination)
                        raise
                    self.job.update(status="succeeded", progress=100, phase="done", eta=0)
        except Exception as error:
            with self.lock:
                if self.job["status"] != "cancelling":
                    self.job.update(status="failed", error=str(error))
        finally:
            with self.lock:
                if self.job["status"] == "cancelling":
                    self.job["status"] = "cancelled"
                self.job["finished"] = time.time()
                self.process = None

    def delete(self, identifier: str, expected_root: str):
        with self.lock:
            root = self.require_root()
            if expected_root != str(root):
                raise ValueError("The projects folder changed. Reopen the deletion dialog.")
            project = project_path(root, identifier)
            if self.job and self.job["project"] == identifier:
                if self.running() or self.worker is not None and self.worker.is_alive():
                    raise ValueError("Wait for separation to finish or cancel it before deleting this song.")
            shutil.rmtree(project)
            if self.job and self.job["project"] == identifier:
                self.job = None
                self.logs.clear()
            return {"ok": True}

    def cancel(self):
        with self.lock:
            if not self.running():
                return
            self.job["status"] = "cancelling"
            process = self.process
            if process and process.poll() is None:
                try:
                    if os.name == "posix":
                        os.killpg(process.pid, signal.SIGTERM)
                    else:
                        process.terminate()
                except ProcessLookupError:
                    pass
        if process:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    if os.name == "posix":
                        os.killpg(process.pid, signal.SIGKILL)
                    else:
                        process.kill()
                except ProcessLookupError:
                    pass

    def window_action(self, action: str, data: dict | None = None):
        if self.window is None:
            raise ValueError("Not running as a desktop window.")
        data = data or {}
        if action == "minimize":
            self.window.minimize()
        elif action == "toggle-maximize":
            return {"maximized": self.window.toggle_maximize()}
        elif action == "close":
            self.window.close()
        elif action == "bounds":
            return self.window.bounds()
        elif action == "move":
            self.window.move_to(data.get("x"), data.get("y"))
        elif action == "resize":
            self.window.resize_to(data.get("width"), data.get("height"), data.get("direction", ""))
        else:
            raise ValueError("Unknown window action.")
        return {"ok": True}
