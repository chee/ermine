# newcore/c/subduction: Subduction for C, as a static library with a C ABI (subduction.h):
# no_std with alloc, sans-IO (NOTES.md). Only C is compiled here; the library comes
#   - from the release newcore-subduction-c, built by .github/workflows/newcore-subduction.yml:
#     `make fetch` puts it in lib/, with link.txt, what else it must be linked with;
#   - or from a local build: `make crate` (cargo; slow) puts it in target/release/.
# lib/ wins when both are there.
#
#   make fetch      download lib/ for this machine (gh, signed in to chee/ermine)
#   make            smoke, linked against the library, and run
#   make crate      build the library here instead, and its link.txt
#   make test       conformance/: the Rust's checks (cargo) and the C's, against the library
#   make clean

CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -O2

# the targets the workflow builds for
UNAME := $(shell uname -sm)
ifeq ($(UNAME),Darwin arm64)
TARGET = aarch64-apple-darwin
else ifeq ($(UNAME),Linux x86_64)
TARGET = x86_64-unknown-linux-gnu
else ifeq ($(UNAME),Linux aarch64)
TARGET = aarch64-unknown-linux-gnu
endif

# link.txt with any terminal colour codes cargo left in it taken out
linked = $(shell tr -d '\033' < $(1) 2>/dev/null | sed 's/\[[0-9;]*m//g')
ifneq ($(wildcard lib/libsubduction_c.a),)
LIBRARY = lib/libsubduction_c.a
LINK = $(call linked,lib/link.txt)
else ifneq ($(wildcard target/release/libsubduction_c.a),)
LIBRARY = target/release/libsubduction_c.a
LINK = $(call linked,target/release/link.txt)
endif

smoke: smoke.c store_memory.c platform_posix.c subduction.h store.h platform.h $(LIBRARY)
ifeq ($(LIBRARY),)
	@echo "no libsubduction_c.a: run 'make fetch' (once the workflow newcore-subduction has published it for $(or $(TARGET),this machine)), or 'make crate' to build it here" >&2; exit 1
else
	@if [ "$(LIBRARY)" = lib/libsubduction_c.a ] && ! cmp -s lib/subduction.h subduction.h; then \
		echo "warning: lib/ was built from another subduction.h than this one: make fetch again once the workflow has run" >&2; fi
	$(CC) $(CFLAGS) -o $@ smoke.c store_memory.c platform_posix.c $(LIBRARY) $(LINK)
	./smoke
endif

# conformance/: src/store.rs against Subduction's storage conformance and src/memory.rs over a
# word-aligned malloc (cargo, std); then the C: a port's erm_host_abort that returns must not
# compile, NULL lists are refused, store_files.c syncs its folders, the portable C allocates only
# through platform.h
test: smoke
	cd conformance && cargo test -q
	@if $(CC) $(CFLAGS) -Werror -I. -c conformance/abort_returns.c -o /dev/null 2>/dev/null; then \
		echo "abort_returns: an erm_host_abort that returns compiles" >&2; exit 1; else echo "abort_returns: refused"; fi
	@mkdir -p build
	$(CC) $(CFLAGS) -I. -o build/null_lists conformance/null_lists.c store_memory.c platform_posix.c $(LIBRARY) $(LINK)
	build/null_lists
	$(CC) $(CFLAGS) -I. -o build/files_sync conformance/files_sync.c platform_posix.c
	build/files_sync
	cd conformance && CC=$(CC) ./allocates.sh

fetch:
	@test -n "$(TARGET)" || { echo "no pack is built for $(UNAME): make crate" >&2; exit 1; }
	@mkdir -p build
	gh release download newcore-subduction-c --repo chee/ermine --pattern "subduction-c-$(TARGET).tar.gz" --dir build --clobber
	rm -rf lib && mkdir -p lib
	tar -xmzf build/subduction-c-$(TARGET).tar.gz -C lib --strip-components=1
	@echo "lib/: built from $$(cat lib/commit.txt); link with: $$(tr -d '\033' < lib/link.txt | sed 's/\[[0-9;]*m//g')"

# as the workflow builds it: the note naming the native static libraries is printed only when the crate itself is compiled
crate:
	@mkdir -p target/release
	cargo rustc --release --color never --lib -- --print native-static-libs 2> target/build.log || { cat target/build.log; exit 1; }
	sed -n 's/.*native-static-libs: //p' target/build.log | tail -1 > target/release/link.txt
	@echo "link with: $$(cat target/release/link.txt)"

clean:
	rm -rf build smoke

.PHONY: test fetch crate clean
