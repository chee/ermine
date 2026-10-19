# ermine on the M5Stack Cardputer ADV (ESP32-S3). ./flash.sh builds and flashes it.
cmake_minimum_required(VERSION 3.16)
set(EXTRA_COMPONENT_DIRS ../../extensions/together/stacks/littlesync)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(ermine-cardputer)
