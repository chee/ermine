// Commits over Subduction (transport.h), in C: the device. It is the mailroom (mailroom.c: documents, their
// histories, taking in, own takes) and the Subduction stack (subduction.c: the network, the store,
// fragments, topics) composed, as createDevice composes mailroom.ts and subduction.ts. Each function here
// is the mailroom's or the stack's, under the device's name.
#include "transport.h"

#include <stdlib.h>
#include <string.h>

struct tp_device {
	mr_mailroom *mailroom;
	sb_stack *stack;
};

const char *tp_layer_name(tp_layer layer) {
	return mr_layer_name(layer);
}

const char *tp_code_name(tp_code code) {
	return mr_code_name(code);
}

bool tp_doc(const char *doc, uint8_t bytes[32]) {
	return mr_id(doc, bytes);
}

tp_device *tp_create(const tp_options *o) {
	tp_device *t = calloc(1, sizeof *t);
	if (t == NULL) abort();
	mr_options k = {.check = o->check, .context = o->context, .merges = o->merges,
		.limits = {o->limits.pending, o->limits.refused, o->limits.waiting}};
	memcpy(k.seed, o->seed, 32);
	t->mailroom = mr_create(&k);
	sb_options s = {.store = o->store, .service = o->service, .join = o->join, .now = o->now, .clock = o->clock,
		.snapshot = o->snapshot, .context = o->context, .joins = o->limits.joins, .parts = o->limits.parts,
		.lazy = o->lazy, .lock = o->lock};
	memcpy(s.seed, o->seed, 32);
	t->stack = sb_create(&s, t->mailroom);
	if (t->stack == NULL) {
		mr_free(t->mailroom);
		free(t);
		return NULL;
	}
	return t;
}

void tp_free(tp_device *t) {
	if (t == NULL) return;
	sb_free(t->stack);
	mr_free(t->mailroom);
	free(t);
}

const uint8_t *tp_key(const tp_device *t) {
	return mr_key(t->mailroom);
}

int64_t tp_run(tp_device *t) {
	return sb_run(t->stack);
}

bool tp_idle(const tp_device *t) {
	return sb_idle(t->stack) && mr_idle(t->mailroom);
}

bool tp_ready(const tp_device *t) {
	return sb_ready(t->stack);
}

size_t tp_fetching(const tp_device *t) {
	return sb_fetching(t->stack);
}

uint64_t tp_connect(tp_device *t, const char *service) {
	return sb_connect(t->stack, service);
}

void tp_received(tp_device *t, uint64_t conn, const uint8_t *bytes, size_t length) {
	sb_received(t->stack, conn, bytes, length);
}

void tp_closed(tp_device *t, uint64_t conn) {
	sb_closed(t->stack, conn);
}

bool tp_connected(const tp_device *t, uint64_t conn, uint8_t key[SL_KEY]) {
	return sb_connected(t->stack, conn, key);
}

void tp_disconnect(tp_device *t, const uint8_t key[SL_KEY]) {
	sb_disconnect(t->stack, key);
}

void tp_service(const char *url, char *out, size_t size) {
	sb_service(url, out, size);
}

bool tp_next(tp_device *t, tp_out *out) {
	return sb_next(t->stack, out);
}

void tp_out_free(tp_out *out) {
	sb_out_free(out);
}

bool tp_follow(tp_device *t, const char *id) {
	return sb_follow(t->stack, id);
}

hy_history *tp_history(tp_device *t, const char *id, tp_layer layer) {
	return mr_history(t->mailroom, id, layer);
}

hy_added tp_take(tp_device *t, const char *id, const uint8_t *bytes, size_t length, tp_layer layer, const hy_made *made) {
	return mr_take(t->mailroom, id, bytes, length, layer, made);
}

void tp_arrived(tp_device *t, tp_arrived_fn fn, void *context) {
	mr_arrived(t->mailroom, fn, context);
}

void tp_moved(tp_device *t, tp_moved_fn fn, void *context) {
	mr_moved(t->mailroom, fn, context);
}

void tp_hearing(tp_device *t, tp_hearing_fn fn, void *context) {
	mr_hearing(t->mailroom, fn, context);
}

void tp_stop(tp_device *t, const char *id, const char *table) {
	mr_stop(t->mailroom, id, table);
}

void tp_stopped(tp_device *t, tp_stopped_fn fn, void *context) {
	mr_stopped(t->mailroom, fn, context);
}

bool tp_again(tp_device *t, const char *id, const uint8_t name[CM_NAME]) {
	return mr_again(t->mailroom, id, name);
}

bool tp_forget(tp_device *t, const char *id, const uint8_t name[CM_NAME]) {
	return mr_forget(t->mailroom, id, name);
}

bool tp_snapshot(tp_device *t, const char *id, const uint8_t name[CM_NAME], rp_tables *out) {
	return mr_snapshot(t->mailroom, id, name, out);
}

size_t tp_stored(tp_device *t, const char *id, uint8_t (**out)[32]) {
	return sb_stored(t->stack, id, out);
}

size_t tp_fragments(tp_device *t, const char *id, const fragment ***out) {
	return sb_fragments(t->stack, id, out);
}

void tp_send(tp_device *t, const char *topic, const uint8_t *bytes, size_t length) {
	sb_send(t->stack, topic, bytes, length);
}

tp_listener *tp_listen(tp_device *t, const char *topic, tp_heard_fn fn, void *context) {
	return sb_listen(t->stack, topic, fn, context);
}

void tp_unlisten(tp_device *t, tp_listener *l) {
	sb_unlisten(t->stack, l);
}

void tp_changed(tp_device *t) {
	sb_changed(t->stack);
	mr_changed(t->mailroom);
}

// what is held back or refused: the mailroom's, and the stack's fragments refused whole and commits
// waiting on the lock
tp_taking tp_taking_of(tp_device *t, const char *id, tp_layer layer) {
	mr_doc *d = mr_named(t->mailroom, id);
	if (d == NULL) return (tp_taking){0};
	mr_taking taking = mr_taking_of(d, layer, sb_broken(t->stack, d), sb_locked(t->stack, d));
	if (layer == TP_STORED) sb_taking(t->stack, d, &taking);
	return taking;
}

void tp_taking_free(tp_taking *taking) {
	mr_taking_free(taking);
}

// the harnesses' hooks (transport_conformance_hook.h), only in their builds
#ifdef CONFORMANCE_HOOK
#include "transport_conformance_hook.c"
#endif
