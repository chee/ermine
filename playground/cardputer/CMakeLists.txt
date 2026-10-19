# ermine on the M5Stack Cardputer ADV (ESP32-S3). ./flash.sh builds and flashes it.
cmake_minimum_required(VERSION 3.16)
# littlesync from the main checkout (/Users/chee/soft/chee/ermine), not this worktree's: the main one
# has the HTTP sessions (http.c) WiFi needs, and presence; this worktree's is older
set(EXTRA_COMPONENT_DIRS ${CMAKE_CURRENT_LIST_DIR}/../../../ermine/extensions/together/stacks/littlesync)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(ermine-cardputer)
