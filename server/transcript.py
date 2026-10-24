"""Render a raw tmux pipe-pane transcript as stable, readable plain text.

This is the fallback history source. While a pane is alive the panel reads it
through tmux's own terminal emulation (capture-pane), which is exact. Only when
tmux no longer has the pane is this leaf reader used, so it stays deliberately
small: it strips escape sequences and replays the terminal line discipline
(CR/BS/tab) on decoded text. It does not emulate cursor addressing, so a
full-screen TUI's redraws are not collapsed here. Text is decoded in one pass,
so a rewrite can never split a multi-byte character (the byte-wise rewrite used
before v0.4.1 could emit U+FFFD at the seam).
"""
import re
import sys

TAIL_DEFAULT = 2 * 1024 * 1024

CSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
OSC = re.compile(rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
DCS = re.compile(rb"\x1b[P^_].*?\x1b\\", re.S)
CHARSET = re.compile(rb"\x1b[()][0-9A-Za-z]")
ESC = re.compile(rb"\x1b[@-Z\\-_]")


def tail(path, limit):
    with open(path, "rb") as handle:
        handle.seek(0, 2)
        size = handle.tell()
        start = max(0, size - limit)
        handle.seek(start)
        data = handle.read()
    if start:
        # Never start mid-line: a partial first line reads as corruption.
        cut = data.find(b"\n")
        data = b"" if cut < 0 else data[cut + 1:]
    return data


def render(data):
    for pattern in (OSC, DCS, CSI, CHARSET, ESC):
        data = pattern.sub(b"", data)
    text = data.decode("utf-8", "replace")
    lines, current, column = [], [], 0

    def put(char):
        nonlocal column
        if column < len(current):
            current[column] = char
        else:
            current.extend(" " * (column - len(current)))
            current.append(char)
        column += 1

    for char in text:
        if char == "\n":  # newline ends the line
            lines.append("".join(current).rstrip())
            current, column = [], 0
        elif char == "\r":  # carriage return returns to column 0, keeps the line
            column = 0
        elif char == "\b":  # backspace steps the cursor back one column
            if column:
                column -= 1
        elif char == "\t":  # tab advances to the next eight-column stop
            while column % 8:
                put(" ")
        elif char >= " " and not ("\x7f" <= char <= "\x9f"):
            put(char)
    if current:
        lines.append("".join(current).rstrip())
    while lines and not lines[0]:
        # A freshly pipped pane starts with the blank remainder of its screen.
        lines.pop(0)
    return "\n".join(lines).strip("\n")


def main(argv):
    if len(argv) < 2:
        print("usage: transcript.py FILE [TAIL_BYTES]", file=sys.stderr)
        return 2
    limit = int(argv[2]) if len(argv) > 2 else TAIL_DEFAULT
    try:
        sys.stdout.write(render(tail(argv[1], limit)))
    except FileNotFoundError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
