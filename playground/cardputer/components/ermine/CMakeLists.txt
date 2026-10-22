# ermine's C, built from where it lives in the repo: the process api and what it stands on
# (the Makefile's api_src without the harnesses), and dens with away (its dens_src)
set(R ${CMAKE_CURRENT_LIST_DIR}/../../../..)
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
		${R}/playground/together/presence/c/presence.c ${R}/playground/together/presence/c/channel.c
		${R}/extensions/patch-nodes/c/patch.c
		${R}/ermine/processes/c/start.c ${R}/ermine/boxes/c/boxes.c ${R}/experiments/software/c/functions.c
		${R}/playground/encoding/c/hash.c ${R}/ermine/encoding/c/blake3/blake3.c
		${R}/ermine/encoding/c/blake3/blake3_dispatch.c ${R}/ermine/encoding/c/blake3/blake3_portable.c
		${R}/playground/dens/c/common.c ${R}/playground/dens/c/policy.c ${R}/playground/dens/c/offers.c
		${R}/playground/dens/c/start.c ${R}/playground/dens/c/handlers.c ${R}/playground/dens/c/here.c
		${R}/playground/dens/c/dens.c ${R}/playground/dens/c/away.c
	INCLUDE_DIRS ${R}
)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error -w)
# blake3 portable only (the Makefile's BLAKE3FLAGS)
target_compile_definitions(${COMPONENT_LIB} PRIVATE BLAKE3_NO_SSE2 BLAKE3_NO_SSE41 BLAKE3_NO_AVX2 BLAKE3_NO_AVX512 BLAKE3_USE_NEON=0)
