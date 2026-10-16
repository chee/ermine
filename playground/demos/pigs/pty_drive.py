#!/usr/bin/env python3
# pty_drive.py OUT ROWS COLS -- program args...: the program on a pty of that size, everything it draws
# appended to OUT (shot.ts plays it into a picture). Lines on stdin say what to type:
#   type TEXT   TEXT with Python escapes (\x1b[A an arrow, \t, ...)
#   click COL ROW / press COL ROW / drag COL ROW / release COL ROW / move COL ROW   SGR mouse (0-based cells)
#   wait SECONDS
#   size ROWS COLS   the pty resized (the program is sent SIGWINCH)
# end of stdin: the program is sent q (twice if need be, then SIGTERM), and waited for
import fcntl, os, pty, select, signal, struct, sys, termios, threading, time

out, rows, cols = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
argv = sys.argv[sys.argv.index("--") + 1:]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.environ["COLORTERM"] = "truecolor"
    os.environ["TERM"] = "xterm-256color"
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
log = open(out, "wb")


def reader():
    while True:
        try:
            data = os.read(fd, 65536)
        except OSError:
            return
        if not data:
            return
        log.write(data)
        log.flush()


threading.Thread(target=reader, daemon=True).start()


def pump(seconds):
    time.sleep(seconds)


def mouse(code, col, row, final="M"):
    os.write(fd, f"\x1b[<{code};{col + 1};{row + 1}{final}".encode())


pump(0.2)
for line in sys.stdin:
    word, _, rest = line.rstrip("\n").partition(" ")
    if word == "type":
        os.write(fd, rest.encode().decode("unicode_escape").encode("utf-8"))
    elif word in ("click", "press", "drag", "release", "move"):
        c, r = map(int, rest.split())
        if word == "click":
            mouse(0, c, r), pump(0.05), mouse(0, c, r, "m")
        elif word == "press":
            mouse(0, c, r)
        elif word == "drag":
            mouse(32, c, r)
        elif word == "release":
            mouse(0, c, r, "m")
        else:
            mouse(35, c, r)
    elif word == "size":
        r, c = map(int, rest.split())
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
    elif word == "wait":
        pump(float(rest))
        continue
    pump(0.03)
# q, again if a screen took the first (a help), then SIGTERM
for i in range(3):
    try:
        os.write(fd, b"q")
    except OSError:
        break
    for _ in range(30):
        done, _ = os.waitpid(pid, os.WNOHANG)
        if done:
            sys.exit(0)
        time.sleep(0.1)
    if i == 1:
        os.kill(pid, signal.SIGTERM)
os.waitpid(pid, 0)
