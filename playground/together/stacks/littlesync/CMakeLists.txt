# littlesync as an ESP-IDF component: add it to the Cardputer project with
#   set(EXTRA_COMPONENT_DIRS ../../playground/together/stacks/littlesync)        (CMakeLists.txt of playground/cardputer)
# and REQUIRES littlesync in main. It compiles its own files, and from where they live in the repo what
# the ermine component (playground/cardputer/components/ermine) does not already: commit.c, BLAKE3
# (portable only) and Ed25519. Everything else it uses (value, json, cbor, pack) is the ermine
# component's, which it REQUIRES. Needs an NVS partition (the default partition table has one) and
# nvs_flash_init() before ls_store_nvs.
set(R ${CMAKE_CURRENT_LIST_DIR}/../../../..)
idf_component_register(
	SRCS
		littlesync.c frame.c store_nvs.c http.c
		${R}/playground/encoding/c/commit.c
		${R}/ermine/encoding/c/blake3/blake3.c ${R}/ermine/encoding/c/blake3/blake3_dispatch.c
		${R}/ermine/encoding/c/blake3/blake3_portable.c
		${R}/core/ed25519/c/ed25519.c ${R}/core/ed25519/c/sha2.c
	INCLUDE_DIRS .
	REQUIRES ermine nvs_flash
)
target_compile_definitions(${COMPONENT_LIB} PRIVATE
	BLAKE3_NO_SSE2 BLAKE3_NO_SSE41 BLAKE3_NO_AVX2 BLAKE3_NO_AVX512 BLAKE3_USE_NEON=0)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error -w)
