# SPDX-License-Identifier: Apache-2.0
"""Unit boundaries only: never launches an installer, agent, app, or privilege prompt."""
import importlib.util
import pathlib
import os
import termios
import threading
import time
import sys
import unittest
import json
import tempfile
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("preview_update_linux", pathlib.Path(__file__).with_name("preview-update-linux.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

START = "==== AUTHENTICATING FOR org.freedesktop.policykit.exec ====\nAuthentication is needed to run /usr/bin/dpkg\n"


class AuthenticationTests(unittest.TestCase):
    def test_selects_only_disposable_identity_then_one_password_and_real_completion(self):
        prompt = native.AuthenticationPrompt("ps-update-auth")
        self.assertIsNone(prompt.feed(START[:20]))
        self.assertEqual(prompt.feed(START[20:] + "Multiple identities can be used for authentication:\n"
                                    " 1.  runner\n 2.  ps-update-auth\nChoose identity to authenticate as (1-2): "), ("identity", "2"))
        self.assertEqual(prompt.feed("2\nPassword: "), ("password", None))
        self.assertIsNone(prompt.feed("\n"))
        self.assertEqual(prompt.feed("==== AUTHENTICATION COMPLETE ====\n"), ("authenticated", None))
        self.assertIsNone(prompt.feed(""))

    def test_single_identity_and_partial_password_prompt(self):
        prompt = native.AuthenticationPrompt("ps-update-auth")
        self.assertIsNone(prompt.feed(START + "Authenticating as: CI Up"))
        self.assertIsNone(prompt.feed("date (ps-update-auth)\nPass"))
        self.assertEqual(prompt.feed("word: "), ("password", None))

    def test_password_waits_for_private_terminal_and_refuses_visible_echo(self):
        master, slave = os.openpty()
        try:
            with self.assertRaisesRegex(native.QualificationError, "ECHO_ENABLED"):
                native.wait_private_terminal(master, timeout=0.01)
            def disable_echo():
                time.sleep(0.02)
                attributes = termios.tcgetattr(slave)
                attributes[3] &= ~(termios.ECHO | termios.ECHONL)
                termios.tcsetattr(slave, termios.TCSANOW, attributes)
            worker = threading.Thread(target=disable_echo)
            worker.start()
            try:
                native.wait_private_terminal(master)
            finally:
                worker.join()
        finally:
            os.close(master)
            os.close(slave)

    def test_rejects_unrelated_or_ambiguous_identity_before_password(self):
        for text in (
            START + "Authenticating as: runner\nPassword: ",
            START + " 1.  runner\nChoose identity to authenticate as (1-1): ",
            START + " 1.  ps-update-auth\n 2.  CI (ps-update-auth)\nChoose identity to authenticate as (1-2): ",
            START + "Password: ",
        ):
            with self.subTest(text=text), self.assertRaises(native.QualificationError):
                native.AuthenticationPrompt("ps-update-auth").feed(text)

    def test_rejects_unrelated_action_repeated_authentication_and_passwordless_success(self):
        for text in (
            START.replace("org.freedesktop.policykit.exec", "org.example.other"),
            START + START,
            START + "==== AUTHENTICATION COMPLETE ====\n",
        ):
            with self.subTest(text=text), self.assertRaises(native.QualificationError):
                native.AuthenticationPrompt("ps-update-auth").feed(text)

    def test_does_not_retry_failed_cancelled_or_repeated_password_prompts(self):
        for ending in ("==== AUTHENTICATION FAILED ====", "==== AUTHENTICATION CANCELED ====", "Password: "):
            prompt = native.AuthenticationPrompt("ps-update-auth")
            self.assertEqual(prompt.feed(START + "Authenticating as: ps-update-auth\nPassword: "), ("password", None))
            with self.subTest(ending=ending), self.assertRaises(native.QualificationError):
                prompt.feed("\n" + ending)

    def test_terminal_output_is_bounded(self):
        with self.assertRaisesRegex(native.QualificationError, "OUTPUT_LIMIT"):
            native.AuthenticationPrompt("ps-update-auth").feed("x" * 32769)


class Accessible:
    def __init__(self, name, role, pid=42, children=()):
        self.name, self.role, self.pid, self.children = name, role, pid, list(children)

    def get_name(self): return self.name
    def get_role(self): return self.role
    def get_process_id(self): return self.pid
    def get_child_count(self): return len(self.children)
    def get_child_at_index(self, index): return self.children[index]


class DialogTests(unittest.TestCase):
    roles = {"dialog": ("dialog", "alert", "frame"), "button": "button"}

    def fixture(self, pid=42, version="0.1.0-beta.7"):
        later, install = Accessible("Later", "button", pid), Accessible("Install update", "button", pid)
        dialog = Accessible("Update Ready", "dialog", pid, (
            Accessible("Install Physical Systems " + version + "?", "label", pid), later, install))
        return Accessible("Physical Systems", "application", pid, (dialog,)), dialog, later, install

    def find(self, apps, choice="install"):
        return native.find_dialog_button(apps, 42, "0.1.0-beta.7", choice, self.roles)

    def test_finds_actual_requested_button_only_in_owned_exact_version_dialog(self):
        app, _, later, install = self.fixture()
        unrelated, *_ = self.fixture(pid=43)
        self.assertIs(self.find([unrelated, app]), install)
        self.assertIs(self.find([unrelated, app], "later"), later)

    def test_refuses_wrong_process_version_title_missing_button_or_renderer_imitation(self):
        app, *_ = self.fixture(pid=43)
        self.assertIsNone(self.find([app]))
        app, *_ = self.fixture(version="0.1.0-beta.8")
        self.assertIsNone(self.find([app]))
        for mutation in ("title", "buttons", "renderer"):
            app, dialog, *_ = self.fixture()
            if mutation == "title": dialog.name = "Some other dialog"
            if mutation == "buttons": dialog.children.pop()
            if mutation == "renderer": dialog.role = "document"
            with self.subTest(mutation=mutation): self.assertIsNone(self.find([app]))

    def test_refuses_ambiguous_dialogs_and_unbounded_tree(self):
        first, *_ = self.fixture()
        second, *_ = self.fixture()
        with self.assertRaisesRegex(native.QualificationError, "AMBIGUOUS"):
            self.find([first, second])
        app, dialog, *_ = self.fixture()
        dialog.children.extend(Accessible("x", "label") for _ in range(129))
        with self.assertRaisesRegex(native.QualificationError, "TREE_LIMIT"):
            self.find([app])

    def test_diagnostic_contains_only_owned_window_categories_and_counts(self):
        app, dialog, *_ = self.fixture()
        unrelated, *_ = self.fixture(pid=98765)
        unrelated.name = "private unrelated application"
        dialog.name = "private unexpected dialog text"
        observation = {}
        roles = {**self.roles, "names": {"dialog": "dialog"}}
        self.assertIsNone(native.find_dialog_button([unrelated, app], 42, "0.1.0-beta.7", "install", roles, observation))
        self.assertEqual(observation, {"applications": 2, "ownedApplications": 1, "windows": [
            {"role": "dialog", "name": "other", "message": False, "install": 0, "later": 0}]})
        self.assertNotIn("private", json.dumps(observation))
        self.assertNotIn("98765", json.dumps(observation))
        dialog.name = "Update Ready"
        self.assertIsNotNone(native.find_dialog_button([app], 42, "0.1.0-beta.7", "install", roles, observation))
        self.assertEqual(observation["windows"], [{"role": "dialog", "name": "update-title", "message": True, "install": 1, "later": 1}])

    def test_optional_hosted_accessibility_api_is_available(self):
        try:
            import gi
            gi.require_version("Atspi", "2.0")
            from gi.repository import Atspi
        except (ImportError, ValueError):
            self.skipTest("Hosted-only Atspi dependencies are not installed")
        self.assertTrue(callable(Atspi.Accessible.get_process_id))
        self.assertTrue(callable(Atspi.Accessible.get_action_iface))
        self.assertTrue(callable(Atspi.Action.do_action))
        self.assertTrue(callable(Atspi.set_timeout))


class X11DialogTests(unittest.TestCase):
    version = "0.1.0-beta.7"

    def tsv(self, version=None):
        tokens = ("Install Physical Systems " + (version or self.version) + "? " + native.LINUX_CONFIRMATION_DETAIL).split()
        lines = ["level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext"]
        left, top, line, index = 10, 10, 1, 0
        for text in tokens:
            width = len(text) * 7
            if left + width > 880:
                left, top, line = 10, top + 20, line + 1
            index += 1
            lines.append(f"5\t1\t1\t1\t{line}\t{index}\t{left}\t{top}\t{width}\t12\t99\t{text}")
            left += width + 8
        for i, (text, left, width) in enumerate((("Install", 100, 42), ("update", 150, 42), ("Later", 600, 35))):
            lines.append(f"5\t1\t1\t1\t20\t{i+1}\t{left}\t250\t{width}\t12\t99\t{text}")
        return "\n".join(lines) + "\n"

    def window(self, **changes):
        return {"id": 123, "pid": 42, "title": "Update Ready", "dialog": True, "viewable": True,
                "width": 900, "height": 300, "depth": 24, "visual": 33, "x": 20, "y": 30, **changes}

    def icon_tsv(self, symbol="@", left=47, top=5, width=15, height=15, confidence=31, duplicate=False):
        rows = self.tsv().splitlines()
        result = [rows[0]]
        icon = f"5\t1\t1\t1\t1\t1\t{left}\t{top}\t{width}\t{height}\t{confidence}\t{symbol}"
        result.extend([icon] * (2 if duplicate else 1))
        for row in rows[1:]:
            fields = row.split("\t")
            fields[6] = str(int(fields[6]) + 100)
            result.append("\t".join(fields))
        return "\n".join(result) + "\n"

    def test_exact_public_copy_determines_each_button_text_center(self):
        self.assertEqual(native.dialog_ocr_point(self.tsv(), 900, 300, self.version, "install"), (171, 256))
        self.assertEqual(native.dialog_ocr_point(self.tsv(), 900, 300, self.version, "later"), (617, 256))

    def test_one_observed_nontext_icon_preserves_exact_copy_confidence_and_button_points(self):
        self.assertEqual(native.dialog_ocr_point(self.icon_tsv(), 1000, 300, self.version, "install"), (271, 256))
        self.assertEqual(native.dialog_ocr_point(self.icon_tsv(), 1000, 300, self.version, "later"), (717, 256))
        for value in (self.icon_tsv().replace("\tUbuntu\n", "\tAltered\n"),
                      self.icon_tsv().replace("\t99\tLater", "\t74\tLater"),
                      self.icon_tsv().replace("0.1.0-beta.7?", "0.1.0-beta.8?")):
            with self.assertRaises(native.NativeDialogRecognitionError):
                native.dialog_ocr_point(value, 1000, 300, self.version, "install")

    def test_icon_rule_refuses_words_multiple_symbols_and_glyphs_outside_isolated_heading_icon_area(self):
        for changes in ({"symbol": "A"}, {"symbol": "7"}, {"symbol": "please"}, {"symbol": "@@"},
                        {"duplicate": True}, {"left": 150}, {"left": 100}, {"top": 80},
                        {"width": 40}, {"width": 2, "height": 2}, {"confidence": 99}, {"left": -1}):
            with self.subTest(changes=changes), self.assertRaises(native.NativeDialogRecognitionError):
                native.dialog_ocr_point(self.icon_tsv(**changes), 1000, 300, self.version, "install")

    def test_ocr_refuses_wrong_version_unknown_text_duplicate_buttons_low_confidence_and_bad_geometry(self):
        original = self.tsv()
        cases = [self.tsv("0.1.0-beta.8"), original.replace("\tUbuntu\n", "\tPrivate\n"),
                 original + original.splitlines()[-1] + "\n", original.replace("\t99\tLater", "\t74\tLater"),
                 original.replace("\t600\t250\t35\t", "\t890\t250\t35\t"),
                 original.replace("\t600\t250\t35\t", "\t20\t250\t35\t")]
        for tsv in cases:
            with self.subTest(tsv=tsv[-100:]), self.assertRaisesRegex(native.QualificationError, "OCR_MISMATCH"):
                native.dialog_ocr_point(tsv, 900, 300, self.version, "install")
        with self.assertRaisesRegex(native.QualificationError, "OCR_INVALID"):
            native.dialog_ocr_point(original, 2000, 300, self.version, "install")

    def test_recognition_diagnostics_report_failure_without_raw_text(self):
        for replacement, reason, index, difference in (
            (self.tsv().replace("\t99\tLater", "\t74.9\tLater"), "confidence", None, None),
            (self.tsv().replace("\tUbuntu\n", "\tPRIVATE_OCR_TEXT\n"), "text", 4, "word"),
            (self.tsv().replace("\tLater\n", "\tLater!\n"), "text", 41, "punctuation"),
            ("\n".join(self.tsv().splitlines()[:-1]), "word-count", 41, "missing"),
        ):
            with self.subTest(reason=reason), self.assertRaises(native.NativeDialogRecognitionError) as caught:
                native.dialog_ocr_point(replacement, 900, 300, self.version, "install")
            diagnostic = caught.exception.diagnostic
            self.assertEqual(diagnostic["reason"], reason)
            self.assertTrue(diagnostic["rangesValid"])
            self.assertEqual((diagnostic["width"], diagnostic["height"]), (900, 300))
            self.assertNotIn("PRIVATE_OCR_TEXT", json.dumps(diagnostic))
            self.assertNotIn("Ubuntu", json.dumps(diagnostic))
            self.assertLessEqual(len(diagnostic["mismatches"]), 12)
            if index is not None:
                self.assertEqual(diagnostic["mismatches"][0]["index"], index)
                self.assertEqual(diagnostic["mismatches"][0]["difference"], difference)
            else:
                self.assertEqual(diagnostic["minimumConfidence"], 74)

    def test_window_selection_requires_owned_exact_title_dialog_type_and_one_visible_match(self):
        for change in ({"pid": 43}, {"title": "Other"}, {"dialog": False}, {"viewable": False}):
            self.assertIsNone(native.find_x11_dialog([self.window(**change)], 42))
        expected = self.window()
        self.assertEqual(native.find_x11_dialog([self.window(pid=43), expected], 42), expected)
        with self.assertRaisesRegex(native.QualificationError, "AMBIGUOUS"):
            native.find_x11_dialog([expected, self.window(id=124)], 42)

    def backend(self, **changes):
        case = self
        class Backend:
            def __init__(self):
                self.events, self.reads = [], 0
                self.fail = changes.get("fail")
            def windows(self, pid): return changes.get("windows", [case.window()])
            def current(self, window):
                self.reads += 1
                if self.events and self.events[-1][0] == "release": return None
                if self.reads == changes.get("change_on_read"): return case.window(pid=43)
                return case.window()
            def capture(self, window): return b"owned exact dialog PNG boundary"
            def ocr(self, png): return changes.get("tsv", case.tsv())
            def send(self, window, kind, point):
                if kind == self.fail: raise native.QualificationError("NATIVE_DIALOG_ACTION_FAILED")
                self.events.append((kind, point))
        return Backend()

    def invoke(self, backend, root, choice="install", identity=lambda pid: "123"):
        with patch.object(native.time, "sleep", lambda _: None):
            return native.click_x11_confirmation(backend, {"root": root, "applicationPid": 42,
                "version": self.version, "choice": choice}, "123", identity)

    def test_only_scoped_enter_motion_press_release_and_pre_auth_owned_screenshot(self):
        for choice, point in (("install", (171, 256)), ("later", (617, 256))):
            with tempfile.TemporaryDirectory() as root:
                backend = self.backend()
                self.assertTrue(self.invoke(backend, root, choice))
                self.assertEqual(backend.events, [(kind, point) for kind in ("enter", "motion", "press", "release")])
                screenshot = pathlib.Path(root) / ("native-dialog-" + choice + ".png")
                self.assertEqual(screenshot.stat().st_mode & 0o777, 0o600)
                self.assertEqual(screenshot.read_bytes(), b"owned exact dialog PNG boundary")

    def test_unknown_or_ambiguous_dialog_never_saves_screenshot_or_sends_input(self):
        for changes in ({"tsv": self.tsv("0.1.0-beta.8")}, {"windows": [self.window(), self.window(id=124)]}):
            with tempfile.TemporaryDirectory() as root:
                backend = self.backend(**changes)
                with self.assertRaises(native.QualificationError): self.invoke(backend, root)
                self.assertEqual(backend.events, [])
                self.assertEqual(list(pathlib.Path(root).iterdir()), [])

    def test_identity_or_window_change_and_input_failure_stop_before_next_event(self):
        for change, expected in (({"change_on_read": 4}, ["enter"]), ({"fail": "press"}, ["enter", "motion"])):
            with tempfile.TemporaryDirectory() as root:
                backend = self.backend(**change)
                with self.assertRaises(native.QualificationError): self.invoke(backend, root)
                self.assertEqual([event[0] for event in backend.events], expected)
        with tempfile.TemporaryDirectory() as root:
            backend = self.backend()
            with self.assertRaisesRegex(native.QualificationError, "IDENTITY_CHANGED"):
                self.invoke(backend, root, identity=lambda _: "new process start time")
            self.assertEqual(backend.events, [])
            self.assertEqual(list(pathlib.Path(root).iterdir()), [])

    def test_terminal_diagnostic_capture_saves_exact_owned_window_without_input_even_when_ocr_differs(self):
        with tempfile.TemporaryDirectory() as root:
            backend = self.backend(tsv=self.tsv("0.1.0-beta.8"))
            with self.assertRaises(native.NativeDialogRecognitionError): self.invoke(backend, root)
            native.capture_x11_diagnostic(backend, {"root": root, "applicationPid": 42}, "123", lambda _: "123")
            screenshot = pathlib.Path(root) / "native-dialog-diagnostic.png"
            self.assertEqual(screenshot.stat().st_mode & 0o777, 0o600)
            self.assertEqual(screenshot.read_bytes(), b"owned exact dialog PNG boundary")
            self.assertEqual(backend.events, [])
            with self.assertRaises(FileExistsError):
                native.capture_x11_diagnostic(backend, {"root": root, "applicationPid": 42}, "123", lambda _: "123")

    def test_diagnostic_capture_refuses_auth_unowned_ambiguous_changed_or_replaced_windows(self):
        for change in ({"windows": [self.window(title="Authentication")]}, {"windows": [self.window(pid=43)]},
                       {"windows": [self.window(dialog=False)]}, {"windows": [self.window(viewable=False)]},
                       {"windows": [self.window(), self.window(id=124)]}, {"change_on_read": 2}):
            with tempfile.TemporaryDirectory() as root:
                backend = self.backend(**change)
                with self.assertRaises(native.QualificationError):
                    native.capture_x11_diagnostic(backend, {"root": root, "applicationPid": 42}, "123", lambda _: "123")
                self.assertEqual(backend.events, [])
                self.assertEqual(list(pathlib.Path(root).iterdir()), [])
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(native.QualificationError, "IDENTITY_CHANGED"):
                native.capture_x11_diagnostic(self.backend(), {"root": root, "applicationPid": 42}, "123", lambda _: "456")
            target = pathlib.Path(root) / "sentinel"
            target.write_bytes(b"unchanged")
            (pathlib.Path(root) / "native-dialog-diagnostic.png").symlink_to(target)
            with self.assertRaises(FileExistsError):
                native.capture_x11_diagnostic(self.backend(), {"root": root, "applicationPid": 42}, "123", lambda _: "123")
            self.assertEqual(target.read_bytes(), b"unchanged")


if __name__ == "__main__":
    unittest.main()
