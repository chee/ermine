#!/bin/sh
# idf.py with ESP-IDF's environment, on the python setup.sh installed it with: ./idf.sh build
set -e
cd "$(dirname "$0")"
PATH="$HOME/esp/python:$PATH"
. "${IDF_PATH:-$HOME/esp/esp-idf}/export.sh" >/dev/null
idf.py "$@"
