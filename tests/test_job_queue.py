import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from sound_razor.audio import pipeline
from sound_razor.webui.library import JobLog, Library, prune_job_logs


class JobQueueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        base = Path(self.temporary.name)
        with mock.patch.dict(os.environ, {"SOUND_RAZOR_MAX_CONCURRENT_JOBS": "2"}):
            self.library = Library(base / "projects", base / "ui.json", base / "cache")
        self.release = {}

    def tearDown(self):
        for event in self.release.values():
            event.set()
        deadline = time.time() + 5
        while self.library.running() and time.time() < deadline:
            time.sleep(0.01)
        self.temporary.cleanup()

    def fake_separate(self, job, *args, **kwargs):
        """Stand-in worker: reports progress on its own record, then waits to be released."""
        try:
            with self.library.lock:
                job["progress"] = 50
            self.release[job["project"]].wait(5)
            with self.library.lock:
                job.update(status="succeeded", progress=100)
        finally:
            with self.library.lock:
                self.library._finish(job)

    def enqueue(self, project):
        self.release[project] = threading.Event()
        job = {"id": project + "-job", "kind": "separate", "project": project, "status": "queued",
               "started": time.time(), "finished": None, "error": None, "progress": 0,
               "_project": Path(project), "_original": "original.wav", "_stems": ["vocals"],
               "_guitar_split": False, "_trim": None}
        with self.library.lock:
            return self.library._enqueue(job)

    def wait_for(self, predicate):
        deadline = time.time() + 5
        while time.time() < deadline:
            with self.library.lock:
                if predicate():
                    return
            time.sleep(0.01)
        self.fail("condition not reached")

    def statuses(self):
        state = self.library.state()
        jobs = {job["id"]: job for job in state["jobs"] + state["finished_jobs"]}
        return {job_id: job["status"] for job_id, job in jobs.items()}

    def test_concurrent_jobs_keep_their_own_status(self):
        with mock.patch.object(Library, "_separate", self.fake_separate):
            self.enqueue("a")
            self.enqueue("b")
            self.wait_for(lambda: len(self.library.active) == 2)
            # The first job finishes while the second is still running.
            self.release["a"].set()
            self.wait_for(lambda: "a-job" not in self.library.active)
            statuses = self.statuses()
            self.assertEqual(statuses["a-job"], "succeeded")
            self.assertEqual(statuses["b-job"], "running")
            self.release["b"].set()
            self.wait_for(lambda: not self.library.running())
            self.assertEqual(self.statuses()["b-job"], "succeeded")

    def test_state_is_json_serializable_while_jobs_queued(self):
        with mock.patch.object(Library, "_separate", self.fake_separate):
            self.assertNotIn("_project", self.enqueue("a"))
            self.enqueue("b")
            self.enqueue("c")
            self.wait_for(lambda: len(self.library.active) == 2)
            json.dumps(self.library.state())

    def test_same_project_jobs_never_overlap(self):
        with mock.patch.object(Library, "_separate", self.fake_separate):
            self.enqueue("a")
            self.wait_for(lambda: len(self.library.active) == 1)
            second = {"id": "a-second", "kind": "separate", "project": "a", "status": "queued",
                      "started": time.time(), "finished": None, "error": None, "progress": 0,
                      "_project": Path("a"), "_original": "original.wav", "_stems": ["vocals"],
                      "_guitar_split": False, "_trim": None}
            with self.library.lock:
                self.library._enqueue(second)
            self.enqueue("b")
            self.wait_for(lambda: "b-job" in self.library.active)
            self.assertNotIn("a-second", self.library.active)


class ProgressTrackingTests(unittest.TestCase):
    """A separation that also splits the guitar runs two inference passes in one
    phase; the bar must keep moving through the second (slow) pass instead of
    pinning at the 'Writing stems' floor and looking stuck."""

    def job(self, split_leaves):
        return {"kind": "separate", "split_leaves": split_leaves, "status": "running",
                "started": time.time(), "phase": "prepare", "progress": 0, "eta": None}

    def progress(self, job, lines):
        library = object.__new__(Library)
        seen = []
        for line in lines:
            library._track_progress(job, line)
            seen.append(job["progress"])
        return seen

    def test_the_guitar_pass_advances_the_bar(self):
        job = self.job(True)
        seen = self.progress(job, [
            "Separating with htdemucs_6s.yaml; model outputs: vocals",
            "100%|##| 40/40 [02:10<00:00, 3.2s/it]",
            "Splitting guitar",
            *[f"Guitar split {n}%" for n in (25, 50, 75, 100)],
        ])
        guitar = seen[-4:]
        self.assertEqual(guitar, sorted(guitar), "progress must never go backwards")
        self.assertGreater(guitar[-1] - guitar[0], 15,
                           f"the guitar pass barely moved the bar: {guitar}")
        self.assertLess(guitar[-1], 96, "the split must finish before 'Writing stems'")

    def test_without_a_split_the_whole_bar_belongs_to_the_model(self):
        job = self.job(False)
        seen = self.progress(job, [
            "Separating with htdemucs_6s.yaml; model outputs: vocals",
            "100%|##| 40/40 [02:10<00:00, 3.2s/it]",
        ])
        self.assertEqual(seen[-1], 95)

    def test_each_step_owns_its_own_percentage(self):
        # The dialog's ring restarts per step, so a 10x guitar pass starts at 0 again
        # instead of crawling through the last slice of the stem pass's bar.
        job = self.job(True)
        self.progress(job, [
            "Separating with htdemucs_6s.yaml; model outputs: vocals",
            " 60%|##| 24/40 [01:00<00:40, 2.5s/it]",
        ])
        self.assertGreater(job["step_progress"], 50)
        stem_step = job["step_progress"]
        self.progress(job, ["Splitting guitar"])
        self.assertEqual(job["step_progress"], 0, "the split must start its own gauge")
        self.progress(job, ["Guitar split 30%"])
        self.assertEqual(job["step_progress"], 30)
        self.assertGreater(job["progress"], stem_step - 1, "the overall bar keeps climbing")

    def test_saving_stems_does_not_reset_the_ring(self):
        # "Writing stems" has no sub-progress; resetting there made the ring snap from
        # 100% back to 0% for the last second of every job.
        job = self.job(True)
        self.progress(job, ["Splitting guitar", "Guitar split 100%", "Writing stems"])
        self.assertEqual(job["step_progress"], 100)

    def test_the_guitar_pass_is_its_own_phase(self):
        # The UI turns the phase into a step chip, a title and a colour, so the second
        # slower pass must not hide inside "separate".
        job = self.job(True)
        self.progress(job, [
            "Separating with htdemucs_6s.yaml; model outputs: vocals",
            "100%|##| 40/40 [02:10<00:00, 3.2s/it]",
        ])
        self.assertEqual(job["phase"], "separate")
        self.progress(job, ["Splitting guitar", "Guitar split 50%"])
        self.assertEqual(job["phase"], "guitar")

    def test_a_split_only_job_starts_its_bar_low(self):
        # No Demucs pass runs first, so the guitar model owns the whole bar instead of
        # inheriting the 70% that a two-pass job has already consumed.
        job = self.job(False)
        job["kind"] = "split-guitar"
        self.progress(job, ["Splitting guitar", "Guitar split 0%"])
        self.assertEqual(job["phase"], "guitar")
        self.assertLess(job["progress"], 20)

    def test_writing_stems_is_announced_only_after_the_split(self):
        # Ordering in the CLI: the marker that jumps the bar to 96 must come last,
        # which is what pipeline.separate() guarantees by printing it after the split.
        source = Path(pipeline.__file__).read_text(encoding="utf-8")
        writing = source.index('print("Writing stems"')
        split = source.index("_run_guitar_split(by_stem, stage, cache)")
        self.assertLess(split, writing)


class JobLogTests(unittest.TestCase):
    """A cancelled job must leave a trace: the in-memory log dies with the server
    process and drops progress lines, so debugging needed a file."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.job = {"id": "abc123", "kind": "separate", "project": "song",
                    "started": time.time(), "status": "running"}

    def tearDown(self):
        self.temporary.cleanup()

    def test_every_line_including_hidden_progress_is_written(self):
        log = JobLog(self.base, self.job, ["python", "-m", "sound_razor", "separate"])
        log.write("Separating with htdemucs_6s.yaml")
        log.write("Guitar split 50%")   # hidden from the UI log, kept here
        log.close("cancelled")
        text = log.path.read_text(encoding="utf-8")
        self.assertIn("-m sound_razor separate", text)
        self.assertIn("Guitar split 50%", text)
        self.assertIn("# status   cancelled", text)

    def test_the_path_is_exposed_on_the_job(self):
        log = JobLog(self.base, self.job, ["x"])
        log.close("succeeded")
        self.assertEqual(self.job["log"], str(log.path))

    def test_an_unwritable_directory_never_breaks_the_run(self):
        blocked = self.base / "file"
        blocked.write_text("not a directory", encoding="utf-8")
        log = JobLog(blocked / "logs", self.job, ["x"])
        log.write("line")     # must be a silent no-op
        log.close("failed", "boom")
        self.assertIsNone(log.handle)
        self.assertNotIn("log", self.job)

    def test_old_logs_are_pruned(self):
        for index in range(5):
            (self.base / f"{index}.log").write_text("x", encoding="utf-8")
        prune_job_logs(self.base, keep=2)
        self.assertEqual(len(list(self.base.glob("*.log"))), 2)


if __name__ == "__main__":
    unittest.main()
