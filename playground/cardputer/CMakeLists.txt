# ermine on the M5Stack Cardputer ADV (ESP32-S3). ./flash.sh builds and flashes it.
# littlesync (playground/together/stacks/littlesync, EXTRA_COMPONENT_DIRS) is out of the build: the
# den speaks tippet now (main/den.c), and its old path (net.c, lschannel.c, room.c) stays as files
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(ermine-cardputer)
