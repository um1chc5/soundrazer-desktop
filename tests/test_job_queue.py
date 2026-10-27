import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from sound_razor.webui.library import Library


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


if __name__ == "__main__":
    unittest.main()
