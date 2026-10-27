# ermine on the Cardputer ADV

The M5Stack Cardputer ADV (ESP32-S3, 8 MB flash, no PSRAM) running ermine's C: the process api and
everything under it, built from where it lives in the repo (`components/ermine/CMakeLists.txt`).

    ./setup.sh     # once: ESP-IDF v6.0.3 into ~/esp (about 2 GB, C only)
    ./flash.sh     # build, flash over USB, show the serial log (ctrl-] leaves)
    ./sim.sh       # the same programs on the Mac, stdin as the keyboard

On the device:

- `/keyboard`: the keyboard driver writes each key there.
- `/programs/shell`: a program on the process api only. It keeps `line` and `said`, a memo `sum`
  (the numbers at the root added up) and a memo `screen` (the tree from `/`).
- `/programs/display`: an effect that draws `screen`.

Type `name = value` (a number, `true`, `false`, `null`, `"text"`, or any text) or `rm name`; fn +
`` ` `` is esc. The header shows the free heap.

The den is on tippet (`experiments/tippet`), as the dens page's `playground/demos/dens/host.ts`
makes one (the contract at its top): its node `ermine:ed01<key hex>` (the install: `main/flash.c`,
kept in NVS), its parts (keys, screen, pigs, speaker and those below: no software, each a plain
process it starts itself, ermine/processes' start, its body the C driver in `main/things.c`; their
kinds said on its node's `ermine.den.parts`, a start ask names one), its things at `/home/keys`,
`/home/screen`, `/home/pigs` and `/system/speaker`, their attributes at `<den>/things/<process
id>`,
its `inbox` and `authorized_keys`, as steps in the room's log, `dens-<code>` on the server
(`https://galaxy.observer` by default), linked by tippet's http long-poll (`main/poll.c`) over WiFi
(`main/wifi.c`: one esp_http_client on one task, https checked against ESP-IDF's common CAs). Who's
here: a live every 2 s; another den not heard for 6 s shows as quiet in the band at the foot of the
screen. The inbox (`main/den.c`) is the one place that checks who may: a pair ask from anyone
(signed by who it says) shows "<name> wants to pair": **tab** is yes (the asker into
`authorized_keys`), **esc** (fn + `` ` ``) no; start, stop and unpair only from a den in
`authorized_keys`, and a refusal shows in words. The log is kept on flash (FAT file systems: `den`,
1 MB at `/f`, and `den2`, 3 MB at `/g`, `partitions.csv`; a room's at `/f/t2<code>` or
`/g/t2<code>`: tippet's packed runs), so a reset goes on from its last step; a room joined while
`/f` has under 96 KB free is moved to `/g` whole first (copied, read back, then the old let go), and
once the den is up the file system its room isn't on is let go for the heap; a snapshot of the
history is kept at each boot and again once 16 steps have come and none for 5 s, so a boot loads it
(each node's value once) and lands only the steps after. `CONFIG_CARDPUTER_FORGETS` (off) tries
tippet's forgetting: each snapshot lets go of the runs galaxy has.

**G0** (the BOOT button, or ctrl-g on the serial line) opens the menu, `/system/menu`, a folder in
the den's graph: each child an item, its value a handler (an action, the process api's `es_create_action`),
run with `es_execute_action` when picked (enter, or its number; `;` `.` move, esc shuts). "join a room": four
of ACDEFHJKMNPRTWXY, enter. "new room": a code picked and shown big; enter goes there. The room is
kept in NVS (`dens`/`room`; menuconfig's `CONFIG_CARDPUTER_ROOM` only when NVS has none), and going
to one says bye, syncs the log and restarts the den in it; its code is always at the screen's top
right. A den that doesn't come up in a room offers G0: back to the room before. A paired den may put
items in through the inbox (host.ts' contract: the `menu` ask), each a start or stop done when
picked, while it is still paired; they come back at each boot.

Its parts beside keys, screen and pigs, not running until a paired den asks for one by kind (each
about 10 KB of heap running): `tilt` (BMI270: x and y, -10 to 10), `loudness` (the mic, 0 to 10),
`led` (the WS2812 on G21: the colour wired in), `ir` (G44: NEC codes), `battery` (ADC G10: a
percentage), `sd` (the microSD's top folder), `grove` (Port A's I2C addresses), all in
`main/parts.c` (pins from M5's page and M5Unified), the runners in `main/things.c`. The den's
`speaker` runs at `/system/speaker` (on its card): each change wired in plays one of the dens'
voices (ding pop sparkle plink blip tick chime), made on the device through the ES8311 (16 kHz,
small DMA), let go 3 s after.

On the serial line: ctrl-s prints the screen (hex rows), ctrl-t the send path's times (`trace:`),
ctrl-n the heap now and its lowest since the last ctrl-n, ctrl-y the log's own sync (3 s quiet, or a
second after). At boot `bench:` says the CPU's clock, the flash's mode, and what a signature and a
pack cost.

The network: `sdkconfig.secrets` (git ignores it), two lines, made once by hand:

    CONFIG_CARDPUTER_WIFI_SSID="the network"
    CONFIG_CARDPUTER_WIFI_PASSWORD="its password"

`CMakeLists.txt` stacks it after `sdkconfig.defaults`, so a build fills `sdkconfig` from both (a key
`sdkconfig` has already wins: to change the network, edit `sdkconfig.secrets` and delete the two
`CONFIG_CARDPUTER_WIFI_*` lines from `sdkconfig`, or `./idf.sh menuconfig`, "Cardputer: the den's
network"). Never put them in `sdkconfig.defaults`. No network: no WiFi, the den alone (and the
shell, esc between it and the den's screen). The same menu has the tippet server and the room
(`CONFIG_CARDPUTER_ROOM`: the first room, when NVS holds none). `sdkconfig.defaults` holds the heap
settings (WiFi, mbedtls and lwIP buffers, IRAM, stacks, FAT), each with a line saying why;
`sdkconfig` can be deleted and made again from it.

`./sim.sh` runs the same den on the Mac (curl for the long-poll, its install and log in
`/tmp/cardputer-sim`): `SIM_ROOM=KAYA ./sim.sh`, then type; a line `tab` says yes to a pair ask,
`esc` no, `print` says the den's state; the screen goes to `/tmp/dens/card/sim.png`.

The old path (littlesync rows and presence, `main/room.c`, `main/net.c`, `main/lschannel.c`) is out
of the build; its files are where they were.

From the Mac, over USB: `python type.py /dev/cu.usbmodem* 'a = 3' 'b = 4'` types lines into the
device and prints the tree after each one; `python log.py PORT` resets it and prints its log (use
the python in `~/.espressif/python_env/*/bin`, which has pyserial).

The flash as it was before ermine: `~/esp/cardputer-backup-2026-10-17.bin`. To put it back:
`python -m esptool --chip esp32s3 -p PORT write-flash 0 ~/esp/cardputer-backup-2026-10-17.bin`.
