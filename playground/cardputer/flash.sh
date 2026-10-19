#!/bin/sh
# builds the firmware and flashes the Cardputer ADV on USB, then shows its serial output.
# PORT: the board's serial port (default: the first /dev/cu.usbmodem*). ctrl-] leaves the monitor.
set -e
cd "$(dirname "$0")"
PORT=${PORT:-$(ls /dev/cu.usbmodem* | head -1)}
./idf.sh -p "$PORT" build flash monitor
