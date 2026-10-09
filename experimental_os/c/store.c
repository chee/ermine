// store.c: the SD card (store.h). The file is one CBOR value, in core's
// deterministic form, so cborDecode reads it back:
//
//   {"last": t, "nodes": [{"id", "slots": [{"ids", "name", "change"?}], "value", "change"?}]}
//
// a change being its header, {"site"?, "time", "agent", "cause"?, "process"?}.
// Values are shared and never freed (json.h), so a save does not build the
// whole as one value: it writes the containers' heads itself, keys in
// core's order (shorter first, then bytewise), and each value through
// cborEncode, where it is.

#include "store.h"

#include "../../core/graph/c/cbor.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct Out {
	unsigned char *bytes;
	size_t length, capacity;
	const char *why;
} Out;

static void room(Out *out, size_t more) {
	if (out->length + more <= out->capacity) return;
	size_t want = out->capacity ? out->capacity : 4096;
	while (want < out->length + more) want *= 2;
	out->bytes = realloc(out->bytes, want);
	out->capacity = want;
}

/** a CBOR head: major type and argument, in the shortest form */
static void head(Out *out, int major, uint64_t n) {
	room(out, 9);
	unsigned char *b = out->bytes + out->length;
	unsigned char m = (unsigned char)(major << 5);
	if (n < 24) {
		b[0] = m | (unsigned char)n;
		out->length += 1;
	} else if (n < 0x100) {
		b[0] = m | 24, b[1] = (unsigned char)n;
		out->length += 2;
	} else if (n < 0x10000) {
		b[0] = m | 25, b[1] = (unsigned char)(n >> 8), b[2] = (unsigned char)n;
		out->length += 3;
	} else if (n < 0x100000000ull) {
		b[0] = m | 26;
		for (int i = 0; i < 4; i++) b[1 + i] = (unsigned char)(n >> (24 - 8 * i));
		out->length += 5;
	} else {
		b[0] = m | 27;
		for (int i = 0; i < 8; i++) b[1 + i] = (unsigned char)(n >> (56 - 8 * i));
		out->length += 9;
	}
}

/** a key: plain ASCII text */
static void key(Out *out, const char *k) {
	size_t n = strlen(k);
	head(out, 3, n);
	room(out, n);
	memcpy(out->bytes + out->length, k, n);
	out->length += n;
}

/** a value as core's codec writes it, where it is */
static void value(Out *out, const Json *v) {
	if (out->why) return;
	size_t n = 0;
	if (!cborEncode(v, NULL, 0, &n, &out->why)) return;
	room(out, n);
	if (!cborEncode(v, out->bytes + out->length, n, &n, &out->why)) return;
	out->length += n;
}

/** a string or a number made for writing, and let go */
static void text(Out *out, const char *s) {
	Json *j = jsonString(s);
	value(out, j);
	jsonFree(j);
}
static void number(Out *out, double d) {
	Json *j = jsonNumber(d);
	value(out, j);
	jsonFree(j);
}

/** a change's header: site, time, agent, cause, process, as present */
static void header(Out *out, const ErmChange *c) {
	head(out, 5, (uint64_t)(2 + !!c->site + !!c->cause + !!c->process));
	if (c->site) key(out, "site"), value(out, c->site);
	key(out, "time"), number(out, c->time);
	key(out, "agent"), value(out, c->agent);
	if (c->cause) key(out, "cause"), value(out, c->cause);
	if (c->process) key(out, "process"), text(out, c->process);
}

bool storeSave(const char *folder, ErmInterface graph, const char **why) {
	ErmSaved *saved = ermGraphSave(graph);
	Out out = { 0 };
	head(&out, 5, 2);
	key(&out, "last"), number(&out, saved->last);
	key(&out, "nodes");
	head(&out, 4, (uint64_t)saved->nodes.count);
	for (int i = 0; i < saved->nodes.count; i++) {
		const ErmSavedNode *node = &saved->nodes.items[i];
		head(&out, 5, (uint64_t)(3 + !!node->change));
		key(&out, "id"), text(&out, node->id);
		key(&out, "slots");
		head(&out, 4, (uint64_t)node->slots.count);
		for (int s = 0; s < node->slots.count; s++) {
			const ErmSavedSlot *slot = &node->slots.items[s];
			head(&out, 5, (uint64_t)(2 + !!slot->change));
			key(&out, "ids");
			head(&out, 4, (uint64_t)slot->ids.count);
			for (int k = 0; k < slot->ids.count; k++) text(&out, slot->ids.items[k]);
			key(&out, "name"), text(&out, slot->name);
			if (slot->change) key(&out, "change"), header(&out, slot->change);
		}
		key(&out, "value"), value(&out, node->value);
		if (node->change) key(&out, "change"), header(&out, node->change);
	}
	// what ermGraphSave made: its lists, not the values they share
	for (int i = 0; i < saved->nodes.count; i++) {
		for (int s = 0; s < saved->nodes.items[i].slots.count; s++) free(saved->nodes.items[i].slots.items[s].ids.items);
		free(saved->nodes.items[i].slots.items);
	}
	free(saved->nodes.items);
	free(saved);
	if (out.why) {
		*why = out.why;
		free(out.bytes);
		return false;
	}
	mkdir(folder, 0755);
	char *path = formatString("%s/graph.cbor", folder), *fresh = formatString("%s/graph.cbor.new", folder);
	bool ok = false;
	int fd = open(fresh, O_WRONLY | O_CREAT | O_TRUNC, 0644);
	if (fd < 0) *why = "the card's file could not be made";
	else {
		size_t at = 0;
		while (at < out.length) {
			ssize_t n = write(fd, out.bytes + at, out.length - at);
			if (n < 0 && errno == EINTR) continue;
			if (n <= 0) break;
			at += (size_t)n;
		}
		ok = at == out.length && fsync(fd) == 0;
		close(fd);
		if (!ok) *why = "the card could not be written";
		else if (rename(fresh, path) != 0) ok = false, *why = "the card's file could not be put in place";
	}
	free(path);
	free(fresh);
	free(out.bytes);
	return ok;
}

/** a header as a change: the header alone, for an item to carry */
static const ErmChange *changeOf(const Json *h, const char *node) {
	if (!jsonIsObject(h)) return NULL;
	ErmChange *c = allocate(sizeof *c);
	*c = (ErmChange){ .node = node, .kind = ERM_WRITE };
	const Json *time = jsonGet(h, "time");
	c->time = jsonIsNumber(time) ? time->number : 0;
	c->agent = jsonGet(h, "agent");
	if (!c->agent) c->agent = jsonNull();
	const char *process = jsonText(jsonGet(h, "process"));
	c->process = process ? copyString(process) : NULL;
	c->site = jsonGet(h, "site");
	c->cause = jsonGet(h, "cause");
	return c;
}

ErmSaved *storeLoad(const char *folder, const char **why) {
	*why = NULL;
	char *path = formatString("%s/graph.cbor", folder);
	FILE *f = fopen(path, "rb");
	free(path);
	if (!f) return NULL;
	unsigned char *bytes = NULL;
	size_t length = 0, capacity = 0, n;
	do {
		if (length == capacity) bytes = realloc(bytes, capacity = capacity ? capacity * 2 : 1 << 16);
		n = fread(bytes + length, 1, capacity - length, f);
		length += n;
	} while (n > 0);
	fclose(f);
	Json *top = cborDecode(bytes, length, why, NULL);
	free(bytes);
	if (!top) return NULL;
	const Json *nodes = jsonGet(top, "nodes"), *last = jsonGet(top, "last");
	if (!jsonIsArray(nodes) || !jsonIsNumber(last)) {
		*why = "not a card this OS wrote";
		return NULL;
	}
	ErmSaved *saved = allocate(sizeof *saved);
	saved->last = last->number;
	for (int i = 0; i < nodes->array.count; i++) {
		const Json *n = nodes->array.items[i];
		const char *id = jsonText(jsonGet(n, "id"));
		const Json *slots = jsonGet(n, "slots");
		if (!id || !jsonIsArray(slots)) continue;
		ErmSavedNode node = { copyString(id), jsonGet(n, "value"), changeOf(jsonGet(n, "change"), id), { 0 } };
		if (!node.value) node.value = jsonNull();
		for (int s = 0; s < slots->array.count; s++) {
			const Json *sl = slots->array.items[s];
			const char *name = jsonText(jsonGet(sl, "name"));
			const Json *ids = jsonGet(sl, "ids");
			if (!name || !jsonIsArray(ids)) continue;
			ErmSavedSlot slot = { copyString(name), { 0 }, changeOf(jsonGet(sl, "change"), node.id) };
			for (int k = 0; k < ids->array.count; k++) {
				const char *member = jsonText(ids->array.items[k]);
				if (member) ERM_PUSH(slot.ids, copyString(member));
			}
			ERM_PUSH(node.slots, slot);
		}
		ERM_PUSH(saved->nodes, node);
	}
	return saved;
}
