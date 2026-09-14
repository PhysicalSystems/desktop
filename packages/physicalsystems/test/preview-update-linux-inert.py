# SPDX-License-Identifier: Apache-2.0
"""Hosted-only empty Electron confirmation fixture; no installer/authentication."""
import importlib.util
import json
import os
import pathlib
import re
import select
import stat
import subprocess
import sys
import time


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def private_json(path):
    information = path.lstat()
    require(stat.S_ISREG(information.st_mode) and information.st_uid == os.getuid()
            and information.st_nlink == 1 and information.st_mode & 0o077 == 0 and information.st_size < 16384,
            "INERT_DIALOG_PRIVATE_INPUT_REQUIRED")
    return json.loads(path.read_text())


def identity_for(child, engine):
    def identity(pid):
        require(pid == child.pid and child.poll() is None, "INERT_DIALOG_PROCESS_CHANGED")
        directory = pathlib.Path("/proc") / str(pid)
        require((directory / "exe").resolve() == engine, "INERT_DIALOG_EXECUTABLE_CHANGED")
        owner = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$", (directory / "status").read_text(), re.M)
        require(owner is not None and all(int(item) == os.getuid() for item in owner.groups()), "INERT_DIALOG_OWNER_CHANGED")
        fields = (directory / "stat").read_text().rsplit(") ", 1)[1].split()
        require(len(fields) > 19 and fields[19].isdigit() and fields[0] != "Z", "INERT_DIALOG_PROCESS_CHANGED")
        return fields[19]
    return identity


def read_event(child, timeout):
    require(select.select([child.stdout], [], [], timeout)[0], "INERT_DIALOG_EVENT_TIMEOUT")
    line = child.stdout.readline(1025)
    require(line and len(line) <= 1024, "INERT_DIALOG_EVENT_INVALID")
    return json.loads(line)


def stop_owned(child):
    if child.poll() is not None:
        return
    # Only this unreaped empty engine process, never a product/installer PID.
    child.terminate()
    try:
        child.wait(5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(5)


def main():
    env = os.environ
    require(sys.platform == "linux" and os.getuid() != 0 and len(sys.argv) == 2
            and env.get("CI") == "true" and env.get("GITHUB_ACTIONS") == "true"
            and env.get("RUNNER_ENVIRONMENT") == "github-hosted" and env.get("RUNNER_OS") == "Linux"
            and env.get("RUNNER_ARCH") == "X64" and env.get("GITHUB_REPOSITORY") == "PhysicalSystems/desktop"
            and env.get("PHYSICALSYSTEMS_ALLOW_DEVICES") == "0" and re.fullmatch(r"[1-9]\d*", env.get("GITHUB_RUN_ID", "")),
            "INERT_DIALOG_REQUIRES_DISPOSABLE_LINUX")
    os.umask(0o077)
    temporary = pathlib.Path(env["RUNNER_TEMP"]).resolve()
    root = temporary / "preview-update-linux-inert"
    require(temporary != pathlib.Path("/") and root.is_dir() and not root.is_symlink()
            and pathlib.Path(sys.argv[1]) == root / "plan.json", "INERT_DIALOG_ROOT_INVALID")
    plan = private_json(root / "plan.json")
    require(private_json(root / "owner.json") == {"kind": "inert-linux-native-confirmation", "runId": env["GITHUB_RUN_ID"]}
            and plan["root"] == str(root) and plan["runId"] == env["GITHUB_RUN_ID"]
            and plan["kind"] == "inert-linux-native-confirmation" and plan["engineVersion"] == "42.3.3",
            "INERT_DIALOG_OWNER_INVALID")
    engine = pathlib.Path(plan["engine"])
    expected_engine = (pathlib.Path(__file__).resolve().parents[2] / "desktop/node_modules/electron/dist/electron").resolve(strict=True)
    require(engine == expected_engine and plan["entry"] == str(pathlib.Path(__file__).with_suffix(".cjs"))
            and engine.is_file() and not engine.is_symlink() and (engine.parent / "version").read_text().strip() == "42.3.3",
            "INERT_DIALOG_ENGINE_INVALID")
    spec = importlib.util.spec_from_file_location("native", pathlib.Path(__file__).parent.parent / "src/release/preview-update-linux.py")
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    receipt = {"kind": plan["kind"], "status": "RUNNING", "engineVersion": plan["engineVersion"], "choices": [],
               "productLaunched": False, "installerLaunched": False, "sandbox": "disabled-for-uninstalled-inert-engine",
               "credentialStore": "basic-inert-fixture"}
    def save():
        with open(root / "result.json", "w") as output:
            json.dump(receipt, output)
    save()
    try:
        for choice, expected in (("later", 1), ("install", 0)):
            receipt["stage"] = choice
            save()
            selected = {key: env[key] for key in (
                "HOME", "DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "CI", "GITHUB_ACTIONS",
                "RUNNER_ENVIRONMENT", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "PHYSICALSYSTEMS_ALLOW_DEVICES") if key in env}
            selected.update({"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "LANGUAGE": "en",
                             "NO_AT_BRIDGE": "0", "GTK_MODULES": "atk-bridge", "ACCESSIBILITY_ENABLED": "1"})
            child = subprocess.Popen([str(engine), "--no-sandbox", "--disable-gpu", "--password-store=basic", "--force-renderer-accessibility",
                                      plan["entry"], str(root / "plan.json"), choice], cwd=root, env=selected,
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
            backend = None
            try:
                require(read_event(child, 20) == {"event": "ready", "engineVersion": "42.3.3"}, "INERT_DIALOG_ENGINE_RESPONSE_INVALID")
                identity = identity_for(child, engine)
                start = identity(child.pid)
                backend = native.X11DialogBackend()
                config = {"root": str(root), "applicationPid": child.pid, "version": plan["version"], "choice": choice}
                deadline = time.monotonic() + 45
                last_error = None
                while time.monotonic() < deadline:
                    try:
                        if native.click_x11_confirmation(backend, config, start, identity=identity):
                            break
                    except native.QualificationError as error:
                        if str(error) != "NATIVE_DIALOG_OCR_MISMATCH":
                            raise
                        last_error = error
                    time.sleep(0.1)
                else:
                    if last_error is not None:
                        raise last_error
                    raise RuntimeError("INERT_DIALOG_NOT_FOUND")
                require(read_event(child, 10) == {"event": "response", "response": expected}, "INERT_DIALOG_CHOICE_MISMATCH")
                require(child.wait(10) == 0, "INERT_DIALOG_EXIT_UNCONFIRMED")
                receipt["choices"].append({"choice": choice, "response": expected, "status": "PASS"})
                save()
            except native.NativeDialogRecognitionError:
                try:
                    native.capture_x11_diagnostic(backend, config, start, identity=identity)
                    receipt["diagnosticImage"] = "saved"
                except BaseException:
                    receipt["diagnosticImage"] = "unavailable"
                raise
            finally:
                try:
                    if backend is not None:
                        backend.close()
                finally:
                    stop_owned(child)
                    child.stdout.close()
        receipt["status"] = "PASS"
        receipt["stage"] = "complete"
    except BaseException as error:
        receipt["status"] = "FAIL"
        code = str(error)
        receipt["code"] = code if re.fullmatch(r"(?:INERT_DIALOG|NATIVE_DIALOG|APPLICATION)_[A-Z_]+", code) else "INERT_DIALOG_FAILED"
        if isinstance(error, native.QualificationError) and isinstance(getattr(error, "diagnostic", None), dict):
            receipt["recognition"] = error.diagnostic
    save()
    print(json.dumps({"status": receipt["status"], "stage": receipt["stage"], "code": receipt.get("code")}), flush=True)
    return 0 if receipt["status"] == "PASS" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        print('{"status":"FAIL","code":"INERT_DIALOG_GUARD_FAILED"}', flush=True)
        sys.exit(1)
