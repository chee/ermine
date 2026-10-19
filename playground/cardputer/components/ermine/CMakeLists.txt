# ermine's C, built from where it lives in the repo: the process api and what it stands on
# (the Makefile's api_src without the harnesses), and dens with away (its dens_src)
set(R ${CMAKE_CURRENT_LIST_DIR}/../../../..)
# cbor.c and pack.c from the main checkout, as littlesync is (../../CMakeLists.txt): its littlesync
# writes CBOR by pieces (cborPutHead, pk_put), which this worktree's lack. main's are this one's and
# more, so the rest builds against them unchanged
set(MAIN ${CMAKE_CURRENT_LIST_DIR}/../../../../../ermine)
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
		${MAIN}/ermine/encoding/c/pack.c ${R}/ermine/encoding/c/json.c ${MAIN}/ermine/encoding/c/cbor.c
		${R}/extensions/presence/c/presence.c ${R}/extensions/presence/c/channel.c
		${R}/extensions/patch-nodes/c/patch.c
		${R}/core/unread/c/unread.c
		${R}/ermine/processes/c/start.c ${R}/ermine/boxes/c/boxes.c ${R}/extensions/build/c/host.c
		${R}/ermine/encoding/c/hash.c ${R}/ermine/encoding/c/blake3/blake3.c
		${R}/ermine/encoding/c/blake3/blake3_dispatch.c ${R}/ermine/encoding/c/blake3/blake3_portable.c
		${R}/ermine/dens/c/dens.c ${R}/ermine/dens/c/away.c
	INCLUDE_DIRS ${R}
)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error -w)
# blake3 portable only (the Makefile's BLAKE3FLAGS)
target_compile_definitions(${COMPONENT_LIB} PRIVATE BLAKE3_NO_SSE2 BLAKE3_NO_SSE41 BLAKE3_NO_AVX2 BLAKE3_NO_AVX512 BLAKE3_USE_NEON=0)
