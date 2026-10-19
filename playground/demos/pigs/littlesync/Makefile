# playground/demos/pigs/littlesync: littlesync-pigs, lab-pig's pigs on a littlesync device
# (extensions/together/stacks/littlesync), the Mac peer (peer.c says how to use it). pigs.h, lab-pig's
# format, is also the Cardputer's (playground/cardputer/main). Quiet by default: V=1 shows each command.
#   make            build/littlesync-pigs (BUILD=DIR: there instead; CURL= without https)
#   make clean
CC ?= cc
R = ../../../..
L = $(R)/extensions/together/stacks/littlesync
Q = $(if $(V),,@)
CFLAGS = -std=c11 -O2 -g -Wall -Wextra -Wpedantic -Wno-unused-parameter
B3 = -DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0
BUILD = build

# littlesync, with a file store and HTTP over sockets, and what it stands on (its Makefile has the same lists)
littlesync = $(L)/littlesync.c $(L)/frame.c $(L)/store_file.c $(L)/http.c $(L)/http_posix.c
under = $(R)/core/op/c/value.c $(R)/ermine/encoding/c/json.c $(R)/ermine/encoding/c/cbor.c $(R)/ermine/encoding/c/pack.c \
	$(R)/ermine/encoding/c/commit.c $(R)/ermine/encoding/c/blake3/blake3.c $(R)/ermine/encoding/c/blake3/blake3_dispatch.c \
	$(R)/ermine/encoding/c/blake3/blake3_portable.c $(R)/extensions/together/c/ed25519/ed25519.c $(R)/extensions/together/c/ed25519/sha2.c \
	$(R)/core/op/c/json.c $(R)/core/node/c/node.c $(R)/core/op/c/apply.c $(R)/core/op/c/invert.c
ours = peer.c pigs.c
# https (http_posix.c through libcurl): macOS ships it; elsewhere when pkg-config finds it. CURL= turns it off
CURL ?= $(shell if [ "$$(uname)" = Darwin ] || pkg-config --exists libcurl 2>/dev/null; then echo 1; fi)
curl_flags = $(if $(CURL),-DLS_HTTP_CURL)
curl_libs = $(if $(CURL),-lcurl)

all: $(BUILD)/littlesync-pigs

$(BUILD):
	$(Q)mkdir -p $(BUILD)

$(BUILD)/littlesync-pigs: $(ours) pigs.h $(littlesync) $(under) $(L)/littlesync.h $(L)/frame.h $(L)/http.h | $(BUILD)
	$(Q)echo cc $@
	$(Q)$(CC) $(CFLAGS) $(B3) $(curl_flags) -o $@ $(ours) $(littlesync) $(under) -lm -lpthread $(curl_libs)

clean:
	$(Q)rm -rf $(BUILD)

.PHONY: all clean
