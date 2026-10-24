"""Real terminal driver; only synthetic passwords and temporary account state."""
import json
import os
from pathlib import Path
import pty
import secrets
import select
import subprocess
import sys
import tempfile
import termios
import time


def snapshot(state):
    return {file.name: (file.read_bytes(), file.stat().st_mode, file.stat().st_mtime_ns)
            for file in state.iterdir()}


def exercise(node, cli, scenario, existing):
    password = secrets.token_hex(16).encode()
    other = secrets.token_hex(16).encode()
    with tempfile.TemporaryDirectory(prefix="panel-password-pty-") as directory:
        state = Path(directory)
        env = {**os.environ, "PANEL_STATE_DIR": directory}
        command = [node, str(cli), "--owner", "--rename", "synthetic"]
        if existing:
            initial = subprocess.run(command, input=other + b"\n", env=env, capture_output=True, timeout=5)
            assert initial.returncode == 0, "fixture setup failed"
            assert other not in initial.stdout + initial.stderr, "non-TTY echo"
        before = snapshot(state)
        master, slave = pty.openpty()
        child = None
        try:
            if scenario.startswith("typeahead"):
                attributes = termios.tcgetattr(slave)
                attributes[3] &= ~termios.ECHO
                termios.tcsetattr(slave, termios.TCSANOW, attributes)
                # Keep canonical mode: test both a queued line and an incomplete line.
                os.write(master, other + (b"\n" if scenario == "typeahead-line" else b""))
            original = termios.tcgetattr(slave)
            child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=env)
            output = b""
            answered = 0
            marker = b"hidden input): "
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    output += os.read(master, 65536)
                while output.count(marker) > answered:
                    flags = termios.tcgetattr(slave)[3]
                    assert not flags & termios.ECHO, "ECHO enabled at password prompt"
                    assert not flags & termios.ICANON, "raw mode missing at password prompt"
                    answered += 1
                    if scenario == "cancel-first" or scenario == "cancel-confirm" and answered == 2:
                        reply = b"\x03"
                    elif scenario == "eof":
                        reply = b"\x04"
                    elif scenario == "length":
                        reply = b"x" * 201
                    elif scenario == "mismatch" and answered == 2:
                        reply = other + b"\r"
                    else:
                        reply = password + b"\r"
                    # Reply immediately on observing the prompt, as in R6.
                    os.write(master, reply)
                if child.poll() is not None:
                    while select.select([master], [], [], 0)[0]:
                        output += os.read(master, 65536)
                    break
            assert child.poll() is not None, "CLI timed out"
            success = scenario.startswith("typeahead") or scenario == "success"
            assert child.returncode == (0 if success else 1), "unexpected CLI exit"
            assert password not in output and other not in output, "password echoed"
            assert termios.tcgetattr(slave) == original, "terminal state not restored"
            if success:
                assert b"Owner password saved" in output, "missing bilingual success"
            else:
                assert snapshot(state) == before, "cancel/error changed account state"
        finally:
            if child is not None and child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
            os.close(slave)


if __name__ == "__main__":
    cli = Path(__file__).resolve().parents[2] / "ops" / "set-password.mjs"
    cases = 0
    for existing in (False, True):
        for scenario in ("success", "cancel-first", "cancel-confirm", "mismatch", "eof", "length", "typeahead-line", "typeahead-partial"):
            exercise(sys.argv[1], cli, scenario, existing)
            cases += 1
    print(json.dumps({"cases": cases, "echoLeaks": 0, "restored": cases}))
