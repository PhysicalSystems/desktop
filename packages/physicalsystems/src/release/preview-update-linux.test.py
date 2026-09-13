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


if __name__ == "__main__":
    unittest.main()
