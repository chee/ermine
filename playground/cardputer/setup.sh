#!/bin/sh
# installs ESP-IDF (the C toolchain for the ESP32-S3) into ~/esp, once. ~2 GB.
# its python is a uv 3.12 (ESP-IDF's pinned packages lag the newest python), linked at ~/esp/python
set -e
IDF_VERSION=${IDF_VERSION:-v6.0.3}
IDF_PATH=${IDF_PATH:-$HOME/esp/esp-idf}

if [ ! -d "$IDF_PATH" ]; then
	mkdir -p "$(dirname "$IDF_PATH")"
	git clone -q --depth 1 --branch "$IDF_VERSION" --recurse-submodules --shallow-submodules \
		https://github.com/espressif/esp-idf.git "$IDF_PATH"
fi

python=$(uv python find 3.12 2>/dev/null || (uv python install 3.12 >/dev/null && uv python find 3.12))
mkdir -p "$HOME/esp/python"
ln -sf "$python" "$HOME/esp/python/python3"
ln -sf "$python" "$HOME/esp/python/python"
PATH="$HOME/esp/python:$PATH" "$IDF_PATH/install.sh" esp32s3
echo "ok: ESP-IDF $IDF_VERSION at $IDF_PATH"
