"""Project library state, job queue, and progress parsing for the local web UI."""

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
                        project_path, save_metadata, cover_path, metadata_fields, stem_file)
from ..projects.metadata import MetadataLookup
from ..audio.sources import youtube_url, youtube_command
from ..audio.pipeline import probe_duration, parse_trim
from ..audio.exports import FORMATS, export_stems
from ..tools import MISSING_FFMPEG, app_version, ensure_ffmpeg_on_path
from ..setup_env import (FFMPEG_SIZE_MB, RUNTIME_SIZE_MB, SEPARATION_SIZE_MB, YOUTUBE_SIZE_MB,
                         ffmpeg_ok, runtime_ok, separation_ok, youtube_ok, run_setup)

CUSTOM_STEMS = ("vocals", "guitar", "bass", "drums", "piano", "other")
# A plan may also fold in the guitar-split outputs; they are produced mid-run.
PLAN_GROUP_STEMS = (*CUSTOM_STEMS, "lead", "rhythm")

# Staging-directory prefixes left behind by interrupted runs. The startup sweep only
# removes directories matching these prefixes, never follows symlinks, and never
# deletes outside the projects root.
STALE_STAGING_PREFIXES = (
    ".separation-", ".youtube-", ".import-", ".exports-", ".guitar-split-",
    ".stems-", ".model-download-",
)
STALE_STAGING_MAX_AGE_HOURS = 24


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


def validate_group(group):
    """None keeps the legacy `--stems other,…` folding; a list is an explicit plan."""
    if group is None:
        return None
    if not isinstance(group, list):
        raise ValueError("Invalid stem plan.")
    if any(not isinstance(name, str) or name not in PLAN_GROUP_STEMS for name in group):
        raise ValueError("Unknown stem in the plan.")
    return list(dict.fromkeys(group))


def plan_stems(preset, stems, group=None):
    """Own files for a job. An explicit plan may keep none of them, as long as
    something is folded; the empty list is then deliberate, not a mistake."""
    if group is None:
        return selection_stems(preset, stems)
    if not isinstance(stems, list):
        raise ValueError("Invalid stem plan.")
    if any(not isinstance(stem, str) or stem not in CUSTOM_STEMS for stem in stems):
        raise ValueError("Unknown custom stem.")
    chosen = list(dict.fromkeys(stems))
    if not chosen and not group:
        raise ValueError("Select at least one instrument.")
    return chosen


# tqdm bars from audio-separator, e.g. " 45%|████▌     | 23/51 [00:12<00:15,  1.80it/s]"
TQDM = re.compile(r"(\d{1,3})%\|[^|]*\|[^\[]*\[([\d:]+)<([\d:]+|\?)")
GUITAR_PROGRESS = re.compile(r"^Guitar split (\d{1,3})%")
# (marker printed by the CLI, phase, overall progress when the phase starts)
PHASE_MARKERS = (("Preparing audio", "prepare", 2), ("Loading model", "load", 6),
                 ("Downloading ", "download", 6), ("Separating with", "separate", 12),
                 ("Splitting guitar", "separate", 12), ("Writing stems", "finalize", 96),
                 ("Exporting stems", "export", 2), ("Exported ", "finalize", 96))
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


APP_VERSION = app_version()


def public_job(job: dict) -> dict:
    """A job record for the API: worker-only "_" fields hold Paths, which JSON can't encode."""
    return {key: value for key, value in job.items() if not key.startswith("_")}


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
        # Job queue: pending jobs (status "queued") in FIFO order, plus active jobs.
        # Phase 2 of spec 05 supports a configurable concurrency cap (default 1),
        # so `self.processes` maps job_id -> subprocess and `self.active` is a set
        # of active job ids. Each active job runs in its own worker thread.
        self.queue = []              # pending job records
        self.active = set()          # set of active job ids
        self.active_jobs = {}        # job_id -> job record for active jobs
        self.processes = {}          # job_id -> subprocess.Popen
        self.job_logs = {}           # job_id -> deque(maxlen=160)
        self.finished_jobs = deque(maxlen=20)  # recent finished records, for UI notices
        self._drainer = None         # coordinator thread that starts workers up to cap
        self._job_done = threading.Event()  # set when any active job finishes
        self.max_concurrent_jobs = self._derive_max_concurrent_jobs()
        # Backward-compat aliases used by setup_env.py: while a job runs these point at
        # the most recently started active job's record / logs / process.
        self.job = None
        self.logs = deque(maxlen=160)
        self.process = None
        self.lookup = MetadataLookup()
        if root is not None:
            self.set_root(str(root), create=True)
        elif self.config.exists():
            try:
                saved = Path(json.loads(self.config.read_text(encoding='utf-8'))["root"])
                if saved.is_dir():
                    self.root = saved.resolve()
            except (ValueError, KeyError, OSError):
                pass
        if self.root is None:
            try:
                self.set_root(str(self.default_root), create=True)
            except (ValueError, OSError):
                pass
        # Sweep staging directories left behind by interrupted runs on startup.
        if self.root is not None:
            self.sweep_stale_staging()

    def _derive_max_concurrent_jobs(self) -> int:
        """Derive suggested default concurrency cap.

        - 1 on CPU-only machines
        - 2-3 when torch.cuda.is_available()
        - Never more than max(1, available_ram_gb // 3)
        Override with SOUND_RAZOR_MAX_CONCURRENT_JOBS env var.
        """
        import os as _os
        override = _os.environ.get("SOUND_RAZOR_MAX_CONCURRENT_JOBS")
        if override:
            try:
                return max(1, int(override))
            except ValueError:
                pass
        try:
            import torch
            has_cuda = torch.cuda.is_available()
        except Exception:
            has_cuda = False
        try:
            ram_gb = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / (1024 ** 3)
        except (AttributeError, OSError, ValueError):
            ram_gb = 8.0
        cap = 3 if has_cuda else 1
        ram_cap = max(1, int(ram_gb // 3))
        return min(cap, ram_cap)

    def running(self):
        return bool(self.active)

    def _active_jobs(self) -> list[dict]:
        """Return the job records for all active job ids."""
        return [self.active_jobs[jid] for jid in self.active if jid in self.active_jobs]

    def set_root(self, value: str, create=False):
        if not isinstance(value, str) or not value.strip():
            raise ValueError("Choose a projects folder.")
        with self.lock:
            if self.running():
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

    def sweep_stale_staging(self, max_age_hours: int | None = None) -> list[str]:
        """Remove stale staging directories left behind by interrupted runs.

        Only directories under ``self.root`` whose names match a known staging
        prefix are considered, symlinks are never followed, and nothing outside
        the projects root is ever deleted. Returns the list of removed paths.
        """
        max_age_hours = STALE_STAGING_MAX_AGE_HOURS if max_age_hours is None else max_age_hours
        if self.root is None or not self.root.is_dir():
            return []
        cutoff = time.time() - max_age_hours * 3600
        removed: list[str] = []
        for entry in self.root.iterdir():
            if not entry.is_dir() or entry.is_symlink():
                continue
            if not entry.name.startswith(STALE_STAGING_PREFIXES):
                continue
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            if mtime >= cutoff:
                continue
            try:
                shutil.rmtree(entry)
                removed.append(str(entry))
            except OSError:
                # Best effort: a locked/in-use staging dir stays for diagnosis.
                pass
        return removed

    def require_matching_root(self, expected_root):
        root = self.require_root()
        if expected_root != str(root):
            raise ValueError("The projects folder changed. Refresh the library and reopen this action.")
        return root

    def _job_logs(self, job_id: str) -> deque:
        return self.job_logs.setdefault(job_id, deque(maxlen=160))

    def state(self):
        with self.lock:
            jobs = []
            for job_id in self.active:
                job = self.active_jobs.get(job_id)
                if not job:
                    continue
                active = public_job(job)
                active["position"] = 0
                active["logs"] = list(self._job_logs(job_id))
                jobs.append(active)
            for index, job in enumerate(self.queue, start=1):
                record = public_job(job)
                record["position"] = index
                record["logs"] = list(self._job_logs(job["id"]))
                jobs.append(record)
            # `job` shim: the most recently started active job so success/failure
            # notices still surface after workers exit.
            job_shim = public_job(self.job) if self.job else None
            return {"root": str(self.root) if self.root else None, "default_root": str(self.default_root),
                    "projects": list_projects(self.root) if self.root else [], "jobs": jobs,
                    "active_job": next(iter(self.active)) if self.active else None,
                    "active_jobs": [jid for jid in self.active],
                    "max_concurrent_jobs": self.max_concurrent_jobs,
                    "job": job_shim,
                    "finished_jobs": [public_job(job) for job in self.finished_jobs],
                    "setup": self.setup_status(), "version": APP_VERSION, "now": time.time()}

    def _track_progress(self, job: dict, line: str) -> bool:
        """Update a specific job's phase/progress/ETA from a CLI output line.
        True hides the line from the log."""
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

    # ------------------------------------------------------------------ enqueue

    def _enqueue(self, job: dict):
        """Append a queued job and start the drainer thread if it is not running."""
        self.queue.append(job)
        self._ensure_drainer()
        return public_job(job)

    def _ensure_drainer(self):
        if self._drainer is None or not self._drainer.is_alive():
            self._drainer = threading.Thread(target=self._drain, daemon=True)
            self._drainer.start()

    def _drain(self):
        """Start worker threads for queued jobs up to max_concurrent_jobs.

        Exits when the queue is empty and no active jobs remain.
        """
        while True:
            with self.lock:
                if not self.queue and not self.active:
                    self._drainer = None
                    self.process = None
                    self.logs = deque(maxlen=160)
                    return
                started = []
                while len(self.active) < self.max_concurrent_jobs:
                    job = self._next_startable()
                    if job is None:
                        break
                    self.queue.remove(job)
                    self.active.add(job["id"])
                    self.active_jobs[job["id"]] = job
                    job["status"] = "running"
                    job["started"] = time.time()
                    self.job_logs.setdefault(job["id"], deque(maxlen=160))
                    # Backward-compat shims point to the latest started job.
                    self.job = job
                    self.logs = self._job_logs(job["id"])
                    started.append(job)
            if not started:
                # All cap slots filled; wait for a worker to signal completion.
                self._job_done.wait(timeout=1.0)
                self._job_done.clear()
                continue
            for job in started:
                thread = threading.Thread(target=self._run_job, args=(job,), daemon=True)
                thread.start()

    def _next_startable(self):
        """First queued job that may start now, keeping FIFO order where it matters.

        Setup runs alone: it reinstalls packages the other jobs import, and
        setup_env reports through the single `self.job`/`self.logs`/`self.process`
        aliases. Two jobs on one project never overlap, because each one swaps
        the project's whole stems folder when it publishes.
        """
        active = self._active_jobs()
        if any(job["kind"] == "setup" for job in active):
            return None
        busy = {job.get("project") for job in active if job.get("project")}
        for job in self.queue:
            if job["kind"] == "setup":
                # Wait for running jobs to drain; nothing queued after setup jumps it.
                return None if active else job
            if job.get("project") and job["project"] in busy:
                continue
            return job
        return None

    def _finish(self, job: dict):
        """Mark a worker's own job record finished. Caller holds the lock."""
        if job["status"] == "cancelling":
            job["status"] = "cancelled"
        job["finished"] = time.time()
        self.processes.pop(job["id"], None)
        self.finished_jobs.append(job)
        # Point the UI's single-job shim at the finished job unless another is still running,
        # so its success/failure notice still surfaces.
        others = [other for other in self._active_jobs() if other is not job]
        if not others:
            self.job = job

    def _launch(self, job: dict, command, **options):
        """Start a job's subprocess unless it is being cancelled. Caller holds the lock."""
        if job["status"] == "cancelling":
            return None
        process = subprocess.Popen(command, **options)
        self.processes[job["id"]] = process
        self.process = process
        return process

    def _run_job(self, job: dict):
        """Run a single job's worker, then signal completion and clean up."""
        job_id = job["id"]
        kind = job["kind"]
        try:
            if kind == "separate":
                self._separate(job, job["_project"], job["_original"], job["_stems"],
                               job.get("_group"), job.get("_split_leaves", False), job["_trim"])
            elif kind == "split-guitar":
                self._separate(job, job["_project"], job["_original"], job["_stems"],
                               None, False, job["_trim"])
            elif kind == "youtube":
                self._youtube(job, job["_root"], job["_url"], job["_fields"])
            elif kind == "setup":
                self._setup(job, job["_stages"])
            elif kind == "export":
                self._export(job, job["_project"], job["_formats"], job["_stems"],
                             job["_prevent_clipping"])
        finally:
            with self.lock:
                if job["finished"] is None:
                    self._finish(job)
                self.active.discard(job_id)
                self.active_jobs.pop(job_id, None)
                if not self.active:
                    self.process = None
            self._job_done.set()

    # ---------------------------------------------------------------- start

    def start(self, identifier: str, preset: str, stems=None, *, group=None,
              split_leaves=False, guitar_split=False, trim=None):
        with self.lock:
            chosen_group = validate_group(group)
            chosen = ['lead', 'rhythm'] if guitar_split else plan_stems(preset, stems, chosen_group)
            project = project_path(self.require_root(), identifier)
            info = describe_project(project)
            if not guitar_split and not info["original"]:
                raise ValueError("This project needs an unambiguous original audio file.")
            if (project / "stems").is_symlink():
                raise ValueError("The stems folder must not be a symlink.")
            if split_leaves and guitar_split:
                raise ValueError("A split-only job cannot also split the guitar.")
            return self._enqueue_separation(identifier, preset, chosen, chosen_group,
                                            split_leaves, guitar_split, info, project, trim)

    def _start_trim(self, project, info, guitar_split, trim):
        if trim is None:
            return None
        if guitar_split:
            guitar = stem_file(project / 'stems', 'guitar')
            return parse_trim(trim, probe_duration(project / 'stems' / guitar), 2.0)
        return parse_trim(trim, probe_duration(project / info["original"]), 1.0)

    def _validate_split_job(self, project, info):
        guitar = stem_file(project / 'stems', 'guitar')
        if guitar not in {item['file'] for item in info['stems']}:
            raise ValueError('Separate the guitar track first.')
        if any(p.is_symlink() or not p.is_file() for p in (project / 'stems').iterdir()):
            raise ValueError('The stems folder must contain regular files only.')
        if any((project / 'stems' / f'{name}{ext}').exists()
               for name in ('lead', 'rhythm') for ext in ('.flac', '.wav')):
            raise ValueError('This project already contains lead or rhythm tracks.')
        return project / 'stems' / guitar

    def _enqueue_separation(self, identifier, preset, chosen, chosen_group, split_leaves,
                            guitar_split, info, project, trim):
        if guitar_split:
            self._validate_split_job(project, info)
        saved_trim = self._start_trim(project, info, guitar_split, trim)
        job = {"id": uuid.uuid4().hex, "kind": "split-guitar" if guitar_split else "separate",
               "project": identifier, "status": "queued",
               "started": time.time(), "finished": None, "error": None,
               "preset": preset, "stems": chosen, "group": chosen_group or [],
               "guitar_split": guitar_split, "split_leaves": bool(split_leaves),
               "trim": {"start": saved_trim[0], "end": saved_trim[1]} if saved_trim else None,
               "phase": "prepare", "progress": 0, "eta": None,
               "_project": project, "_original": info["original"],
               "_stems": chosen, "_group": chosen_group,
               "_split_leaves": bool(split_leaves), "_trim": saved_trim}
        return self._enqueue(job)

    def import_youtube(self, data):
        url = youtube_url(data.get('url'))
        fields = metadata_fields(data)
        with self.lock:
            root = self.require_root()
            if data.get('root') != str(root):
                raise ValueError('The projects folder changed. Reopen YouTube import.')
            if importlib.util.find_spec('yt_dlp') is None:
                raise ValueError('YouTube support is not installed. Click "Install YouTube support" above the link box.')
            if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
                raise ValueError(MISSING_FFMPEG)
            job = {'id': uuid.uuid4().hex, 'kind': 'youtube', 'project': None,
                   'status': 'queued', 'started': time.time(), 'finished': None, 'error': None,
                   'phase': 'download', 'progress': 0, 'eta': None,
                   '_root': root, '_url': url, '_fields': fields}
            return self._enqueue(job)

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
            allowed = {"ffmpeg", "separation", "youtube"}
            stages = [stage for stage in stages if stage in allowed]
            if not stages:
                raise ValueError("Nothing to set up.")
            job = {"id": uuid.uuid4().hex, "kind": "setup", "project": None,
                   "status": "queued", "started": time.time(), "finished": None, "error": None,
                   "phase": "prepare", "progress": 0, "eta": None,
                   "stages": stages, "stage": None,
                   "_stages": stages}
            return self._enqueue(job)

    # ---------------------------------------------------------------- workers

    def _setup(self, job, stages: list[str]):
        try:
            run_setup(self, stages)
        except Exception as error:
            with self.lock:
                if job["status"] != "cancelling":
                    job.update(status="failed", error=str(error))
        finally:
            with self.lock:
                self._finish(job)

    def _youtube(self, job, root, url, fields):
        job_id = job["id"]
        try:
            with tempfile.TemporaryDirectory(prefix='.youtube-', dir=root) as temporary:
                work = Path(temporary)
                with self.lock:
                    process = self._launch(job, youtube_command(url, work), stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace',
                        env=dict(os.environ, PYTHONUNBUFFERED='1', PYTHONIOENCODING='utf-8'), start_new_session=True)
                    if process is None:
                        return
                for line in process.stdout:
                    line = line.strip()
                    with self.lock:
                        download = YTDLP_PROGRESS.search(line)
                        if download:
                            job['progress'] = max(job['progress'], float(download.group(1)))
                            job['eta'] = clock_seconds(download.group(2)) if download.group(2) else None
                            job['eta_at'] = time.time()
                        elif line:
                            self._job_logs(job_id).append(line[-2000:])
                code = process.wait()
                process.stdout.close()
                with self.lock:
                    if job['status'] == 'cancelling':
                        return
                    if code:
                        raise ValueError(f'YouTube download failed (exit {code}). See the download log.')
                    # yt-dlp writes UTF-8; Windows' default cp1252 chokes on non-ASCII titles.
                    info = json.loads((work/'source.info.json').read_text(encoding='utf-8'))
                    defaults = {'title': info.get('track') or info.get('title') or 'YouTube recording',
                                'artist': info.get('artist') or info.get('creator') or '',
                                'album': info.get('album') or '',
                                'year': str(info.get('release_year') or info.get('release_date') or '')[:4]}
                    chosen = {key: fields[key] or str(defaults[key])[:500] for key in defaults}
                    result = import_project(root, work/'source.wav', 'original.wav', chosen,
                                            origin={'provider': 'YouTube', 'url': url})
                    job.update(status='succeeded', project=result['id'])
        except Exception as error:
            with self.lock:
                if job['status'] != 'cancelling':
                    job.update(status='failed', error=str(error))
        finally:
            with self.lock:
                self._finish(job)

    def _separate(self, job, project: Path, original: str, stems: list[str],
                  group=None, split_leaves=False, trim=None):
        job_id = job["id"]
        try:
            with tempfile.TemporaryDirectory(prefix=".separation-", dir=project) as temporary:
                stage = Path(temporary) / "stems"
                command = self._separation_command(job, project, original, stage,
                                                   stems, group, split_leaves, trim)
                # UTF-8 both ways, so non-ASCII song titles and paths survive the pipe on Windows.
                env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8", ORT_DISABLE_TELEMETRY="1")
                with self.lock:
                    process = self._launch(job, command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                           text=True, encoding="utf-8", errors="replace", env=env, start_new_session=True)
                    if process is None:
                        return
                job_logs = self._job_logs(job_id)
                for line in process.stdout:
                    line = line.strip()
                    with self.lock:
                        if line and not self._track_progress(job, line):
                            job_logs.append(line[-2000:])
                code = process.wait()
                process.stdout.close()
                with self.lock:
                    if job["status"] == "cancelling":
                        return
                if code != 0:
                    raise RuntimeError(f"Separation CLI exited with code {code}. See the process log.")
                self._expect_outputs(stage, stems, group)
                # Publish only a successful run; preserve the old stems on failure.
                with self.lock:
                    if job["status"] == "cancelling":
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
                    job.update(status="succeeded", progress=100, phase="done", eta=0)
        except Exception as error:
            with self.lock:
                if job["status"] != "cancelling":
                    job.update(status="failed", error=str(error))
        finally:
            with self.lock:
                self._finish(job)

    def _separation_command(self, job, project: Path, original: str, stage: Path,
                            stems: list[str], group, split_leaves: bool, trim):
        range_args = ["--start", f"{trim[0]:.3f}", "--end", f"{trim[1]:.3f}"] if trim else []
        if job["kind"] == "split-guitar":
            shutil.copytree(project / 'stems', stage)
            return [sys.executable, '-m', 'sound_razor', 'split-guitar',
                    '--file', str(stage / stem_file(stage, 'guitar')), '--output', str(stage),
                    '--cache', str(self.cache), *range_args]
        command = [sys.executable, "-m", "sound_razor", "separate", "--file", str(project / original),
                   "--output", str(stage), "--cache", str(self.cache)]
        if group is not None:
            # An explicit plan may legitimately keep no stem of its own, so send
            # --stems unconditionally (nargs="*") to mean "own files = these".
            command += ["--stems", *stems]
            if group:
                command += ["--group", *group]
        elif stems:
            command += ["--stems", *stems]
        if split_leaves:
            command += ["--split-guitar"]
        return command + range_args

    def _expect_outputs(self, stage: Path, stems: list[str], group):
        """A merged stem must NOT reach the stage: only own files and other.flac do."""
        names = [*stems, *(['other'] if group else [])]
        for name in dict.fromkeys(names):
            path = stage / f"{name}.flac"
            if not path.is_file() or path.stat().st_size <= 44:
                raise RuntimeError(f"CLI did not produce {name}.flac.")

    def start_export(self, identifier: str, formats, stems, *, prevent_clipping=True):
        with self.lock:
            project = project_path(self.require_root(), identifier)
            info = describe_project(project)
            if not info["stems"]:
                raise ValueError("This project has no stems to export.")
            if not isinstance(formats, list) or not formats:
                raise ValueError("Choose at least one export format.")
            chosen_formats = []
            for format_id in formats:
                if not isinstance(format_id, str) or format_id not in FORMATS:
                    raise ValueError("Unknown export format.")
                if format_id not in chosen_formats:
                    chosen_formats.append(format_id)
            if not isinstance(stems, list) or not stems:
                raise ValueError("Choose at least one stem to export.")
            if not isinstance(prevent_clipping, bool):
                raise ValueError("Invalid clipping setting.")
            available = {item["file"] for item in info["stems"]}
            chosen_stems = []
            for name in stems:
                if not isinstance(name, str) or name not in available:
                    raise ValueError("Unknown stem to export.")
                if name not in chosen_stems:
                    chosen_stems.append(name)
            exports = project / "exports"
            if exports.is_symlink() or (exports.exists() and not exports.is_dir()):
                raise ValueError("The exports folder must be a real directory.")
            if not ensure_ffmpeg_on_path():
                raise ValueError(MISSING_FFMPEG)
            job = {"id": uuid.uuid4().hex, "kind": "export", "project": identifier,
                   "status": "queued", "started": time.time(), "finished": None, "error": None,
                   "formats": chosen_formats, "stems": chosen_stems,
                   "prevent_clipping": bool(prevent_clipping),
                   "phase": "prepare", "progress": 0, "eta": None,
                   "_project": project, "_formats": chosen_formats, "_stems": chosen_stems,
                   "_prevent_clipping": bool(prevent_clipping)}
            return self._enqueue(job)

    def _export(self, job, project: Path, formats: list[str], stems: list[str], prevent_clipping: bool):
        job_id = job["id"]
        try:
            def report(completed, total, label):
                with self.lock:
                    if job["status"] == "cancelling":
                        raise RuntimeError("Export cancelled.")
                    fraction = completed / total if total else 0
                    job["phase"] = "finalize" if completed >= total else "export"
                    job["progress"] = max(2, min(96, 2 + fraction * 93))
                    if fraction > 0.02:
                        job["eta"] = (time.time() - job["started"]) / fraction + 1
                        job["eta_at"] = time.time()

            def set_process(process):
                with self.lock:
                    if process is not None and job["status"] == "cancelling":
                        process.terminate()
                    if process is None:
                        self.processes.pop(job_id, None)
                    else:
                        self.processes[job_id] = process

            export_stems(project, stems, formats, prevent_clipping, report, set_process)
            with self.lock:
                if job["status"] != "cancelling":
                    job.update(status="succeeded", progress=100, phase="done", eta=0)
        except Exception as error:
            with self.lock:
                if job["status"] != "cancelling":
                    job.update(status="failed", error=str(error))
        finally:
            with self.lock:
                self._finish(job)

    # ---------------------------------------------------------------- delete / cancel

    def delete(self, identifier: str, expected_root: str):
        with self.lock:
            root = self.require_root()
            if expected_root != str(root):
                raise ValueError("The projects folder changed. Reopen the deletion dialog.")
            project = project_path(root, identifier)
            active_jobs = list(self.active_jobs.values()) + list(self.queue)
            for job in active_jobs:
                if job.get("project") == identifier:
                    if job["status"] in {"running", "cancelling", "queued"}:
                        raise ValueError("Wait for separation to finish or cancel it before deleting this song.")
            shutil.rmtree(project)
            if self.job and self.job.get("project") == identifier:
                self.job = None
                self.logs.clear()
            return {"ok": True}

    def _process_for(self, job: dict):
        """A job's subprocess. setup_env only sets the `process` alias, which is safe
        to use for setup because setup always runs alone. Caller holds the lock."""
        process = self.processes.get(job["id"])
        if process is None and job["kind"] == "setup":
            process = self.process
        return process

    def cancel(self, job_id: str | None = None):
        processes_to_wait = []
        with self.lock:
            if job_id:
                # Cancel a specific job: either active or waiting in the queue.
                target = None
                if job_id in self.active:
                    target = self.active_jobs.get(job_id)
                    if target:
                        target["status"] = "cancelling"
                        proc = self._process_for(target)
                        if proc:
                            processes_to_wait.append(proc)
                            if proc.poll() is None:
                                try:
                                    if os.name == "posix":
                                        os.killpg(proc.pid, signal.SIGTERM)
                                    else:
                                        proc.terminate()
                                except ProcessLookupError:
                                    pass
                else:
                    for index, job in enumerate(self.queue):
                        if job["id"] == job_id:
                            target = self.queue.pop(index)
                            target["status"] = "cancelled"
                            target["finished"] = time.time()
                            break
                    if target is None:
                        raise ValueError("Job not found in queue.")
            else:
                # Cancel all active jobs (used by close).
                if not self.running():
                    return
                for jid in list(self.active):
                    target = self.active_jobs.get(jid)
                    if target:
                        target["status"] = "cancelling"
                    proc = self._process_for(target) if target else None
                    if proc and proc.poll() is None:
                        processes_to_wait.append(proc)
                        try:
                            if os.name == "posix":
                                os.killpg(proc.pid, signal.SIGTERM)
                            else:
                                proc.terminate()
                        except ProcessLookupError:
                            pass
        for proc in processes_to_wait:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    if os.name == "posix":
                        os.killpg(proc.pid, signal.SIGKILL)
                    else:
                        proc.kill()
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
            if self.running() and not (data or {}).get("confirm"):
                return {
                    "confirm": True,
                    "message": "A separation or download is running. Closing will cancel it.",
                }
            self.cancel()  # cancels all active jobs
            # Cancel anything still waiting in the queue so nothing is left mid-run.
            with self.lock:
                for job in list(self.queue):
                    job["status"] = "cancelled"
                    job["finished"] = time.time()
                self.queue.clear()
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
