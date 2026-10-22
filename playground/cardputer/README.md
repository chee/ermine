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

The den is on tippet (`experiments/tippet`), as the dens page's `playground/demos/dens/host.ts` makes
one (the contract at its top): its node `ermine:ed01<key hex>` (the install: `main/flash.c`, kept in
NVS), its runners keys, screen and pigs offered under it on software (`experiments/software`), its
things at `/home/keys`, `/home/screen` and `/home/pigs`, their attributes at `<den>/things/<process
id>`, its `inbox` and `authorized_keys`, as steps in the room's log, `dens-<code>` on the server
(`https://galaxy.observer` by default), linked by tippet's http long-poll (`main/poll.c`) over WiFi
(`main/wifi.c`: one esp_http_client on one task, https checked against ESP-IDF's common CAs). Who's
here: a live every 2 s; another den not heard for 6 s shows as quiet in the band at the foot of the
screen. The inbox (`main/den.c`) is the one place that checks who may: a pair ask from anyone (signed
by who it says) shows "<name> wants to pair": **tab** is yes (the asker into `authorized_keys`),
**esc** (fn + `` ` ``) no; start, stop and unpair only from a den in `authorized_keys`, and a refusal shows in words.
The log is kept on flash (a FAT file system on the `den` partition,
`partitions.csv`, at `/f/<code>`), so a reset goes on from its last step; a snapshot of the history
is kept at each boot and again once 16 steps have come and none for 5 s, so a boot loads it (each
node's value once) and lands only the steps after.

The network: `sdkconfig.secrets` (git ignores it), two lines, made once by hand:

    CONFIG_CARDPUTER_WIFI_SSID="the network"
    CONFIG_CARDPUTER_WIFI_PASSWORD="its password"

`CMakeLists.txt` stacks it after `sdkconfig.defaults`, so a build fills `sdkconfig` from both (a key
`sdkconfig` has already wins: to change the network, edit `sdkconfig.secrets` and delete the two
`CONFIG_CARDPUTER_WIFI_*` lines from `sdkconfig`, or `./idf.sh menuconfig`, "Cardputer: the den's
network"). Never put them in `sdkconfig.defaults`. No network: no WiFi, the den alone (and the
shell, esc between it and the den's screen). The same menu has the tippet server and the room
(`CONFIG_CARDPUTER_ROOM`: a code, remembered from then on; empty, the one it had).
`sdkconfig.defaults` holds the heap settings (WiFi, mbedtls and lwIP buffers, IRAM, stacks, FAT),
each with a line saying why; `sdkconfig` can be deleted and made again from it.

`./sim.sh` runs the same den on the Mac (curl for the long-poll, its install and log in
`/tmp/cardputer-sim`): `SIM_ROOM=KAYA ./sim.sh`, then type; a line `tab` says yes to a pair ask, `esc` no,
`print` says the den's state; the screen goes to `/tmp/dens/card/sim.png`.

The old path (littlesync rows and presence, `main/room.c`, `main/net.c`, `main/lschannel.c`) is out
of the build; its files are where they were.

From the Mac, over USB: `python type.py /dev/cu.usbmodem* 'a = 3' 'b = 4'` types lines into the
device and prints the tree after each one; `python log.py PORT` resets it and prints its log (use
the python in `~/.espressif/python_env/*/bin`, which has pyserial).

The flash as it was before ermine: `~/esp/cardputer-backup-2026-10-17.bin`. To put it back:
`python -m esptool --chip esp32s3 -p PORT write-flash 0 ~/esp/cardputer-backup-2026-10-17.bin`.
