"""The separation plan: which stems own a file, which are folded, which are dropped."""

import tempfile
import unittest
from pathlib import Path

from sound_razor.audio.pipeline import (_build_other, legacy_group, model_request,
                                        publish_names, resolve_plan)
from sound_razor.webui.library import Library, plan_stems, validate_group


class ModelRequestTests(unittest.TestCase):
    def test_quick_selection_keeps_its_shape(self):
        self.assertEqual(model_request(["vocals"], None, False), ["vocals"])

    def test_group_members_are_computed_too(self):
        self.assertEqual(model_request([], ["other", "piano"], False), ["other", "piano"])

    def test_split_forces_the_guitar_in(self):
        self.assertEqual(model_request(["lead", "rhythm"], None, True), ["guitar"])

    def test_leaves_without_a_split_are_rejected(self):
        with self.assertRaises(ValueError):
            model_request(["lead"], None, False)

    def test_a_plan_that_writes_nothing_is_rejected(self):
        with self.assertRaises(ValueError):
            model_request([], [], False)

    def test_no_plan_asks_for_every_model_output(self):
        self.assertIsNone(model_request(None, None, False))


class ResolvePlanTests(unittest.TestCase):
    """`other` is the destination, so a plan that folds always folds it in."""

    def test_an_explicit_group_gains_other(self):
        model, own, grouped = resolve_plan(None, (), ("piano",), False)
        self.assertEqual(set(grouped), {"piano", "other"})
        self.assertEqual(own, ())
        self.assertTrue(model)

    def test_group_without_stems_keeps_the_rest_own(self):
        model, own, grouped = resolve_plan(None, None, ("piano",), False)
        self.assertEqual(set(grouped), {"piano", "other"})
        self.assertTrue(own)
        self.assertFalse(set(own) & {"piano", "other"})

    def test_no_plan_leaves_the_quick_path_untouched(self):
        model, own, grouped = resolve_plan(None, None, None, False)
        self.assertIsNone(own)
        self.assertIsNone(grouped)
        self.assertTrue(model)


class LegacyGroupTests(unittest.TestCase):
    def test_legacy_other_folds_the_unselected_in(self):
        self.assertEqual(set(legacy_group("htdemucs.yaml", ("vocals", "other"), None)),
                         {"other", "drums", "bass"})

    def test_an_explicit_group_is_left_alone(self):
        self.assertEqual(legacy_group("htdemucs_6s.yaml", ("vocals",), ("piano",)), ("piano",))

    def test_no_other_means_no_folding(self):
        self.assertIsNone(legacy_group("htdemucs.yaml", ("vocals", "drums"), None))


class PublishTests(unittest.TestCase):
    def test_a_group_member_is_never_published(self):
        self.assertEqual(publish_names("htdemucs_6s.yaml", ("vocals",), ("other", "piano")),
                         ("vocals", "other"))

    def test_a_plan_with_no_own_files_still_writes_other(self):
        self.assertEqual(publish_names("htdemucs_6s.yaml", (), ("other",)), ("other",))

    def test_other_is_not_listed_twice(self):
        self.assertEqual(publish_names("htdemucs_6s.yaml", ("other",), ("other",)), ("other",))


class BuildOtherTests(unittest.TestCase):
    def test_a_lone_other_needs_no_mix(self):
        with tempfile.TemporaryDirectory() as temporary:
            other = Path(temporary) / "other.flac"
            other.write_bytes(b"stub")
            self.assertEqual(_build_other({"other": other}, ["other"]), other)

    def test_a_member_the_run_did_not_produce_is_an_error(self):
        with self.assertRaises(RuntimeError):
            _build_other({"other": Path("other.flac")}, ["piano", "other"])

    def test_no_group_means_no_other_file(self):
        self.assertIsNone(_build_other({}, []))


class ValidateGroupTests(unittest.TestCase):
    def test_none_keeps_the_legacy_behaviour(self):
        self.assertIsNone(validate_group(None))

    def test_unknown_stems_are_rejected(self):
        with self.assertRaises(ValueError):
            validate_group(["kazoo"])

    def test_duplicates_collapse(self):
        self.assertEqual(validate_group(["other", "other"]), ["other"])


class PlanStemsTests(unittest.TestCase):
    """An explicit plan may deliberately keep no own files."""

    def test_a_fully_folded_plan_is_accepted(self):
        self.assertEqual(plan_stems("custom", [], ["other", "vocals"]), [])

    def test_a_plan_that_keeps_and_folds_nothing_is_rejected(self):
        with self.assertRaises(ValueError):
            plan_stems("custom", [], [])

    def test_the_quick_grid_still_needs_a_stem(self):
        with self.assertRaises(ValueError):
            plan_stems("custom", [])

    def test_unknown_stems_are_rejected(self):
        with self.assertRaises(ValueError):
            plan_stems("custom", ["kazoo"], ["other"])


class CommandTests(unittest.TestCase):
    """The CLI must be told about an explicitly empty own-file list."""

    def command(self, stems, group, split_leaves=True):
        library = object.__new__(Library)
        library.cache = Path("/cache")
        return Library._separation_command(
            library, {"kind": "separate"}, Path("/project"), "original.wav",
            Path("/stage"), stems, group, split_leaves, None)

    def test_an_all_grouped_plan_still_sends_stems(self):
        command = self.command([], ["other", "piano"])
        self.assertIn("--stems", command)
        self.assertEqual(command[command.index("--stems") + 1], "--group")

    def test_the_group_is_separate_from_the_own_files(self):
        command = self.command(["vocals"], ["other"])
        self.assertEqual(command[command.index("--stems") + 1], "vocals")
        self.assertEqual(command[command.index("--group") + 1], "other")

    def test_the_split_is_requested_only_when_planned(self):
        self.assertIn("--split-guitar", self.command(["vocals"], ["other"]))
        self.assertNotIn("--split-guitar", self.command(["vocals"], ["other"], False))


if __name__ == "__main__":
    unittest.main()
