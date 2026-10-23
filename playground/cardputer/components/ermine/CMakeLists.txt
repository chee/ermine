# ermine's C, built from where it lives in the repo: the process api and what it stands on
# (the Makefile's api_src without the harnesses), software (experiments/software/c),
# tippet (experiments/tippet/c), and trust, installs and sessions
set(R ${CMAKE_CURRENT_LIST_DIR}/../../../..)
set(TIPPET ${R}/experiments/tippet/c)
idf_component_register(
	SRCS
		${R}/core/op/c/value.c ${R}/core/op/c/json.c ${R}/core/op/c/apply.c ${R}/core/op/c/invert.c
		${R}/core/table/c/table.c
		${R}/core/node/c/node.c ${R}/core/node/c/update.c
		${R}/core/scheduler/c/scheduler.c ${R}/core/scheduler/c/order.c ${R}/core/scheduler/c/rank.c
		${R}/core/scheduler/c/causes.c ${R}/core/scheduler/c/ptrmap.c ${R}/core/scheduler/c/tracker.c
		${R}/core/scheduler/c/paths.c ${R}/core/scheduler/c/selector.c
		${R}/filesystem/places/c/places.c ${R}/filesystem/places/c/cache.c ${R}/filesystem/places/c/status.c
		${R}/core/unread/c/unread.c
		${R}/ermine/processes/c/runs.c ${R}/filesystem/places/c/guard.c
		${R}/filesystem/protect/c/protect.c
		${R}/filesystem/clingy/c/clingy.c
		${R}/ermine/processes/c/processes.c ${R}/ermine/processes/c/scopes.c
		${R}/ermine/sites/c/sites.c
		${R}/ermine/api/c/api.c
		${R}/playground/encoding/c/pack.c ${R}/ermine/encoding/c/json.c ${R}/ermine/encoding/c/cbor.c
		${R}/extensions/patch-nodes/c/patch.c
		${R}/ermine/processes/c/start.c ${R}/ermine/boxes/c/boxes.c ${R}/experiments/software/c/functions.c
		${R}/playground/encoding/c/hash.c ${R}/ermine/encoding/c/blake3/blake3.c
		${R}/ermine/encoding/c/blake3/blake3_dispatch.c ${R}/ermine/encoding/c/blake3/blake3_portable.c
		${R}/ermine/ids/c/ids.c
		${R}/ermine/types/c/types.c ${R}/ermine/types/c/utis.c
		${R}/experiments/software/c/common.c ${R}/experiments/software/c/offers.c
		${R}/experiments/software/c/run.c ${R}/experiments/software/c/software.c
		${R}/core/ed25519/c/ed25519.c ${R}/core/ed25519/c/sha2.c
		${TIPPET}/wire.c ${TIPPET}/step.c ${TIPPET}/pack.c ${TIPPET}/sign.c ${TIPPET}/log.c ${TIPPET}/store.c
		${TIPPET}/store_file.c ${TIPPET}/sync.c ${TIPPET}/http.c ${TIPPET}/history.c
		${R}/playground/trust/c/trust.c ${R}/playground/installs/c/installs.c ${R}/playground/sessions/c/sessions.c
	INCLUDE_DIRS ${R}
	REQUIRES fatfs
)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error -w)
# blake3 portable only (the Makefile's BLAKE3FLAGS)
target_compile_definitions(${COMPONENT_LIB} PRIVATE BLAKE3_NO_SSE2 BLAKE3_NO_SSE41 BLAKE3_NO_AVX2 BLAKE3_NO_AVX512 BLAKE3_USE_NEON=0)
# ESP-IDF's sys/uio.h names struct iovec but never defines it: store_file.c gets iovec.h first (and
# its writev from main/flash.c)
set_source_files_properties(${TIPPET}/store_file.c PROPERTIES COMPILE_OPTIONS "-include;${CMAKE_CURRENT_LIST_DIR}/iovec.h")
