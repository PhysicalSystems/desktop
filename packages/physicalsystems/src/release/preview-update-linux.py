# SPDX-License-Identifier: Apache-2.0
"""Native update UI/authentication for disposable hosted Linux qualification only.

The password arrives through a private stdin pipe. No terminal transcript, password,
accessibility tree, or arbitrary exception text is ever emitted by this helper.
"""

import ctypes
import json
import os
import pathlib
import pty
import re
import select
import signal
import stat
import sys
import termios
import time


class QualificationError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise QualificationError(code)


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def process_identity(pid):
    require(isinstance(pid, int) and not isinstance(pid, bool) and pid > 1, "INVALID_APPLICATION_PID")
    base = pathlib.Path("/proc") / str(pid)
    fields = (base / "stat").read_text().rsplit(") ", 1)[1].split()
    uid = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$", (base / "status").read_text(), re.M)
    require(uid is not None and all(int(x) == os.getuid() for x in uid.groups()), "APPLICATION_OWNER_MISMATCH")
    require((base / "exe").resolve() == pathlib.Path("/opt/Physical Systems/physical-systems-desktop"), "APPLICATION_EXECUTABLE_MISMATCH")
    require(len(fields) > 19 and fields[19].isdigit(), "APPLICATION_IDENTITY_UNAVAILABLE")
    return fields[19]


def require_runner(config):
    env = os.environ
    require(sys.platform == "linux" and os.getuid() != 0, "DISPOSABLE_NONROOT_RUNNER_REQUIRED")
    require(env.get("CI") == "true" and env.get("GITHUB_ACTIONS") == "true"
            and env.get("RUNNER_ENVIRONMENT") == "github-hosted" and env.get("RUNNER_OS") == "Linux"
            and env.get("PHYSICALSYSTEMS_UPDATER_TEST") == "1" and env.get("GITHUB_REPOSITORY") == "PhysicalSystems/desktop"
            and env.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and env.get("RUNNER_ARCH") == "X64"
            and re.fullmatch(r"[1-9]\d*", env.get("GITHUB_RUN_ID", "")), "DISPOSABLE_RUNNER_REQUIRED")
    root = pathlib.Path(config["root"])
    temporary = pathlib.Path(env.get("RUNNER_TEMP", ""))
    require(root.is_absolute() and temporary.is_absolute() and temporary != pathlib.Path("/")
            and not root.is_symlink() and root.is_dir() and root.resolve() != temporary.resolve()
            and root.resolve().is_relative_to(temporary.resolve()), "RUNNER_PATH_INVALID")
    marker = root / "preview-update-runner.json"
    info = marker.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
            and info.st_mode & 0o077 == 0 and info.st_size < 1024, "RUNNER_MARKER_INVALID")
    require(json.loads(marker.read_text()) == {"kind": "disposable-preview-update", "runId": env["GITHUB_RUN_ID"]}, "RUNNER_MARKER_INVALID")
    return process_identity(config["applicationPid"])


class AuthenticationPrompt:
    """Parse the real polkit text agent, accepting exactly one owned transaction."""

    def __init__(self, user):
        self.user = user
        self.text = ""
        self.started = False
        self.selected = False
        self.password_sent = False
        self.complete = False

    def feed(self, text):
        self.text += text
        require(len(self.text) <= 32768, "AUTHENTICATION_OUTPUT_LIMIT")
        require("AUTHENTICATION FAILED" not in self.text and "AUTHENTICATION CANCELED" not in self.text,
                "AUTHENTICATION_REJECTED")
        actions = re.findall(r"==== AUTHENTICATING FOR ([^\r\n]+?) ====", self.text)
        require(len(actions) <= 1 and all(x == "org.freedesktop.policykit.exec" for x in actions),
                "AUTHENTICATION_ACTION_MISMATCH")
        self.started = bool(actions)
        if not self.started:
            return None
        if not self.selected and "Choose identity to authenticate as" in self.text:
            identities = re.findall(r"^\s*(\d+)\.\s+([^\r\n]+)", self.text, re.M)
            matches = [number for number, name in identities if self.matches_user(name.strip())]
            require(len(matches) == 1, "AUTHENTICATION_IDENTITY_MISMATCH")
            self.selected = True
            return ("identity", matches[0])
        if not self.selected:
            identities = re.findall(r"Authenticating as: ([^\r\n]+)\r?\n", self.text)
            if identities:
                require(len(identities) == 1 and self.matches_user(identities[0].strip()), "AUTHENTICATION_IDENTITY_MISMATCH")
                self.selected = True
        prompts = re.findall(r"(?:^|[\r\n])Password:[ \t]*", self.text)
        require(len(prompts) <= 1, "AUTHENTICATION_RETRY_REFUSED")
        if prompts and not self.password_sent:
            require(self.selected, "AUTHENTICATION_IDENTITY_MISSING")
            self.password_sent = True
            return ("password", None)
        if "==== AUTHENTICATION COMPLETE ====" in self.text and not self.complete:
            require(self.password_sent, "AUTHENTICATION_PASSWORD_NOT_OBSERVED")
            self.complete = True
            return ("authenticated", None)
        return None

    def matches_user(self, value):
        return value == self.user or value.endswith(" (" + self.user + ")")


def stop_child(pid):
    # This is our unreaped child, never the app or its privileged package manager.
    if os.waitpid(pid, os.WNOHANG)[0]:
        return
    os.kill(pid, signal.SIGTERM)
    until = time.monotonic() + 2
    while time.monotonic() < until:
        if os.waitpid(pid, os.WNOHANG)[0]:
            return
        time.sleep(0.02)
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)


def wait_private_terminal(terminal, timeout=2):
    # polkit flushes "Password:" immediately before disabling ECHO. Observe the
    # termios change rather than racing that flush or sending a visible password.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not termios.tcgetattr(terminal)[3] & (termios.ECHO | termios.ECHONL):
            return
        time.sleep(0.005)
    raise QualificationError("AUTHENTICATION_ECHO_ENABLED")


def require_package_command(pid, version):
    # pkexec's subject is its direct parent. Before answering PAM, also pin the
    # actual child command; a generic pkexec action alone is not sufficient.
    matches = []
    children = pathlib.Path("/proc") / str(pid) / "task" / str(pid) / "children"
    for child in children.read_text().split():
        try:
            args = (pathlib.Path("/proc") / child / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")
        except FileNotFoundError:
            continue
        if args[:1] != [b"/usr/bin/pkexec"]:
            continue
        require(len(args) == 5 and args[1:4] == [b"/usr/bin/dpkg", b"--refuse-downgrade", b"--install"],
                "AUTHENTICATION_COMMAND_MISMATCH")
        installer = pathlib.Path(os.fsdecode(args[4]))
        require(installer.is_absolute() and installer.name == "physical-systems-desktop-" + version + "-linux-x64.deb"
                and installer.resolve() == installer, "AUTHENTICATION_COMMAND_MISMATCH")
        info = installer.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
                and info.st_mode & 0o077 == 0, "AUTHENTICATION_COMMAND_MISMATCH")
        matches.append(child)
    require(len(matches) == 1, "AUTHENTICATION_COMMAND_MISMATCH")


def authenticate(config, start_time):
    require(config.get("authUser") == "ps-update-auth", "AUTHENTICATION_IDENTITY_INVALID")
    password = config.pop("authPassword", "")
    require(isinstance(password, str) and re.fullmatch(r"[A-Za-z0-9_-]{32,128}", password), "AUTHENTICATION_SECRET_INVALID")
    require(isinstance(config.get("version"), str) and re.fullmatch(r"\d+\.\d+\.\d+-beta\.\d+", config["version"]),
            "AUTHENTICATION_COMMAND_MISMATCH")
    registered, notify = os.pipe()
    owner = os.getpid()
    child, terminal = pty.fork()
    if child == 0:
        try:
            # A killed proxy must not leave a credential-bearing authentication agent.
            require(ctypes.CDLL(None).prctl(1, signal.SIGTERM, 0, 0, 0) == 0 and os.getppid() == owner, "AGENT_PARENT_LOST")
            os.close(registered)
            os.dup2(notify, 3, inheritable=True)
            if notify != 3:
                os.close(notify)
            os.execve("/usr/bin/pkttyagent", ["pkttyagent", "--process", str(config["applicationPid"]) + "," + start_time,
                                          "--notify-fd", "3"],
                      {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "LANG": "C", "TERM": "dumb"})
        except BaseException:
            os._exit(127)
    os.close(notify)
    prompt = AuthenticationPrompt(config["authUser"])
    ready = False
    deadline = time.monotonic() + 180
    try:
        while time.monotonic() < deadline:
            streams = [terminal, 0] + ([] if ready else [registered])
            readable, _, _ = select.select(streams, [], [], 0.1)
            if 0 in readable:
                control = os.read(0, 4096)
                require(not control or control.strip() == b'{"command":"stop"}', "AGENT_CONTROL_INVALID")
                return
            if not ready and registered in readable:
                require(os.read(registered, 1) == b"", "AGENT_REGISTRATION_INVALID")
                # Closing notify-fd is the documented registration acknowledgement.
                # waitid WNOWAIT preserves our child's identity for cleanup.
                require(os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None, "AGENT_REGISTRATION_FAILED")
                require(process_identity(config["applicationPid"]) == start_time, "APPLICATION_IDENTITY_CHANGED")
                ready = True
                emit("ready")
            if terminal in readable:
                try:
                    data = os.read(terminal, 4096)
                except OSError:
                    raise QualificationError("AUTHENTICATION_AGENT_EXITED")
                require(data, "AUTHENTICATION_AGENT_EXITED")
                result = prompt.feed(data.decode("utf-8", errors="replace"))
                if result and result[0] == "identity":
                    require(ready, "AUTHENTICATION_BEFORE_REGISTRATION")
                    os.write(terminal, (result[1] + "\n").encode())
                if result and result[0] == "password":
                    require(ready and process_identity(config["applicationPid"]) == start_time,
                            "APPLICATION_IDENTITY_CHANGED")
                    require_package_command(config["applicationPid"], config["version"])
                    wait_private_terminal(terminal)
                    os.write(terminal, (password + "\n").encode())
                    password = ""
                if result and result[0] == "authenticated":
                    emit("authenticated")
                    # Success is authentication only. The caller still verifies dpkg,
                    # the replaced installed version, app restart, and clean profile.
            if os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                raise QualificationError("AUTHENTICATION_AGENT_EXITED")
        raise QualificationError("AUTHENTICATION_TIMEOUT")
    finally:
        password = ""
        stop_child(child)
        os.close(registered)
        os.close(terminal)


def walk_accessibles(root, limit=512):
    pending = [(root, 0)]
    count = 0
    while pending:
        node, depth = pending.pop()
        count += 1
        require(count <= limit and depth <= 16, "NATIVE_DIALOG_TREE_LIMIT")
        yield node
        children = node.get_child_count()
        require(0 <= children <= limit, "NATIVE_DIALOG_TREE_LIMIT")
        pending.extend((node.get_child_at_index(i), depth + 1) for i in range(children))


def find_dialog_button(applications, pid, version, choice, roles, observation=None):
    """Only the owned native dialog, its exact copy and exact buttons authorize a click."""
    matches = []
    if observation is not None:
        observation.update({"applications": min(len(applications), 64), "ownedApplications": 0, "windows": []})
    for app in applications:
        if app.get_process_id() != pid:
            continue
        if observation is not None:
            observation["ownedApplications"] += 1
        # GTK exposes native windows immediately below the application. Avoid
        # walking Electron's much larger rendered web content or clicking a web
        # imitation of a native dialog.
        count = app.get_child_count()
        require(0 <= count <= 64, "NATIVE_DIALOG_TREE_LIMIT")
        for dialog in (app.get_child_at_index(i) for i in range(count)):
            role = dialog.get_role()
            name = dialog.get_name()
            entry = {
                "role": roles.get("names", {}).get(role, "other"),
                "name": "update-title" if name == "Update Ready" else "target-message" if name == "Install Physical Systems " + version + "?" else "empty" if not name else "other",
                "message": False, "install": 0, "later": 0,
            }
            if observation is not None and len(observation["windows"]) < 16:
                observation["windows"].append(entry)
            if role not in roles["dialog"] or name != "Update Ready":
                continue
            nodes = list(walk_accessibles(dialog, 128))
            names = [node.get_name() for node in nodes]
            buttons = [node for node in nodes if node.get_role() == roles["button"]]
            button_names = [node.get_name() for node in buttons]
            entry.update({"message": "Install Physical Systems " + version + "?" in names,
                          "install": min(button_names.count("Install update"), 64), "later": min(button_names.count("Later"), 64)})
            if not entry["message"] or sorted(button_names) != ["Install update", "Later"]:
                continue
            matches.extend(node for node in buttons if node.get_name() == ("Later" if choice == "later" else "Install update"))
    require(len(matches) <= 1, "NATIVE_DIALOG_AMBIGUOUS")
    return matches[0] if matches else None


def click_confirmation(config, start_time):
    require(config.get("choice") in ("later", "install") and isinstance(config.get("version"), str)
            and re.fullmatch(r"\d+\.\d+\.\d+-beta\.\d+", config["version"]), "NATIVE_DIALOG_INPUT_INVALID")
    try:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi, GLib
    except ImportError:
        raise QualificationError("NATIVE_ACCESSIBILITY_UNAVAILABLE")
    Atspi.init()
    # Bound each remote accessibility call as well as the overall wait.
    Atspi.set_timeout(1500, 1500)
    deadline = time.monotonic() + 45
    observation = {}
    context = GLib.MainContext.default()
    while time.monotonic() < deadline:
        # Registry child changes are delivered through GLib. This helper polls
        # instead of running Atspi.event_main(), so dispatch pending events to
        # avoid indefinitely inspecting a cached pre-dialog application tree.
        for _ in range(64):
            if not context.pending():
                break
            context.iteration(False)
        require(process_identity(config["applicationPid"]) == start_time, "APPLICATION_IDENTITY_CHANGED")
        desktop = Atspi.get_desktop(0)
        count = desktop.get_child_count()
        require(0 <= count <= 64, "NATIVE_DIALOG_TREE_LIMIT")
        applications = [desktop.get_child_at_index(i) for i in range(count)]
        button = find_dialog_button(applications, config["applicationPid"], config["version"], config["choice"],
                                    {"dialog": (Atspi.Role.DIALOG, Atspi.Role.ALERT, Atspi.Role.FRAME), "button": Atspi.Role.PUSH_BUTTON,
                                     "names": {Atspi.Role.DIALOG: "dialog", Atspi.Role.ALERT: "alert", Atspi.Role.FRAME: "frame", Atspi.Role.WINDOW: "window"}}, observation)
        if button:
            require(button.get_process_id() == config["applicationPid"], "NATIVE_DIALOG_OWNER_MISMATCH")
            states = button.get_state_set()
            require(states.contains(Atspi.StateType.ENABLED) and states.contains(Atspi.StateType.SENSITIVE)
                    and states.contains(Atspi.StateType.SHOWING), "NATIVE_DIALOG_BUTTON_UNAVAILABLE")
            action = button.get_action_iface()
            require(action is not None, "NATIVE_DIALOG_ACTION_UNAVAILABLE")
            clicks = [i for i in range(action.get_n_actions()) if action.get_action_name(i) in ("click", "press", "activate")]
            require(len(clicks) == 1, "NATIVE_DIALOG_ACTION_AMBIGUOUS")
            require(process_identity(config["applicationPid"]) == start_time, "APPLICATION_IDENTITY_CHANGED")
            require(action.do_action(clicks[0]), "NATIVE_DIALOG_ACTION_FAILED")
            emit("clicked", action=config["choice"], method="at-spi")
            return
        time.sleep(0.1)
    # Authored categories/counts only. No title, message, PID, path, accessibility
    # tree, or unrelated application's content is returned to the CI report.
    emit("diagnostic", data=observation)
    raise QualificationError("NATIVE_DIALOG_NOT_FOUND")


def main():
    config = json.loads(sys.stdin.buffer.readline(4097))
    require(isinstance(config, dict), "INVALID_NATIVE_HELPER_INPUT")
    start_time = require_runner(config)
    if sys.argv[1:] == ["polkit"]:
        authenticate(config, start_time)
        return
    require(sys.argv[1:] == ["dialog"], "INVALID_NATIVE_HELPER_MODE")
    click_confirmation(config, start_time)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        main()
    except QualificationError as error:
        emit("failed", code=str(error))
        sys.exit(1)
    except BaseException:
        emit("failed", code="NATIVE_HELPER_FAILED")
        sys.exit(1)
