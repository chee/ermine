# ermine's C, built from where it lives in the repo: the process api and what it stands on
# (the Makefile's api_src without the harnesses)
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
	INCLUDE_DIRS ${R}
)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error -w)
