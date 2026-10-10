# experimental_os

ermine as an operating system, in the way Inferno is one: one OS, with
ports. It follows `working/PI-OS.tex`. The hardware is nodes, device drivers
are processes, interrupts become changes, and there are depths a person can
repair at. The first port is the Mac, hosted, as Inferno's `emu` is: a small
native program, the **metal**, turns the Mac's real devices into hardware,
and the OS owns the screen. An experiment: nothing here is in a paper.

```
mac/METAL.md          the contract between the metal and the OS
mac/metal/            the metal, in Swift: window, input, devices, the font ROM and the font chip; build.sh builds ermine-mac
typescript/main.ts    the OS's entry; the metal runs it, or --headless
typescript/host.ts    core 0: the SD card, the stack, /hw from the device tree, the drain, the loop
typescript/procs.ts   the scheduler: processes in the setup shape (WHAT-IS-A-PROCESS.tex, layout A)
typescript/metal.ts   the bus: records in, commands out, the frame buffer mapped; and a headless stand-in
typescript/ports.ts   what a driver holds of a device, as a live value
typescript/console.ts host code's own text console, for the bare monitor
typescript/blitter.ts the blitter: BitBlt (copy, over, blend, clipped) and text, in the font ROM or a font, a device;
                      and the draw device's ops: a list that records, played back, and selection over text runs
typescript/link.ts    the link (layers/link) as a device on irq 52: mounts what erminex shares on a channel
typescript/image.ts   what a first boot puts on the SD card
typescript/sync.ts    sync: SYNC.tex's wrapper over procs, and the device's key and Subduction's storage beside the card
typescript/presence.ts what is not a document, under what is shared, shown live over PRESENCE.tex's messages
image/drivers/        display (the compositor), font, kbd, pointer, uart, timer, power, cpu, usb, net, clip, volumes, sound, web,
                      access (what the screen means, for VoiceOver and the Mac's input methods), link
image/programs/       shell, term (a window with a shell), browser, graph (the graph browser),
                      edit (the editor and workspace), wmii (the window manager's core),
                      wmiirc (its policy), status (its bar), erminex (a shared window)
```

## Run it

```
experimental_os/mac/metal/build.sh        # once: builds experimental_os/mac/ermineOS
experimental_os/mac/ermineOS               # from a terminal: that terminal is the serial line
experimental_os/mac/ermineOS -- --fresh    # a fresh SD card: the image makes it again
experimental_os/mac/ermineOS --os "deno run -A --quiet experimental_os/typescript/main.ts"   # the TypeScript OS
```

ermineOS is the C OS (ERMINEOS.md): core's C graph, protect and scheduler,
with drivers in C and the JavaScript programs run by deno, which must be on
PATH, and sync: the layer's C sync and Subduction, through galaxy.observer
(`share path` in a shell, `mount path id` on another machine). The
build needs Homebrew's openssl@3 and, the first time, cargo, which builds
Subduction's library (minutes). Its card is `~/.ermine/card`: the device's
key and Subduction's store, from which each boot takes the graph back. A
card from before sync (graph.cbor) is left as it is, unread, and the image
makes the card again. The TypeScript OS's is `~/.ermine/sd`.
With no window: `experimental_os/c/test/headless.sh`, then
`experimental_os/mac/build/test/headless --fresh`, its stdin the serial
line, a line starting `!` a hand on the machine (c/test/headless.c).

The rest of this README describes the TypeScript OS, which the C one is
taking over from. `--fullscreen` and `--windows` work for both; windows
mode is not in the C compositor yet.

A card an older image made is brought up to date at boot. Whatever the
image made and no one has changed since gets the newer version, and anything
missing is made. A program you changed is left as you left it, and the log
says so.

The SD card is `~/.ermine/sd`. The OS's log is `~/.ermine/os.log` and the
metal's is `~/.ermine/metal.log`. Cmd-Q, closing the window, or `off` in a
shell powers off, and the SD card is written first. Ctrl-\ on the serial
line does the same.

With no window, for scripts and tests:

```
deno run -A experimental_os/typescript/main.ts --headless --fresh
```

Here stdin and stdout are the serial line, and a line starting `!` is a hand
on the machine: `!type ls`, `!key Enter cmd`, `!click x y`, `!drag x0 y0 x1 y1`,
`!usb attach 42 SanDisk`, `!power battery 15`, `!thermal serious`,
`!shot file.ppm`, `!wait 500`. `--w` and `--h` size the screen, and
`--unit 2` makes it as a Retina screen is.

The frame buffer has one pixel for each of the screen's own: on a Retina
screen, two pixels a point. The mode record's `unit` says how many, and
everything that draws measures in it, so lines, bars and windows are their
usual size and text is as sharp as the Mac's. `--scale 1` gives the old,
blown-up screen of points.

## What to try

- **The window manager is wmii's architecture.** Its core, /programs/wmii,
  has no policy. It tiles each view's windows in columns (default, stack or
  max), keeps a floating layer, and serves everything as nodes in
  /dev/wm:
  - `ctl` takes command lines;
  - `event` holds the last 64 events;
  - `keys`, `view`, `tag/<name>` (a view's columns), `client/<id>`;
  - `lbar` and `rbar` hold the bar's items.

  wmiirc (/programs/wmiirc) is all the policy: it reads `event` and calls
  `ctl`, so the key bindings live there. Open it in the editor, change a
  binding, save, and cmd-r. `status` writes the bar's right side as rbar
  items.
  The mod key is option (alt), as wmii's default Mod1 is. cmd belongs to the
  editor and the Mac.
  - alt-enter a shell, alt-b a browser, alt-g the graph, alt-e a workspace
  - alt-h/j/k/l select; alt-shift-h/j/k/l move the window (past the edge: a
    new column)
  - alt-d/s/m: the column's mode (default, stack, max)
  - alt-shift-space float or tile it; alt-space select the floating layer
  - alt-1…9 view a tag; alt-shift-1…9 tag the window; alt-shift-c or cmd-w
    close it
  - from a shell: `wm view 2`, `wm colmode sel stack`, `cat /dev/wm/event`
- **The world menu.** The rabbit, the menu bar's first menu, as System 7's
  apple: a shell, a browser, the graph, a workspace, the window manager's
  policy, Mac windows, power off. Its items are /etc/menu.
- **The graph browser** (cmd-g, or `graph <path>` in a shell). It has
  columns down the tree and, under them, the selected node: its value, its
  route, its slot, and the change that made it (who, through which code,
  why). It is live, because everything it shows is a tracked read, so
  `graph /dev/clock` ticks. Enter opens the node in an editor.
- **The editor** (enter in the graph, `edit <path>`, or cmd-e for the
  workspace at /apps/workspace/text). cmd-s writes the node as you, through
  protect. Edit a program, say `edit /programs/status`, and save: the status program's
  `/proc` node shows the new code as new, and cmd-r replaces it. Then `why
  /programs/status` shows every hop your keys took: you, the kbd driver, the
  window manager, the editor.
- **Do it, print it.** In any editor, cmd-d runs the line as JavaScript with
  `api` in scope, as you; cmd-p prints what it gave under it. Try
  `api.read({ address: ["/", "dev", "power", "battery"] })[0].value`.
- **Windows.** A window's × closes it. A floating window moves by its title
  bar. cmd-v pastes the Mac's clipboard. `exit`, or ctrl-d, closes a shell
  window; on the serial console it powers off.
- **Mac windows.** Ctrl-Cmd-W (or `windows` in a shell) turns each of
  ermine's windows into a Mac window, among your others. Ctrl-Cmd-W again
  brings back the monitor. Move one, and `why /dev/display/layers/<it>` says
  the Mac moved it (irq 33).
- **The browser** is real WebKit. In windows mode it sits inside its Mac
  window, and on the monitor it's an overlay plane. The toolbar is ermine's:
  cmd-l to type an address, cmd-[ and cmd-] for back and forward. From a
  shell, `browse <url>`. `cat /dev/web/pages/*` shows what WebKit says. A
  page can post to the graph with `window.ermine.post(...)`, which lands in
  `/dev/web/pages/<it>`.
- **The hardware is nodes.** In a shell, `tree /hw 2` shows the device tree
  the metal built from this Mac. Try `cat /dev/power/battery`,
  `cat /dev/cpu/load`, `cat /dev/net/path` and `ls /dev/usb`.
- **Plug something into USB.** Its node appears under /dev/usb, and a driver
  found by lookup starts under it and chimes. Pull it out and the driver
  ends, low chime and all. `why /dev/usb/<it>` names irq 44.
- **Unplug the charger.** `/dev/power/battery` changes and the bar follows,
  with no polling. `why /dev/power/battery` gives the irq and the time.
- **Every change says who.** `why /dev/kbd/state` shows you, vouched for by
  the host, then the drain, then the kbd driver's handler.
- **Depths.** `go dev`, `go hw` (`records` shows the metal's raw stream),
  `go stack` (`rules`, `flush`, `replace`). To edit a driver, add a rule at
  `stack>` first:
  `rule 0 {"under":"/drivers","agent":"<you>","allow":true}`.
  Then `sed /drivers/sound s/0.2/0.5/`. The running driver shows the new code
  as new, and `replace <pid>` at `stack>` runs it.
- **Booting bare.** `ermine-mac -- --bare` builds no stack. It runs the
  monitor on the screen and the serial line: `read`, `ls`, `write` and `rm`
  on the bare graph.
- `say hello`, `beep`, `copy text`.

## Text is text

- **The draw device.** A window is not pixels but ops: fills, frames,
  pixels and text runs (`blitter.ts`), as Plan 9's /dev/draw takes messages.
  A program draws on `blit.list(w, h)` as on a form and puts its ops in its
  layer's `draw`; the compositor plays them, and writes where each text run
  went to `/dev/display/text/<layer>`. `cat /dev/display/text/bar` is what the
  bar says.
- **Selecting.** Drag across any window's text and it is selected, on a
  lemon highlighter under the text; cmd-c copies it to the Mac's clipboard.
  The selection is `/dev/display/selection`. A window that selects for
  itself says `drags: true` and gets the drag: the editor does, with
  shift-arrows, cmd-a, cmd-c, cmd-x and cmd-v.
- **VoiceOver.** `/drivers/access` makes `/dev/access/tree` from the
  windows, their text runs, and what each program says it is (a layer's
  `access`: the editor and the shell are text areas, the graph's columns
  lists of buttons, the browser's toolbar buttons and a field, the menu
  menu items), and the metal mirrors it to the Mac's accessibility. Pressing
  an element clicks it.
- **The Mac's input methods.** What has the keyboard says where its caret is
  (a layer's `input`), `/dev/access/input`, and the Mac's input methods type
  there: Japanese, the emoji picker (ctrl-cmd-space), dictation, accents by
  pressing and holding. Text in progress shows at the caret, underlined.

## erminex

`erminex <channel or name> <cmd>` (`experimental_hosts/term/c`) shares one
program's terminal over the link. In a shell window here, `erminex <channel
or name>` puts what it shares in that window, as a program run in a rio
window: you type into the shared program, and cmd-w gives the shell its
window back. From the console it opens a window of its own.

```
cd experimental_hosts/term/c && make erminex && ./erminex kitchen zsh    # in a Mac terminal
erminex kitchen                                                          # in a shell window here
```

The link is a device, as the timer is: `/hw/devices/link`, irq 52, and
`/drivers/link`, which keeps what is mounted at
`/dev/link/windows/<name>/screen`. `cat /dev/link/windows/*` shows each
mount's state.

## Sync

Two machines share parts of the graph through a Subduction server, as
`layers/subduction/SYNC.tex` and `PRESENCE.tex` say. Sync is a wrapper over
procs, so what any program does in a shared folder is committed, and what
comes from the other machine is made here beneath protect.

- **Share a folder both machines write.** `share /apps/notes` makes the
  folder if nothing is there, a document, and prints its id, `ermine://` and
  64 hex digits. Whatever you make, write or remove in it then goes to the
  other machine, and its ephemeral nodes, a running process's among them,
  are shown there live.
- **Show anything else.** A node that is not a document, as the root and
  everything the image made are, keeps its id: `share /` or `share /dev`
  prints the id of a view, a document that stands for it. The other machine
  sees what is under it as it changes, and cannot change it.
- **Mount.** On the other machine, `mount /n/mac1 ermine://…` (`/n` is where
  other machines go, as on Plan 9). It reads pending until it has come.
- **Stop.** `rm /dev/sync/shared/<hex>` stops sending it; the folder stays.
- **Who sees it.** Anyone with a view's id sees it all, unencrypted, and the
  server relays it: `share /` includes what is typed and copied, and what
  every window shows. Paths in `/etc/sync`'s `"private"` list are never shown.
- **Another server.** `write /etc/sync {"server":"ws://localhost:8318"}`. The
  default is `wss://galaxy.observer`. A server on this machine:
  `deno run -A layers/link/typescript/deno/link.ts server`, which holds
  commits only while it runs.
- **What it is doing.** `cat /dev/sync/link` says whether it is connected,
  and to what, and how many nodes it shows; `ls /dev/sync/link` lists the
  documents it syncs; `cat /dev/sync/views` the paths it shows; `cat
  /dev/sync/@*` what it refused, what waits, what is stuck, and what it
  follows.

The device's key is never in the graph: it is in `<sd>.sync/key` beside the
SD card (`~/.ermine/sd.sync/key`), with Subduction's storage in
`<sd>.sync/store`. `--fresh` empties the card and keeps the key.
`deno test -A experimental_os/typescript/sync_test.ts` runs two headless
machines through a server on this machine.

## The look

It mixes:
- chee.party's lemon page, black lines and cherry;
- cream riso paper, with a two-colour rabbit and cherry that don't quite line up;
- System 7 windows (a pinstriped active title, a close box on the left, a hard frame and a drop shadow);
- acme's pale yellow in the shells, and a lemon highlighter for selections.

Text is the Mac's own fonts, rendered by CoreText at the screen's pixels.
The metal's font chip renders a page of 256 characters of any font at any
size when the OS asks, as Plan 9's fontsrv does. `/drivers/font` serves
the fonts `/etc/theme` names at `/dev/font`, one for each role: `text`
(Geneva), `title` (Geneva made bold, standing in for Chicago, for title
bars, the bar and menus) and `fixed` (Monaco, for the editor and the graph
browser's values). A character from a page not yet there asks for it, and
whatever drew it draws again when it comes. The shells are in the font ROM,
Monaco in cells (`ermine-mac --font NAME` for another), which is there
before anything else is.

Every colour and font comes from `/etc/theme`, which every program reads as
it draws. `edit /etc/theme`, change a colour or a font, save, and the whole
machine redraws in it.

## What building it ran into


- **A browser on the monitor is an overlay, until it is covered.** WebKit
  draws itself above the frame buffer, live, as a graphics card's video
  overlay does. While a window above covers any of it, the metal moves it
  under the frame buffer, where it goes on drawing. Its pixels are copied
  into a page plane a dozen times a second, and the compositor blits them at
  its window's depth. Its clicks and keys go to WebKit, not through the
  graph, except the OS's chords.
- **Records before their driver.** The metal reports each device's state as
  soon as it starts, before any driver has claimed its line. The drain keeps
  such records pending and hands them over when an owner appears, as a
  level-triggered interrupt stays pending.
- **No move in the TS graph.** GRAPH.tex has one, and the TS graph does not.
  The layer gives a process `release`, which unplaces an ephemeral node by id
  (an unplace given only `at`, on the bare graph) for the process that placed it.
- **A process's "."** is the folder it starts in (decided 10-09). Each
  driver's folder, /dev/display and the rest, is ordinary and saved; what
  the driver places there is ephemeral and its own. A window's nodes live
  under its own process node, so two windows never share a name.
- **Programs can't import**, so each drawing program carries its own few
  lines for glyphs.
- **No MMU here.** A JS program could reach Deno's globals. Protect guards
  the device ports (`/etc/rules`), but code is trusted, as on Oberon.
