import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from pathlib import Path
from unittest.mock import patch

from sound_razor import setup_env


class SetupHealthTests(unittest.TestCase):
    def test_binary_ok_rejects_missing_empty_and_zeroed_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "library.dll"
            self.assertFalse(setup_env._binary_ok(path, 16))
            path.write_bytes(b"MZ")
            self.assertFalse(setup_env._binary_ok(path, 16))
            path.write_bytes(b"\0" * 64)
            self.assertFalse(setup_env._binary_ok(path, 16))
            path.write_bytes(b"MZ" + b"\0" * 62)
            self.assertTrue(setup_env._binary_ok(path, 16))

    @unittest.skipUnless(sys.platform == "win32", "Windows torch layout")
    def test_torch_ok_detects_zeroed_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "torch"
            (root / "lib").mkdir(parents=True)
            (root / "__init__.py").write_text("", encoding="utf-8")
            files = {
                root / "lib" / "torch_cpu.dll": 10 * 1024 * 1024,
                root / "lib" / "torch_python.dll": 1024 * 1024,
                root / "_C.cp311-win_amd64.pyd": 1024,
            }
            for path, size in files.items():
                with path.open("wb") as stream:
                    stream.write(b"MZ")
                    stream.truncate(size)
            with patch.object(setup_env, "_package_dir", return_value=root):
                self.assertTrue(setup_env.torch_ok())
                (root / "lib" / "torch_python.dll").write_bytes(b"\0" * (1024 * 1024))
                self.assertFalse(setup_env.torch_ok())

    def test_pip_repair_falls_back_when_record_is_unreadable(self):
        class FakeProcess:
            def __init__(self, lines, code):
                self.stdout = iter(lines)
                self.code = code

            def poll(self):
                return self.code

            def wait(self):
                return self.code

            def kill(self):
                pass

            def terminate(self):
                pass

        library = SimpleNamespace(lock=threading.Lock(), logs=[], process=None,
                                  job={"status": "running"})
        processes = [
            FakeProcess(["Collecting torch", "ERROR: field larger than field limit (131072)"], 1),
            FakeProcess(["Successfully installed torch-2.14.1"], 0),
        ]
        commands = []

        def fake_popen(command, **kwargs):
            commands.append(command)
            return processes.pop(0)

        with patch.object(setup_env.subprocess, "Popen", side_effect=fake_popen):
            progress = setup_env._pip_install(library, ["torch"], "separation", 0, 50, force=True)

        self.assertEqual(progress, 50)
        self.assertIn("--force-reinstall", commands[0])
        self.assertIn("--ignore-installed", commands[1])
        self.assertTrue(any("Damaged package metadata" in line for line in library.logs))



if __name__ == "__main__":
    unittest.main()
