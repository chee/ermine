// The lock's conformance harness, in C: transport_harness.c's devices (built as its library, with
// transport_harness.h's seams) with a lock that makes its effects visible, on the line protocol
// (conformance/c/harness.h), as playground/together/typescript/lock_harness.ts has it; its header
// lists the requests and answers. The "tag" lock is tag_lock.h's. State lasts for the process.
#include "tag_lock.h"
#include "transport_harness.h"

#include "../../../conformance/c/protocol_harness.h"
#include "../../../ermine/encoding/c/commit_form_harness.h"
#include "../../../ermine/encoding/c/json.h"

#include <stdlib.h>
#include <string.h>

// a device's tag lock, by the device's name
typedef struct {
	char *device;
	tg_lock *tag;
} test_t;

static test_t **tests;
static size_t test_count;

static test_t *test_of(const op_value *r, FILE *out) {
	const char *name = hh_str(r, "device");
	for (size_t i = test_count; name != NULL && i > 0; i--)
		if (strcmp(tests[i - 1]->device, name) == 0) return tests[i - 1];
	hh_error(out, "no tag lock on %s", name ? name : "(none)");
	return NULL;
}

// the lock a device is made with: its request's lock
static const lk_lock *made(const op_value *r) {
	const char *kind = hh_str(r, "lock"), *name = hh_str(r, "name");
	if (kind == NULL) return NULL;
	if (strcmp(kind, "unlocked") == 0) return lk_unlocked();
	if (strcmp(kind, "tag") != 0 || name == NULL) return NULL;
	test_t *t = calloc(1, sizeof *t);
	if (t == NULL) abort();
	t->device = copyString(name);
	t->tag = tg_make();
	tests = realloc(tests, (test_count + 1) * sizeof *tests);
	if (tests == NULL) abort();
	tests[test_count++] = t;
	return &t->tag->lock;
}

// bytes closed for a put or a fragment that says closed: the tag, not in the calls
static uint8_t *closer(const char *device, const char *doc, const uint8_t name[CM_NAME],
	const uint8_t (*parents)[CM_NAME], size_t count, const uint8_t *bytes, size_t length, size_t *out_length) {
	(void)device, (void)doc, (void)name, (void)parents, (void)count;
	uint8_t *out = hh_take(length + 1);
	out[0] = TG_TAG;
	memcpy(out + 1, bytes, length);
	*out_length = length + 1;
	return out;
}

static void set_lock(const op_value *r, FILE *out) {
	test_t *t = test_of(r, out);
	if (t == NULL) return;
	if (!tg_set(t->tag, hh_str(r, "open"))) {
		hh_error(out, "no open mode %s", hh_str(r, "open") ? hh_str(r, "open") : "(none)");
		return;
	}
	fputs("{}", out);
}

// the default document: a fresh id, 00 10 then 2a × 16
static const char DEFAULT_DOC[] = "ermine:00102a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a";

// what the lock was asked since last asked
static void calls(const op_value *r, FILE *out) {
	test_t *t = test_of(r, out);
	if (t == NULL) return;
	tg_lock *l = t->tag;
	fputs("{\"closed\":[", out);
	for (size_t i = 0; i < l->closed_count; i++) {
		tg_call *c = &l->closed[i];
		if (i) fputc(',', out);
		fputc('{', out);
		// the id's UTF-8 (as tag_lock.h holds it), as text
		if (c->doc_length != strlen(DEFAULT_DOC) || memcmp(c->doc, DEFAULT_DOC, c->doc_length) != 0) {
			char *text = malloc(c->doc_length + 1);
			if (text == NULL) abort();
			memcpy(text, c->doc, c->doc_length);
			text[c->doc_length] = 0;
			fputs("\"doc\":", out);
			op_json_string(out, text);
			fputc(',', out);
			free(text);
		}
		fputs("\"name\":", out);
		tph_label(out, c->name, CM_NAME);
		fputs(",\"parents\":[", out);
		for (size_t k = 0; k < c->parent_count; k++) {
			if (k) fputc(',', out);
			tph_label(out, c->parents[k], CM_NAME);
		}
		fputs("]}", out);
	}
	fprintf(out, "],\"opened\":%s}", l->opened ? "true" : "false");
	tg_forget(l);
	l->opened = false;
}

// how often the lock's open was asked since last asked
static void opens(const op_value *r, FILE *out) {
	test_t *t = test_of(r, out);
	if (t == NULL) return;
	fprintf(out, "{\"opens\":%zu}", t->tag->opens);
	t->tag->opens = 0;
}

void hh_start(void) {
	tph_lock = made;
	tph_close = closer;
	tph_start();
}

void hh_finish(void) {
	tph_finish();
	for (size_t i = 0; i < test_count; i++) {
		tg_free(tests[i]->tag);
		free(tests[i]->device);
		free(tests[i]);
	}
	free(tests);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op != NULL && strcmp(op, "lock") == 0) set_lock(r, out);
	else if (op != NULL && strcmp(op, "calls") == 0) calls(r, out);
	else if (op != NULL && strcmp(op, "opens") == 0) opens(r, out);
	else tph_answer(r, out);
}
