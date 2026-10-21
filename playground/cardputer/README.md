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

littlesync over WiFi too (`main/net.c`): `./idf.sh menuconfig`, "Cardputer: littlesync over WiFi":
the network, its password, and a gateway: `https://galaxy.observer` (deployed), or
`http://host:port` (`playground/together/stacks/littlesync/gateway`, `make run` there). https checks
the server against ESP-IDF's common CAs (`sdkconfig.defaults`). Kept in `sdkconfig`, which git
ignores: never put them in `sdkconfig.defaults`. Empty: the USB line only, and no WiFi code in the
image (0.41 MB; with WiFi 1.09 MB, https 18 KB more (the common CAs), and 50 KB more static RAM). The USB line
keeps working beside it; a line typed there prints the WiFi's state with the rest.

From the Mac, over USB: `python type.py /dev/cu.usbmodem* 'a = 3' 'b = 4'` types lines into the
device and prints the tree after each one; `python log.py PORT` resets it and prints its log (use
the python in `~/.espressif/python_env/*/bin`, which has pyserial).

The flash as it was before ermine: `~/esp/cardputer-backup-2026-10-17.bin`. To put it back:
`python -m esptool --chip esp32s3 -p PORT write-flash 0 ~/esp/cardputer-backup-2026-10-17.bin`.
