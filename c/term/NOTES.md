# ermine-term: a toy OS over the C graph

A terminal window manager whose windows are ermine processes. The host holds
the bare C graph (`../graph.c`) and a clock. It boots from a boot image and
starts programs that run outside it, through two loaders: `pty`, for any
executable on a pseudo-terminal, and `ermine`, for a program that speaks
PROTOCOL's lines on stdin and stdout. Each node under `/windows` is a
window: a process node, or a node a program keeps there (a mounted
terminal's window). What a window shows is its `screen` node, and what is
typed into it is written to its `keys` node; a pty is fed from there. One
terminal can share its `/windows`, or one window, over a link
(`programs/share`), on a fresh channel or one named by a word, and another
can mount it and show its windows as its own, and type into them
(`programs/mount`); see Sharing and mounting.

## Build and run

```sh
cd c/term
make              # ermine-term and erminex  (clang, -Wall -Wextra -Werror; -lncurses -lutil)
make erminex      # erminex alone (erminex, below)
make run          # ./ermine-term boot.json, in this terminal
make check        # vt_test, host_test, under ASan/UBSan
```

Run it from `c/term`, because the boot image names `examples/*.sh` and
`../../ts/deno/link.ts` relative to the working directory.

Two terminals, linked through wss://galaxy.observer (deno on PATH):

```sh
# terminal A                            # terminal B
cd c/term && make run                   cd c/term && ERMINE_MOUNT=kitchen make run
# C-g e (a counter), C-g s, w,          # or make run, then C-g m, kitchen, enter
#   kitchen, enter (share by name)
```

In B, focus A's counter with `C-g n`/`C-g p` and type `+`: A's counter
counts, and says `by: peer <B's key>...`. Any word will do as the name; a
name is a meeting place, not a secret (anyone who knows it can join).
Leaving the name empty shares on a fresh channel, which B then types in.

`ERMINE_TERM_LOG=file` sends the ermine programs'
stderr, and failed starts, to that file; by default they go to /dev/null.

## Keys

`C-g` (the prefix), then:

| key | what |
|---|---|
| `c` | a new shell window (`programs/shell`) |
| `e` | the counter example (`programs/counter`) |
| `t` | the clock example (`programs/clock`) |
| `s` | share over the link (`programs/share`): the status line asks what, `w` the whole `/windows` or `f` the focused window, then on what, a name or a channel typed in or nothing for a fresh channel; enter shares, escape cancels. Its window shows the name and the channel |
| `m` | mount another terminal's windows: the status line asks for a channel or a name; enter mounts (`programs/mount`), escape cancels |
| `n` / `p` | focus the next / previous window |
| `x` | close the focused window: unplace its node, which kills it (a mounted window goes when its mount's window is closed) |
| `q` | quit: unplace `/windows`, which kills every window, then exit |
| `C-g` | send a C-g to the focused window |

Every other key goes to the focused window. `ERMINE_SHARE=<channel or name>`
is what `C-g s` offers to share on (enter takes it); `ERMINE_MOUNT=<channel
or name>` mounts it as the terminal starts. A channel is 64 hex digits
(`deno run ts/deno/link.ts new` makes one); anything else is a name, and its
channel is the hex of SHA-256 of the UTF-8 text `ermine channel:` followed by
the name (`ts/src/link/name.ts`; `link.ts new <name>` prints it), so two
terminals given the same name meet on the same channel. The C side never
hashes: it hands the name to `link.ts`, which does. The layout is dvtm's
master/stack: the newest window is the master, on the left, and the rest are
stacked on the right, newest first. Each window has a title row (its pid, its
program, and a title the program set), and the last row is the status line
(the number of windows, the graph's time `t=`, and the focused pid).

## The tree

```
/
|- loaders/pty        {"loader": "pty"}
|- loaders/ermine     {"loader": "ermine"}
|- programs/shell     {"kind": "pty",    "argv": ["/bin/sh", "-c", "exec \"${SHELL:-/bin/sh}\""]}
|- programs/counter   {"kind": "ermine", "argv": ["/bin/sh", "examples/counter.sh"]}
|- programs/clock     {"kind": "ermine", "argv": ["/bin/sh", "examples/clock.sh"]}
|- programs/share     {"kind": "ermine", "push": true, "relay": true, "argv": ["deno", "run", ..., "../../ts/deno/link.ts", "host"]}
|- programs/mount     {"kind": "ermine", "push": true, "argv": ["deno", "run", ..., "../../ts/deno/link.ts", "mirror"]}
`- windows/
   |- @9-wixib        a process node, value null (or start's value)
   |  |- screen       ephemeral, id "@9-wixib/screen": what the window shows
   |  |- keys         ephemeral, id "@9-wixib/keys": the last key typed, or keys (a pty's)
   |  `- size         ephemeral, id "@9-wixib/size": {"rows": r, "cols": c}
   `- @9-hobuk        a mounted window, kept by a mount process: ephemeral, made by it,
      |               id "<mount's pid>/@9-hobuk", value {"mounted": "@9-hobuk"} (null for a mounted single window)
      `- screen, keys, size   the same three, ephemeral, made by it
```

`deno` is found on PATH when the program starts (`execvp`), and the path to
`link.ts` is relative to `c/term`, so run the terminal from there.

`boot.json` is the boot image. It holds PROTOCOL requests, one per line; lines
starting with `#` and blank lines are skipped. The host runs them as its first
changes. A request with no `agent` acts as the person, `{"actor": $USER,
"code": []}`. Each request's cause is its site, `{"file": "boot.json", "line":
n}`, and requests carry no `time` because the host's clock stamps them. `start
{address, program, value?, scope?}` is the host's own: `address` is a list of names
from the root.

### The window's nodes

- **size**: `{"rows": r, "cols": c}`, the window's content area, without its
  title row. The host writes it as the person (an outside change, with its
  site) whenever the layout changes; for a window that is not a process, only
  when it differs from what the node holds.
- **keys**: for an ermine program, or a window that is not a process, each key
  typed is a write of the key's name as a snapshot, as the person, with its
  site. A character is itself (`"a"`, `"é"`). The named keys are
  `"enter"`, `"tab"`, `"backspace"`, `"escape"`, `"up"`, `"down"`, `"left"`,
  `"right"`, `"home"`, `"end"`, `"pageup"`, `"pagedown"`, `"delete"` and
  `"insert"`; `"C-a"` is a control character and `"M-x"` is escape then a
  character. An escape sequence the decoder does not know is `"unknown"`.
  Pressing the same key twice is two changes.
- **keys, for a pty**: the one way keys reach a pty. What the person types
  into its window is written there, as the person, with its site
  (`pty.c`, `ptyKeys`): what one read of the terminal gave is one change, a
  key (a string) for one key, a list of keys for more (a paste). A key is
  named as above, unless its name would not give the pty the same bytes
  (`C-h`, `C-j`, F keys, anything `"unknown"`): then it is written as its
  bytes. The pty loader subscribes to the node and, for each write to it by
  anyone (the person here, a mounter through share), sends what it then
  holds to the pty, at once (the subscription is synchronous): a key or each
  key of a list. A key's name becomes its bytes (`keyBytes`, the reverse of
  `keyName`): a character is itself, `"enter"` is CR, `"tab"`, `"backspace"`
  (DEL), `"escape"`, the arrows, `"home"` and `"end"` as ?1 asks (`ESC O` or
  `ESC [`), `"pageup"`, `"pagedown"`, `"delete"`, `"insert"`, `"C-a"`...`"C-z"`
  and `"C-@"`...`"C-_"` the control character, `"M-"` and a key escape then
  that key, `"unknown"` nothing. Any other string is typed as it is, so
  `"echo hi\r"` is one write of eight bytes; the list `["u", "p"]` types the
  text `up`, where the string `"up"` is the arrow. Any other value, and any
  item of a list that is not a string, types nothing. What the pty cannot take at once
  waits for POLLOUT, in order. So a key is typed once, and every key a pty
  gets has an agent, a cause, and a time.
- **screen**: the grid, below.

### The grid (a screen node's value)

```
{ "rows": r, "cols": c,
  "lines":  [string, ...],             one per row, a code point a cell; trailing blanks left out
  "styles": [[[col, style], ...], ...] one list of runs per row (optional)
  "cursor": {"row": r, "col": c, "visible": b}   (optional; no cursor shown without it)
  "title":  s }                                  (optional; shown in the window's title row)

style: {"fg": n?, "bg": n?, "bold"?, "dim"?, "italic"?, "underline"?, "blink"?, "reverse"?: true}
```

A run applies from its `col` to the next run's `col`, or to the end of the row.
The row is plain before the first run, and `[col, {}]` returns to plain. A plain
row has no runs (`[]`). Colours are xterm's 0-255; a colour left out is the
terminal's own. A blank cell that a background or reverse makes visible is
kept as a space in `lines`. An ermine program may write any part of this; the
window manager draws `lines`, then `styles`, `cursor` and `title` if they are
there, and cuts each row at the window's width.

The pty loader writes the whole grid as one snapshot each time anything
changed, at most 60 times a second (once a frame), always as the process. A
row that did not change is the very value the last frame held, so a frame
costs only the rows that changed and the three lists. One patch a write keeps
the graph from making a copy of the screen per patch, and lets what the last
frame was made of be freed (Memory, below). (Before 2026-10-07 it wrote a
splice per changed row and a `set` for the cursor.)

## The loaders

The value of a loader node names one of the host's loaders (LOADERS.tex). A
loader is a `Loader` (host.h): `check` a program's value, `start`, `kill`,
`ready` (its fd), `keys`, `resized`, `tick`.

**pty** (`pty.c`, `vt.c`): `forkpty` with the window's size, `TERM=screen-256color`,
`ERMINE_PID=<pid>`, then `execvp(argv)`. Output goes through `vt.c`, a
small VT100/xterm state machine in the shape mtm and st use: ground, ESC,
CSI, OSC, DCS swallowed, and UTF-8. It handles cursor motion
(CUU/CUD/CUF/CUB/CNL/CPL/CHA/HPA/VPA/CUP), ED, EL, ECH, ICH, DCH, IL, DL, SU,
SD, DECSTBM, IND, RI, NEL, RIS, REP, tabs, SGR (16 colours, 256 colours, and
true colour folded into the 256-colour cube; bold, dim, italic, underline,
blink, reverse), insert mode, autowrap (?7), cursor keys (?1), cursor
visibility (?25), the alternate screen (?47, ?1047, ?1049), save and restore
cursor (ESC 7/8, CSI s/u, ?1048), DEC line drawing (`ESC ( 0`), OSC 0/2 titles,
and the answers to DSR 5/6 and DA. Keys the person types are written to the
pty through its keys node (The window's nodes, keys for a pty), with the
bytes the terminal sent, except that arrow keys, home and end follow ?1
(`ESC O A` or `ESC [ A`). A resize sets `TIOCSWINSZ`. The pty closing
(EIO) or the child being reaped means the program has exited.

**ermine** (`speak.c`, `protocol.c`): the program's stdin and stdout are pipes,
and its stderr is the log. Each line it writes is answered by `protocol.c`,
which **includes `../main.c` whole** (with its `main` renamed). A request is
therefore read, checked and answered by the same code as the conformance
harness's graph stack: field order, codes, `op`, items, change answers,
`events` queues. What differs:
- it is bound. Its `agent`, `process`, `place` and `chroot` are the host's,
  whatever the request says: it acts as its process, at its place. One
  exception, for a program the host trusts to act for others (Acting for
  others, below): its requests may name who they act for; Started
  with `scope` (every window's program here), its place is its window's node,
  chrooted there: `[]` is the window's node, `["screen"]` is its screen,
  `[".."]` is `above-root`, and `lookup` finds only what is inside the window.
  Started without (share and mount), its place is `/windows`, not chrooted:
  `[pid, "screen"]` is its own screen, and it can name every window;
- a request that gives a `place` (a list of names) acts below the bound
  place, chrooted at it: the place is the bound place followed by those
  names, and its `chroot` is the bound place's length plus the request's own
  `chroot` (0 if it gives none; more than its names is `wrong-field`,
  `chroot`). This is how share chroots a mounter's requests at `/windows`, as
  a link's owner does (`ts/src/link/serve.ts`). It never reaches above the
  bound place, so a scoped program gains nothing by it;
- the host's clock stamps every change; a request's `time` is ignored. Its
  `cause` is optional, as for any process;
- `reset`, `reload`, `batch`, `start` and `fire` answer `unsupported`;
- its subscriptions are numbered 1, 2, ... in its own session, as PROTOCOL
  numbers them per session;
- with `"relay": true` in its program's value, a request whose `agent` is
  an object with an `"actor"` acts as `{"actor": that actor, "peer": its
  "peer" (if it has one), "code": the process's own code}` (Acting for
  others);
- with `"push": true` in its program's value, each event of its
  subscriptions is written to it as it happens, unasked, as the line
  `{"sub": n, "event": e}` between its answers (PROTOCOL Commands, events),
  and `events` gives nothing. Answers start `{"seq":`, so the two never mix
  up. A program that does not say so polls `events`, as the examples do.
  While such a program is behind (more than 32 kB written for it that it
  has not read), a pushed event that is a write of one snapshot replaces
  the same subscription's such event still waiting whole; so a busy screen
  never queues more than one event a subscription for a slow program, and
  it gets the latest. Each replaced event is counted (`coalesced`, shown in
  its title row).

The examples use only POSIX sh, `printf`, `date` and `sleep`, with no jq:
- `examples/clock.sh` reads `size` once a second and writes the screen whole:
  the time in bold, the date in dim.
- `examples/counter.sh` subscribes to `keys` and `size`, polls `events` ten
  times a second, and redraws when something arrived. `+` or `up` counts up,
  `-` or `down` counts down, `0` resets, and `q` exits (its window goes).
  It shows who typed the last key: `here`, or `peer` and the first 16 hex
  digits of the peer key a link's owner stamped on it.

## Starting and killing

`hostStart(agent, cause, at, path, value)` follows SCHEDULER's start:
1. It searches for the program as SCHEDULER's Programs says: it reads `path`
   from the place `at`, then `[".."]` + path, and so on up to the start, and
   takes the first that reaches a node that is here. A path starting with `/`
   is not searched for. These are untracked reads, as the caller. Then it
   searches the same way for `loaders/<kind>`. The program and the loader are
   each kept as an identity, `{"node": id, "time": t}`. If no program is found,
   the code is `no-program`; a value that is not `{"kind": ...}`, or one the
   loader rejects (no `argv`), is `not-a-program`; no loader node, or one
   naming a loader the host lacks, is `no-loader`.
2. It picks a pid: `@`, the time the placement will get, `-`, and five random
   letters, consonant and vowel alternating (`arc4random`). If the placement
   answers `exists`, it picks the letters again.
3. It places the process node under its pid, as the caller, with the
   caller's cause. The answer is that placement's.
4. As the process, it makes `screen`, `keys` and `size` under the node,
   ephemeral.
5. Its place: with `"scope": true`, its own node, chrooted there (place
   `["windows", pid]`, chroot 2); without, the node it was placed into, with
   the caller's `/` (place `["windows"]`, chroot 0), as SCHEDULER's start says.
   The window manager starts window programs with scope, and share and mount
   without. The window's nodes are made as the process either way.
6. It subscribes, beneath any wrapper, to the process's address
   `["windows", pid]` and to its screen (so the UI knows when to draw).
7. It runs the loader's `start`.

The process's agent is `{"actor": <caller's actor>, "code": [...caller's
code, {"process": pid, "program": identity, "external": true}]}`: SCHEDULER's
last step for a program that runs outside the host, which has no runs.

**Killing.** The watch on the address marks the process as doomed when a
change leaves the address reaching nothing or another node: an unplacement
of the node or of a node above it, or a node placed in front of it in the
union. A change to the route that still reaches the same node is not a kill.
Once the operation that made the change returns, the host kills each doomed
process, in the order they were started. To kill a process, its loader stops
it: the pty loader sends SIGHUP to the child's process group and to the child,
then closes the pty; the ermine loader stops the speaker's subscriptions,
sends SIGHUP to the group and SIGTERM to the child, then closes the pipes. The
host then drops its watches and unplaces every ephemeral node made as the
process that is still here, the most recently made first (those its program
made, then size, keys and screen). Each is unplaced from its one slot through
`ermGraphRelease`, as the agent and process of the change that killed it, with
cause `{"killed": pid, "by": t}`. Finally it calls `forget(pid)` and removes
the process.

**Exiting.** A program that exits by itself has its node unplaced by the
host, as the person, with a cause that keeps the site and adds `{"exited":
status}` (SCHEDULER What a process acts as): `{"file", "line", "function",
"exited": status}`. That unplacement kills it as above. The status is its
exit code (a number), or `{"signal": n}` if a signal ended it, or `null` if
it never ran (the loader's start failed) or its output closed and it was not
reaped within a second. The host waits for the child to be reaped to know
the status: its output (the pty, or its stdout) closing only starts that
second.

## Sharing and mounting

`C-g s` asks what to share and on what, then starts `programs/share` in
`/windows`, without scope. Its value is `null` for the whole `/windows` on a
fresh channel, else `{"channel": c?, "place": [pid]?}`: `channel` is what
was typed (or `ERMINE_SHARE`), a channel or a name; `place` is the focused
window's name, to share only that window (`f`). It runs `ts/deno/link.ts
host`, which joins the channel on wss://galaxy.observer (the name's, the
one given, or a fresh one), writes the name and the channel into its
window's screen, and to its stderr (the log) with each mounter's key as
they come and go, and serves what it shares to whoever mounts the channel
(`ts/src/link/relay.ts`). Each mounter's request is sent to the host as a
line with `place` below share's own (what it shares, then the request's
place) and `chroot` the length of what it shares plus the request's, so the
speaker chroots it there; a `place` that is not a list of names or a
`chroot` past it is `wrong-field` before it reaches the host; `process` is
refused, `time` dropped; `events`, `start`, `reset`, `reload`, `batch` and
`fire` are unsupported. The answers go back as they came, except that
subscriptions are renumbered for each mounter, and the events the host
pushes are sent on to the mounter that subscribed, at most 60 times a
second, a newer snapshot write replacing one still waiting (Memory, and
the watchdog). So a mounter can read
every shared window's screen, keys and size, and write a window's keys
node: the counter reacts as to a key typed here, and a shell gets the key
on its pty. Every change it makes
carries the mounter's agent as share stamps it, with share's process as the
last step (Acting for others), and the mounter's cause. When a mounter
goes, its subscriptions are ended. When share is killed (`C-g x` on its
window), it says goodbye to its mounters. A share of one window keeps
sharing that place after the window is closed (its mounters then read
nothing there).

### Acting for others

A program whose value says `"relay": true` (only `programs/share` in the
boot image) is trusted by the host to say who it acts for. A request it
sends whose `agent` is an object with an `"actor"` acts as

```
{"actor": the request's actor, "peer": the request's peer (if any),
 "code": [...the process's own code, {"process": share's pid, "program", "external": true}]}
```

and the change's `process` is still share's. relay.ts stamps a mounter's
request as serve.ts does, `{"actor": claimed, "peer": key}`, with `key` the
verified signer of its frames, so on A a key typed in B shows who (B's
claimed actor and B's key) and through what (A's share process). A
request's own `code` is never taken: the code is always the host's. A
request with no agent, or one with no `actor`, acts as the process. A
program without the flag is bound as before: its own agent, whatever the
request says. So a protect rule (PROTECT.tex Rules) on A can match the
mounter's `peer`, the claimed `agent`, or the `process` share.

### Mounting

`C-g m`, then a channel or a name and enter (or `ERMINE_MOUNT` at start),
starts `programs/mount` in `/windows`, without scope, with what was typed
as its value. Its value may also be `{"channel": c, "place": [names]}`:
`place` is where to keep the windows, below its own place (`[]`, its place
itself, by default); the window manager starts it at `/windows` and with no
`place`, since it draws only what is under `/windows`, but nothing in the
link code fixes where a mount lives. It runs `ts/deno/link.ts mirror`, which
mounts the channel and keeps each window there as a window here
(`ts/src/link/windows.ts`): a node with the remote name, with `screen`,
`keys` and `size` below it, all ephemeral and made by the mount process.
When what is mounted is one window (the remote root has a `screen`), it is
kept as one window named by the name given, or the channel's first 8
digits. Each screen is read once and then kept in step: each change the
remote pushes for it is written here as the same patches, at most 15
writes a second, what came between them one write (a change to its
route reads it again). The mount subscribes to each kept window's `keys`
node here, and each key the person types into it (written there as the
person, by the window manager) is written to the remote window's `keys`
node, with the local change's cause. Windows come and go as the remote
subscription says, and a listing every 5 seconds catches what was missed.
The remote's size is its own terminal's: the size node here is written by
this window manager and not sent. Closing the mount's window kills it,
which releases every node it kept, so its windows go; if the link ends,
the mount unplaces them and its window says why. Its log line `mirror:
this side's key` names the key its requests are stamped with on the other
side.

A mounted pty window (a shell) is typed into as any other: B's window
manager writes each key to the mounted window's `keys` node, one change a
key, the mount writes it to A's shell's `keys` node through share, as B's
`{actor, peer}`, and A's pty loader sends it to the pty. A paste in B is
therefore one change a key on the way, not one list.

To link by hand instead: `deno run --allow-net --allow-read --allow-env
ts/deno/link.ts mount <channel or name>` speaks PROTOCOL lines on stdin and stdout
to the shared `/windows`.

## erminex: one program, one shared window

```sh
cd c/term && make erminex
./erminex kitchen zsh           # zsh fills this terminal, shared on the name kitchen
./erminex -s kitchen zsh        # the same, with a status line
# elsewhere: ERMINE_MOUNT=kitchen make run, or C-g m kitchen; or the demo
```

`erminex [-s] <channel-or-name> <cmd> [args...]` (`erminex.c`) is a host
(`host.c`, `pty.c`, `speak.c`, `protocol.c`, `vt.c`, the same files
ermine-term uses) with one window and no window manager: `<cmd>` runs on a
pty as a window's program, with scope, and its screen is drawn filling the
terminal (`draw.c`, which wm.c draws with too), with no title row. It shares
that one window as `C-g s` then `f` does: `programs/share` (`link.ts host`)
is started at `/windows`, without scope, with the value `{"channel": <the
channel or name>, "place": [<pid>]}`, so a name is hashed by link.ts
(`ts/src/link/name.ts`), as in ermine-term. A mounter (ermine-term's `C-g
m`, `ERMINE_MOUNT`, the demo, or `link.ts mount`) sees one window (the
remote root has a `screen`), named by the name or the channel's first 8
digits, and types into it through its keys node, as into any mounted shell.

Its tree: `/loaders/pty`, `/loaders/ermine`, `/programs/run` (`{"kind":
"pty", "argv": [cmd, args...]}`), `/programs/share`, and under `/windows`
the program and the share. No boot image: these are placed as the person,
each with its site. link.ts is found at the path it had when erminex was
built (`make` puts it in, absolute), or at `ERMINEX_LINK`; deno is found on
PATH. `ERMINEX_LOG=file` takes the share's stderr (its channel, and each
mounter's key as they come and go); `/dev/null` by default.

- **Keys.** Every key goes to the program, C-g too: there is no prefix and no
  quit key. To quit, end the program (`exit`, `:q`, ...).
- **Size.** The window is the terminal's size (less the status line), and
  follows SIGWINCH.
- **Status line** (`-s`, or `ERMINEX_STATUS=1`; off by default): the name, or
  the channel's first 8 digits; `n connected`, the number in the share's own
  screen (`mounted by n`), or `not shared` once the share is gone (deno
  missing, say); and the time, `HH:MM`, redrawn each minute. `0 connected`
  shows from the start, before the link is up.
- **Exiting.** When the program exits, erminex watches its node's
  unplacement, whose cause holds `{"exited": status}` (Starting and killing,
  Exiting), unplaces `/windows` (which kills the share: it says goodbye to
  its mounters), waits up to 3 seconds for the share's deno to exit (then
  SIGKILLs its group), and exits with the status: the exit code, 128 + n for
  `{"signal": n}`, 1 for `null`. A command that cannot be run exits 127, as
  the pty child does. If the terminal goes (stdin closes), or erminex gets
  SIGHUP, SIGTERM or SIGINT, it kills both the same way and exits with 128 +
  the signal (129 for stdin closing).

## Memory, and the watchdog (2026-10-07)

c/ frees nothing it has handed on (c/NOTES.md, Memory), and a host that
runs a long time grew: a busy pty (`seq 1 1000000000` in a shell, 40 by
120) took the footprint from 2.4 MB to 207 MB in 20 s (`footprint`), about
10 MB a second. Measured with `leaks`, most of it was not the graph's: each
turn of the loop listed `/windows` and read screens and sizes, and never
freed the lists the reads gave (42 MB in 6 s, at some 12 000 turns a
second); then the copies of the screen the graph made per patch (15 MB),
and the changes with their patches (10 MB). Now, with the same run, the
footprint stays at 2.6 MB for 20 s; `leaks` finds only the boot image's
requests (23 kB, once).

What is freed (`collect.c`; nothing in c/ outside c/term changed):
- **Results.** Every read, listing and change the host makes frees its
  result's lists (`ermResultFree`); the names, ids and values they name are
  the graph's.
- **Superseded writes to ephemeral nodes** (the collector). For a write
  made from a tree the host is handed (a pty frame; a speaker's request
  line), it reads the node before and after. Once a later write replaces
  it, what the node's earlier writes and earlier value reach that the new
  value and the new write do not is freed (a mark and sweep over those
  values only), and so are the earlier writes' change records. Never freed:
  the value a node held when the collector first saw it (its placement's,
  which the placement's change names), a value an untracked write put
  there, and anything while a speaker that polls holds events of that node
  not yet taken (they share its patches and values): it waits for the next
  write after. A node let go when its process is killed has the rest of
  its writes freed. A write of several patches leaves the graph's copies
  between them unfreed (they reach nothing it can find), so a pty writes
  one snapshot a frame; an ermine program that writes its screen in several
  patches still leaks those copies.
- **Requests and answers.** A speaker frees each answer once printed
  (all but what is under `value`, `agent`, `cause`, `patches` and `seq`,
  which it shares); and the request, with what it lost to the binding
  (agent, place, chroot, time), for a read, directory, lookup, events,
  unsubscribe, anything unsupported, and any error; a write's goes to the
  collector. A pushed event's row is freed once printed, as is its line.
- **Still kept** (small, and not per frame): a place, unplace or subscribe
  request and its answer (the graph keeps its ids, names and address);
  an error's answer; the two small lists `main.c`'s own `ctxOf` and
  `addressOf` make for each request; a read's routes inside `main.c`'s
  `command`; a writer's change kept by a subscriber in this process past
  the next write to the node (host_test's `see` keeps only unplacements).

The watchdog. Each turn of the loop (what poll gave, handled, and the
loop's own work, poll's wait left out) is timed (`hostTurn`), and a program
is behind when `BEHIND` (64 kB) or more written for it waits: answers and
pushed events it has not read, or keys a pty has not taken (`backlog`).
ermine-term's status line then says `lag 340ms` (the longest turn of the
last two seconds, when 100 ms or more) and `@9-wixib share behind 300 kB,
12 coalesced` (the program most behind); the window's title row says
`[behind 300 kB]`, or `[12 coalesced]` once any event was replaced.
erminex says it on its status line, or, without one, in the top right
corner while it has something to say. The link's own lag (ts/src/link) is
the TS side's: relay holds and replaces a mounter's events while the
transport has more than 256 kB waiting, and logs it (stderr, the log); a
mount says in its window when writing a screen here falls behind.

Rates over a link (ts/src/link): relay sends each mounter its events at
most 60 times a second, a write of one snapshot replacing the same
subscription's still waiting ones; a mount (windows.ts) writes each screen
here at most 60 times a second; and the Subduction transport is paced (64 kB
at once, then 256 kB a second) and nudged after a burst, since Deno's
WebSocket keeps a burst bigger than the socket's buffer until its next
write (plans/throughput.org).

## Changes to c/ outside c/term

Two small APIs, in `ermine.h` and `graph.c`, with no change to what the graph does:
- `ErmTime ermGraphLast(ErmInterface graph)`: the latest time in the graph,
  so the host's clock can go past the unplacements a change's letting go made.
- `ErmErr ermGraphRelease(graph, ctx, stamp, id, out)` (CORE's `release`;
  it was `ermGraphLetGo`): unplaces the
  ephemeral node `id` from its one slot, needing no address (SCHEDULER
  Ephemeral nodes: "this needs no address"). A killed process's node is often
  unreachable by the time its ephemeral nodes are let go. Inside, it is an
  `unplace` op at the node's parent: `change` was split so that it finds the
  node and then calls `changeAt`, which does the rest.

After these changes the conformance suite still passes 108 of 108 with
`ERMINE_REQUIRE=graph`, and `make check` in c/ passes.

## Tests (`make check`, ASan and UBSan)

- `vt_test.c`: byte strings into vt.c, with the grid checked. It covers text,
  CR/LF, CUP, EL 0/1, ED, clamping, scrolling, a scroll region with IND and
  RI, IL/DL/ICH/DCH/ECH, autowrap on and off, SGR (16, 256 and true colour,
  resets), coloured trailing blanks, sequences and UTF-8 split across writes,
  bad UTF-8, the alternate screen with the cursor restored, DEC line drawing,
  the DSR and DA answers, modes, saving the cursor, OSC titles ended by BEL and
  by ST, DCS, tabs, backspace, REP, insert mode, resizing, and RIS.
- `host_test.c`, which boots a test image:
  - key names;
  - a speaker bound and chrooted: `above-root` with `op`, a `lookup` that
    finds nothing above it, `reset` unsupported, `not-a-request` with its
    seq, its agent, process and time overridden, the ephemeral nodes it made
    recorded, and its own subscription numbers with `events`;
  - start: the pid's shape and its time, the identities, the agent, the
    window's nodes (ephemeral, made as the process), `no-program`,
    `not-a-program`, two kinds of `no-loader`, and a nearer `programs/`
    shadowing a farther one;
  - kill by unplacing: SIGHUP reaches the child, and the three let-go
    unplacements are seen through a mount of the process node at `/peek`,
    with their order, times, agent, process and `{"killed", "by"}` cause;
  - kill by a node placed in front in the union, kill by the program
    exiting, and quitting by unplacing `/windows`;
  - a pty program's text, bold run and cursor; a resize reaching its size
    node and its screen; keys echoed by `cat` on the pty;
  - `keyBytes`: each name to its bytes (arrows in both ?1 forms, `C-a`,
    `C-c`, `C-z`, `C-_`, `M-x`, `M-up`, `"unknown"` to nothing), and text
    that names no key (`"hello"`, `"C-"`, an F key's bytes) typed as it is;
  - a pty's keys, all through its keys node, with `cat`: `abc` typed here is
    one change, `["a", "b", "c"]`, as the person with `ptyKeys`'s site, and
    the screen's first line is `abc`, not `abcabc`; `z` twice is two changes
    and `zz`; C-h and up typed here are `["\b", "up"]` and the tty echoes
    `^H^[[A` (so C-h is not sent as DEL); `"x"` then `["y", "enter"]`
    written to the node by another agent (`{actor: bob, peer: k1}`, a
    process) show `xy` twice (the tty's echo and cat's), and the node's last
    change is that agent's; a paste of 21300 bytes (300 lines of 70 and CR)
    into `stty -echo; cat > file` is one change, a list of 21300 keys, and
    the file is the text exactly, CRs as LFs; `"C-c"` written by another
    agent, and C-c typed here, reach `stty raw; dd bs=1 count=1 | od` as
    `03`. The pty took the whole paste at once here (macOS), so the
    POLLOUT path for what it cannot take is not exercised;
  - `examples/counter.sh` over pipes: it counts `+` and `up`, its screen
    write is made as its process, a resize reaches it through its `size`
    subscription, and `q` makes it exit and its window go;
  - `examples/clock.sh` draws the time in bold;
  - a speaker at `/windows`, not chrooted, as share is: it reads above
    `/windows`; a request with `place` is chrooted at its place (`..` is
    `above-root`), a `chroot` past its names is `wrong-field`; with push, an
    event comes as `{"sub":1,"event":{"change":...}}`, `events` gives `[]`,
    and nothing more comes once it is stopped;
  - a window that is no process: `hostWindows` lists it, keys typed into it
    are written to its keys node as the person with a site, one change a key,
    and a resize writes its size node;
  - a speaker that relays: a request's actor and peer are kept, with its
    own code (a forged `code` dropped) and its process; no agent, or a
    string, acts as itself; a speaker that does not relay puts its own;
  - the `external` step, a scoped start's place (chroot 2), an unscoped
    start's place (`/windows`, chroot 0) with its window's nodes still made
    as it, and the `{"exited": 3}` cause, with the site, as the person, of a
    program that exits;
  - memory: a pty printing 150 screens of text 10 ms apart has its screen
    whole at the end (24 rows of lines and styles) and the collector has
    freed over a thousand values meanwhile; a program with push that
    subscribes to that screen and never reads its stdin has had events
    replaced and has under 256 kB waiting; the watchdog names it when it is
    behind, and says `lag 250ms` after a slow turn. All under ASan, so
    nothing freed was used.
- By hand (headless): `ermine-term` driven through a pty from a Python script,
  with its output replayed through vt.c to see the screen. Three windows were
  tiled with title rows and the status line; the shell echoed, the counter
  reached 2, the clock ticked; a SIGWINCH resize, `C-g x`, `C-g c` and `C-g
  q` all worked, with exit status 0 and no children left. The same run under
  ASan/UBSan was clean. vim (alternate screen, `dd`) and less (`G`) rendered
  correctly inside a shell window.

- Sharing and mounting, headless, through wss://galaxy.observer (2026-10-07),
  each terminal driven through a pty from a Python script and its output
  replayed through vt.c:
  - terminal A started the counter, then `C-g s`: its share window showed
    the channel. A separate `deno run ... link.ts mount <channel>` read
    `/windows` (the shell, the counter, the share window), read each screen,
    subscribed to the counter's screen, and wrote `"+"` three times to its
    keys: A's counter showed `count: 3`, `events` gave the pushed screen
    changes, `["..", "programs"]` was `above-root`, and A's share window
    said `mounted by 1`;
  - terminal B, `C-g m` and the channel: B showed A's three windows beside
    its own (titled `mounted`), with the counter's screen; focused on the
    mirrored counter, `+ + + up -` made A's counter `count: 3`, `last key:
    -`, and B's copy showed the same. B quitting made A's share window say
    `mounted by 0` (the mount said goodbye). Both exited 0, no deno left; the
    same run under ASan/UBSan was clean;
  - B started with `ERMINE_MOUNT=<channel>`, A with `ERMINE_SHARE` set: A's
    shell running `echo mirrored-$((6*7))` showed `mirrored-42` in B's copy;
    `C-g x` on B's mount window took every mirrored window away.

- Sharing and mounting by name, headless, through wss://galaxy.observer
  (2026-10-07), both terminals driven through a pty from a Python script,
  output replayed through vt.c:
  - A: `C-g e`, `C-g s`, `w`, the name `ermine-test-0cb81799`, enter. A's
    share window showed the name and the channel `726ef47f…d2d60d`, which is
    what `link.ts new ermine-test-0cb81799` prints. B: `C-g m`, the same
    name, enter: B showed A's windows; focused on A's counter, `+ + +` made
    A's counter `count: 3`, `by: peer 1c2fea0e1d551719...`, B's key from its
    log (`mirror: this side's key 1c2fea0e…`), and A's log said `mounted by
    1: <that key>`. A third peer (`link.ts mount <name>`) read A's counter's
    keys node through the share: its change's agent was `{"actor":
    {"actor": "chee", "code": []}, "peer": "1c2fea0e…c78d87", "code":
    [{"process": "@28-xetot", "program": {"node": "share", "time": 8},
    "external": true}]}`, process `@28-xetot` (A's share), cause B's site
    (`host.c`, `hostWindowKeys`);
  - then A focused its counter, `C-g s`, `f`, the name plus `-one`: its
    share window said `sharing /@17-livox`; B mounted that name and showed
    one window named `ermine-test-0cb81799-one`; `-` typed there made A's
    counter 2. Both quit with status 0;
  - again with `ERMINE_SHARE=<name>` on A (offered at the second question,
    enter took it) and `ERMINE_MOUNT=<name>` on B, both built with
    ASan/UBSan: B mounted at start, `+` made A's count 1, by B's key; both
    exited 0, no sanitizer report.

- Typing into a mounted shell, headless, through wss://galaxy.observer
  (2026-10-07), with the release build and again with ASan/UBSan, both
  terminals driven through a pty from a Python script, output replayed
  through vt.c: A typed `echo local-$((6*7))` into its own shell (zsh): the
  command line showed once, then `local-42`. A shared `/windows` by a fresh
  name (`C-g s`, `w`, the name); B mounted it by that name (`C-g m`),
  focused A's shell (`C-g n`), and typed `echo hi` and enter. A's shell
  showed `▶ echo hi`, then `hi`, then a new prompt, and B's copy showed the
  same. A third peer (`link.ts mount <name>`) read A's shell's keys node:
  value `"enter"`, agent `{"actor": {"actor": "chee", "code": []}, "peer":
  <B's key, as B's log names it>, "code": [{"process": <A's share>,
  "program": {"node": "share", "time": 8}, "external": true}]}`, process A's
  share, cause B's site (`host.c`, `hostWindowKeys`). Both quit with status
  0, no sanitizer report, no link.ts left. The counter run (`+` from B,
  `by: peer` B's key) still passed.

- erminex, headless, through wss://galaxy.observer (2026-10-07), each
  terminal driven through a pty from a Python script, output replayed through
  vt.c, with the release build and again with ASan/UBSan:
  - `erminex -s <name> sh`: the status line said `<name>  0 connected`
    and the time; erminex's children were `sh` and one `deno ... link.ts
    host`. A `link.ts mount <name>` read `["screen"]` (the prompt), and the
    status line said `1 connected`; it wrote `"echo hi"`, then `"enter"`, to
    `["keys"]`: erminex showed `$ echo hi`, `hi`, `$`, and the mounter's read
    of the screen had `hi`. The keys node's last change was the mounter's
    agent with its peer key, under share's process. The mounter leaving made
    it `0 connected`. A resize to 20 by 60 made `stty size` say `19 60` (one
    row for the status line). C-g went to sh; `exit 7` made erminex exit 7,
    and its link.ts was gone. The share's channel was what `link.ts new
    <name>` prints;
  - without `-s`, the program's last row was the terminal's last row; `kill
    -9 $$` made erminex exit 137, no child left; closing the pty's master (a
    hangup) made it exit 129, with its sh and its deno gone;
  - an ermine-term with `ERMINE_MOUNT=<name>` showed the window as `<name>
    mounted`; focused there, `echo hi` and enter showed `hi` in erminex and in
    the copy, and erminex's status line went from `1 connected` to `0
    connected` when that terminal quit; `exit 0` then exited 0, no child left.
    No sanitizer report in any run;
  - `erminex x` alone prints the usage and exits 2; `/no/such/thing` exits 127.

Not tested: a person actually using it in a real terminal, colours as
ncurses shows them, wide characters (CJK and emoji take one cell here), a pid
collision, and a program that floods its stdout or stops reading its stdin.
For erminex: the demo mounting it, full-screen programs (vim, less) inside
it, and the status line's minute ticking over.

## Departures from the papers

From SCHEDULER.tex:
1. **No compute and no effect.** Programs run outside the host, and the C
   core has no scheduler. A program is `{"kind", "argv"}`, not `{"kind",
   "compute", "effect"}`. Nothing is recorded, there are no runs or rounds,
   marks are never acted on (the graph marks no one anyway, since nothing
   records), and no items are put in front of a process's value: no waiting,
   stopped, error or `newer`. The program and loader searches are not
   watched, so a newer program never shows.
2. **The place.** As SCHEDULER's start: with `scope`, a process's `/` is its
   own node, and without, it acts at the node it was placed into. A scoped
   process's place is its own node, which is also its `cwd` (SCHEDULER leaves
   the cwd of a scoped process unsaid).
3. **The agent's last step** is `{"process": pid, "program": identity,
   "external": true}`, as SCHEDULER says for a program outside the host.
4. **Loader writes.** At start, the host makes the window's nodes as the
   process, and the pty loader writes the screen as the process, both with
   no cause. Keys typed into a pty's window are the person's writes to its
   keys node, with their site; the loader only reads them.
5. **Exiting.** As SCHEDULER says, with the status's form the host's own
   (Starting and killing, Exiting).
6. **Kill.** No cleanup runs. Instead the loader signals the child (SIGHUP,
   plus SIGTERM for ermine programs) and does not wait for it to exit before
   its ephemeral nodes are let go. A killed process is removed: there is no
   `stopped` item, since no process is killed with a parent.
7. **Children.** Processes are started only by the host (the boot image and
   the window manager), and ermine programs cannot `start`, so no process has
   a parent and there is no tree.
8. **One place.** The host does not stop a process node from being placed or
   mounted elsewhere (there is no scheduler wrapper to refuse it); the tests
   mount one at `/peek`.
9. **Rounds, queueing, budget.** None: one thread runs each operation to the
   end, then kills what it doomed.
10. **pid letters** come from `arc4random`, and a pid is picked again when the
    placement answers `exists`. This is the graph's own "already has that
    id".

From LOADERS.tex:
11. A loader runs the whole program, not one part. It is told at start and at
    kill, as LOADERS says, but there is no `pending`, and no answer nodes.

From PROTOCOL.tex (for ermine programs):
12. The session is the host's; see "The loaders" above for what is bound,
    stamped or unsupported.
13. **Push is asked for in the program's value** (`"push": true`), since a
    program must expect lines it did not ask for. PROTOCOL allows the push but
    does not say how a program asks for it.

From CORE.tex:
14. **Site.** The site of an outside change is `{"file", "line",
    "function"}`, from `__FILE__`, `__LINE__` and `__func__`; C has no column.
    The boot image's are `{"file": "boot.json", "line": n}`.
15. **Memory.** c/ frees nothing it has handed on (c/NOTES.md, Memory); the
    host frees what writes to ephemeral nodes leave once nothing reaches it,
    and its own scratch (Memory, and the watchdog). What it still keeps is
    listed there.

Of the host's own:
16. **A request's place below the bound place** (The loaders) is the host's
    own, for share; PROTOCOL has a process's place fixed by its host.
17. **Windows that are not processes.** The window manager draws every node
    under `/windows` and writes keys and size to the ones that are not
    processes, as the person: SCHEDULER and LOADERS say nothing of windows.
18. **Acting for others** (an extension). SCHEDULER binds a process to its
    own agent. A program flagged `"relay": true` in its program node may
    instead act for someone it names: the actor and peer of its request's
    agent are kept, under its own code, so its process is the last step
    (Sharing and mounting, Acting for others). The host trusts the flag,
    which only whoever can write the program node can set, and checks
    nothing of the peer: it is relay.ts that stamps it from the verified
    sender. The change's `process` stays the program's, so what it makes
    for a mounter is let go when it is killed.
