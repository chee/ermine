// The Subduction stack (subduction.h), in C: commits over Subduction, laid out as subduction.ts is. It
// is what carries the mailroom's commits (mailroom.h): the network, a store and a clock. Documents' trees and
// fragments, taking in what the store saved, building, ephemeral messages and their parts, sending
// what the mailroom queued, and Subduction. It talks to the mailroom through the functions in mailroom.h alone.
//
// subduction.ts's two promise chains are two queues here: jobs (its run: taking in what the store
// saved, building, what was heard, in the order asked, one at a time) and the mailroom's own takes (its
// outgoing: this device's own takes, sealed and stored or published, in the order made), which sb_run
// pulls one at a time. A job or a take that waits on Subduction (an addCommit, an addFragment, a
// publish) holds its queue until the call is answered, as an await there does. sb_run runs both, and
// Subduction, until nothing more can go on
#include "subduction.h"

#include "../../../c/packer.h"
#include "../../../c/snapshot.h"

#include "../../../../../ermine/encoding/c/cbor.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../../../ermine/encoding/c/cbor.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Subduction drops an ephemeral payload over LIMIT; one over it is sent as parts of at most PART
#define LIMIT 65536
#define PART 60000

// a followed document still empty is asked for again after each of these, in ms
static const uint64_t backoff[] = {250, 500, 1000, 2000, 4000, 8000, 16000};
#define BACKOFF (sizeof backoff / sizeof *backoff)


static int by_id(const void *a, const void *b) {
	return memcmp(a, b, 32);
}

static int by_name(const void *a, const void *b) {
	return memcmp(a, b, CM_NAME);
}

static size_t depth(const uint8_t id[32]) {
	return fragment_depth(id);
}

// ---- documents

// what the stack keeps of a document: its fragments, and what is its alone
typedef struct {
	mr_doc *d;
	sb_stack *t;
	// by head (fragment *)
	im_map fragments;
	// fragments refused whole, by head (mr_refusal: the code, and the text a lock refused with)
	im_map broken;
	mr_order_t broken_order;
	// how many taken-in seals have a depth, so a build with none is passed over
	size_t deep;
	// what waits on the lock, by head: loose commits, and fragments (locked_t); each at most the
	// pending limit, the oldest let go of past it (stored still: it comes in again as the device starts)
	im_map locked, locked_fragments;
	mr_order_t locked_order, locked_fragments_order;
	bool followed, follow_later;
	// lazy: its tree taken in from the store (or queued to be)
	bool loaded;
	// asked for again at due, the ask'th time
	bool asking;
	size_t ask;
	uint64_t due;
	// its tree id (sb_tree), made from its id
	uint8_t tree[32];
} sb_doc;

#define SBD(d) ((sb_doc *)(d)->stack)
#define TREE(d) (SBD(d)->tree)

// what the lock could not open yet, as it arrived: held to be opened again (sb_changed). list: a
// loose commit's parents, a fragment's boundary (32 bytes each); checks: a fragment's checkpoints, 12
// bytes each; queued: sb_changed has queued it to be opened again (once, however often it is told)
typedef struct {
	uint8_t *list, *checks, *blob;
	size_t count, checks_count, length;
	bool queued;
} locked_t;

static void locked_free(void *x) {
	locked_t *l = x;
	if (l == NULL) return;
	free(l->list);
	free(l->checks);
	free(l->blob);
	free(l);
}

// ---- the queues

typedef struct job job;

typedef enum {
	J_LOAD,     // what the store holds, taken in
	J_LOADED,   // the end of it
	J_TAKE,     // a record the store held when starting: commit or fragment, nothing more
	J_SAVE,     // a record Subduction saved (or a conformance hook put gave): taken in, then compacted and built
	J_HEAR,     // an ephemeral commit heard
	J_GATHER,   // a part of an ephemeral payload
	J_COMPACT,  // the loose commits a fragment covers let go of
	J_BUILD,    // the fragments not built yet
	J_SUBSCRIBE, // a channel's topic subscribed
	J_LOAD_DOC, // lazy: a followed document's tree, taken in from the store
	J_FOLLOW,   // lazy: the document followed (subscribed, fetched) once its tree is in
	J_STOP      // a stop heard: its table in bytes
} job_kind;

struct job {
	job_kind kind;
	mr_doc *d;
	// J_TAKE, J_SAVE: the record's kind and tree, its bytes (or given: its head, parents or boundary,
	// checkpoints (12 bytes each) and blob as the hook put had them)
	int record;
	uint8_t tree[32];
	bool given;
	// J_TAKE: what sb_changed queued, taken only while it is held still, as queued
	bool again;
	uint8_t *checks;
	size_t checks_count;
	uint8_t head[32];
	// parents, boundary; J_BUILD's heads (none: every head). J_COMPACT: the fragment's head
	uint8_t (*list)[32];
	size_t count;
	bool all;
	// the record, the blob, the payload, the part's bytes
	uint8_t *bytes;
	size_t length;
	// J_HEAR, J_GATHER: the sender; J_GATHER, J_SUBSCRIBE: the topic (topic set: a channel's)
	uint8_t from[32], topic[32];
	bool channel;
	uint8_t whole[32];
	size_t part, parts;
	// a build, as it goes: the fragments made, the one being added
	fragment **fresh;
	size_t fresh_count, at;
	bool started, waiting, done;
	// the take at the front waits for it to be done
	bool waiter;
	job *next;
};

// the mailroom's first own take, as the stack goes with it: a stored one sealed and stored, an ephemeral
// one or a stop published. 0: not started; 1: waiting on its call; 2: waiting on its build; 3: done
typedef struct {
	int state;
	uint8_t stored[32];
	job *build;
} cur_t;

typedef enum { C_STORE, C_PUBLISH, C_FRAGMENT, C_SUBSCRIBE, C_FETCH, C_PUT, C_PUT_FRAGMENT } call_kind;

typedef enum { F_FOLLOW, F_CONNECT, F_ASK } fetch_kind;
// a document synced with every peer, twice: what was added while the first was out is in neither its
// answer nor a push
typedef struct {
	mr_doc *d;
	fetch_kind kind;
	int round;
	size_t ask;
} fetch_t;

// a conformance hook's put, until Subduction answers: saw, whether its save came
typedef struct {
	mr_doc *d;
	uint8_t head[32];
	uint8_t (*list)[32];
	size_t count;
	uint8_t *blob;
	size_t length;
	// a fragment's checkpoints, 12 bytes each
	uint8_t *checks;
	size_t checks_count;
	bool saw;
} put_t;

typedef struct {
	uint64_t call;
	call_kind kind;
	void *what;
} call_t;

typedef struct {
	uint64_t id;
	bool up, fresh;
	uint8_t key[32];
} conn_t;

struct sb_listener {
	sb_heard_fn fn;
	void *context;
	bool gone;
	sb_listener *next;
};

// a channel's topic: who is told
typedef struct {
	sb_listener *first;
} channel_t;

// the parts of one ephemeral payload from one sender, by where (a document or a channel's topic)
typedef struct join {
	uint8_t where[32], from[32], whole[32];
	bool channel;
	size_t parts;
	struct {
		size_t index;
		uint8_t *bytes;
		size_t length;
	} *got;
	size_t got_count, got_room;
	uint64_t at;
	struct join *next;
} join_t;


struct sb_stack {
	mr_mailroom *mailroom;
	ErmStore inner, store;
	ErmSd *sd;
	char *service;
	uint64_t join;
	sb_clock_fn now;
	void *clock;
	sb_snapshot_fn snapshot;
	void *context;
	size_t joins, parts;
	const lk_lock *lock;

	mr_doc **followed;
	size_t followed_count, followed_room;

	job *jobs, *jobs_last, *cursor;
	cur_t cur;

	sb_out *outs;
	size_t out_count, out_next, out_room;
	call_t *calls;
	size_t call_count, call_room;
	conn_t *conns;
	size_t conn_count, conn_room;

	// every topic subscribed to, again on each connection made after
	im_map wanted;
	uint8_t (*wanted_order)[32];
	size_t wanted_count, wanted_room;
	// channels' topics (channel_t)
	im_map channels;
	join_t *joins_list;

	size_t fetching, putting;
	// this device's own loose commit being added (one at a time): its stored id and closed bytes, which
	// pass the door unopened (an own commit is never opened); NULL: none
	uint8_t own_stored[32];
	uint8_t *own;
	size_t own_length;
	bool loaded;
	// lazy; and the trees the store held at the start, each taken in then if its id was named (and not
	// lazy), else when its document is followed
	bool lazy;
	im_map trees;
	// the documents by their tree ids (mr_doc *): which id made this tree id. None for a tree until its
	// document is named (a hash can't be turned back into an id): what comes for it is unnamed
	im_map docs;
	// sb_stored's call, and its answer
	uint64_t want;
	bool answered;
	uint8_t (*found)[32];
	size_t found_count;
};

// the stack's slot of a document, made as the mailroom makes the document; the stack's fragments go with it
static void made(void *context, mr_doc *d) {
	sb_doc *s = calloc(1, sizeof *s);
	if (s == NULL) abort();
	s->d = d;
	s->t = context;
	d->stack = s;
	sb_tree(d->id, d->length, s->tree);
	im_set(&s->t->docs, s->tree, d);
}

// the document filed under a tree id, or NULL
static mr_doc *document(const sb_stack *t, const uint8_t tree[32]) {
	return im_get(&t->docs, tree);
}

bool sb_tree(const char *id, size_t length, uint8_t tree[32]) {
	if (!sl_id((const uint8_t *)id, length)) return false;
	static const char DOMAIN[] = "ermine/v1/tree";
	uint8_t *all = malloc(2 * 10 + sizeof DOMAIN + length);
	if (all == NULL) abort();
	size_t at = 0;
	const struct {
		const void *bytes;
		size_t length;
	} pieces[2] = {{DOMAIN, sizeof DOMAIN - 1}, {id, length}};
	for (int k = 0; k < 2; k++) {
		size_t v = pieces[k].length;
		do all[at++] = (uint8_t)((v & 0x7f) | (v >= 0x80 ? 0x80 : 0)), v >>= 7;
		while (v > 0);
		memcpy(all + at, pieces[k].bytes, pieces[k].length);
		at += pieces[k].length;
	}
	uint8_t digest[32];
	cm_digest(all, at, digest);
	free(all);
	memcpy(tree, digest, 16);
	memset(tree + 16, 0, 16);
	return true;
}

// a seal taken in at the document: a depth makes it worth building. a loose commit of it waiting on
// the lock waits no more (it got in another way: a fragment's member)
static void handed(void *context, mr_doc *d, const uint8_t stored[32]) {
	(void)context;
	if (depth(stored) > 0) SBD(d)->deep++;
	locked_free(im_del(&SBD(d)->locked, stored));
}

static uint64_t now_of(const sb_stack *t) {
	return t->now ? t->now(t->clock) : erm_host_now();
}


// ---- calls Subduction answers later

static void call(sb_stack *t, uint64_t number, call_kind kind, void *what) {
	ROOM(t->calls, t->call_count, t->call_room);
	t->calls[t->call_count++] = (call_t){number, kind, what};
}

// ---- jobs

static job *job_new(job_kind kind, mr_doc *d) {
	job *j = calloc(1, sizeof *j);
	if (j == NULL) abort();
	j->kind = kind;
	j->d = d;
	return j;
}

// the fragments a build made are the document's: only the list of them is the job's
static void job_free(job *j) {
	free(j->list);
	free(j->checks);
	free(j->bytes);
	free(j->fresh);
	free(j);
}

// at the end of the queue
static void later(sb_stack *t, job *j) {
	j->next = NULL;
	if (t->jobs_last) t->jobs_last->next = j;
	else t->jobs = j;
	t->jobs_last = j;
}

// next: after the job running (and what it put next before), else first
static void next(sb_stack *t, job *j) {
	if (t->cursor == NULL) {
		j->next = t->jobs;
		t->jobs = j;
		if (t->jobs_last == NULL) t->jobs_last = j;
		return;
	}
	j->next = t->cursor->next;
	t->cursor->next = j;
	if (t->jobs_last == t->cursor) t->jobs_last = j;
	t->cursor = j;
}

static job *build_job(mr_doc *d, const uint8_t (*heads)[32], size_t count) {
	job *j = job_new(J_BUILD, d);
	j->all = heads == NULL;
	if (heads != NULL) {
		j->list = mr_copy(heads, count * 32);
		j->count = count;
	}
	return j;
}

// ---- envelopes (subduction.ts's): what is stored and sent of a node, before the lock closes it

// why an envelope for another id is refused, beside MR_ID
#define OTHER "the envelope is for another id"
// an envelope for another id, as contents and vetted give it: noted MR_ID with OTHER (MR_ID itself
// there: a member sealed for another id, noted with SL_ELSEWHERE)
#define ENVELOPE ((mr_code)(MR_ID + 1))
// a fragment that fails the door's closure (names): passed over, noted MR_BOUNDARY
#define CLOSURE ((mr_code)(MR_ID + 2))

// an envelope's bytes: the id and what it carries (carries, taken), canonical CBOR, malloc'd
static uint8_t *wrap(const mr_doc *d, Json *carries, size_t *length) {
	jsonAdd(carries, "id", jsonStringOfLength(d->id, d->length));
	size_t n = 0;
	cborEncode(carries, NULL, 0, &n, NULL);
	uint8_t *bytes = malloc(n + 1);
	if (bytes == NULL) abort();
	cborEncode(carries, bytes, n, &n, NULL);
	jsonFree(carries);
	*length = n;
	return bytes;
}

// an envelope opened: its map (jsonFree it) when it is a map with a text id, else NULL (shape); *other:
// its id is not the document's. The caller checks its form (shape) before its id (MR_ID), as
// subduction.ts's opens does
static Json *unwrap(const mr_doc *d, const uint8_t *open, size_t length, bool *other) {
	*other = false;
	Json *x = cborDecode(open, length, NULL, NULL);
	const Json *id = x != NULL && x->type == JSON_OBJECT ? jsonGet(x, "id") : NULL;
	if (id == NULL || id->type != JSON_STRING) return jsonFree(x), NULL;
	*other = id->stringLength != d->length || memcmp(id->string, d->id, d->length) != 0;
	return x;
}

// ---- taking in

static mr_code code_of(sl_code code) {
	return code == SL_SIGNATURE ? MR_SIGNATURE : code == SL_ID ? MR_ID : MR_SHAPE;
}

// the lock's open of what landed: GOOD, its bytes in *open (lk_opened_free it); WAIT, it cannot yet;
// REFUSED. PASSED (opening's): it fails the door, not the commit named
typedef enum { OPEN_GOOD, OPEN_WAIT, OPEN_REFUSED, OPEN_PASSED } open_t;

// what the door makes of a save (subduction.ts's Door): stored; passed over (not stored, no error);
// refused (the save fails)
typedef enum { DOOR_STORE, DOOR_PASS, DOOR_REFUSE } door_t;

// a seal's commit's name, the stored id the id in it gives it (own), and the one the id given gives it
// (mine, when id is not NULL); false: not a seal's shape, or an id that is not one
static bool peek_seal(const uint8_t *sealed, size_t length, const uint8_t *id, size_t id_length,
	uint8_t name[CM_NAME], uint8_t own[32], uint8_t mine[32]) {
	Json *x = cborDecode(sealed, length, NULL, NULL);
	const Json *i = x != NULL && x->type == JSON_OBJECT ? jsonGet(x, "id") : NULL;
	const Json *c = x != NULL && x->type == JSON_OBJECT ? jsonGet(x, "commit") : NULL;
	bool ok = i != NULL && i->type == JSON_STRING && c != NULL && c->type == JSON_BYTES;
	if (ok) {
		cm_name(c->bytes.data, c->bytes.length, name);
		ok = sl_stored_id((const uint8_t *)i->string, i->stringLength, name, own) &&
			(id == NULL || sl_stored_id(id, id_length, name, mine));
	}
	jsonFree(x);
	return ok;
}

static open_t unlock(mr_doc *d, const uint8_t *blob, size_t length, lk_opened *open, const char **why) {
	const lk_lock *lock = SBD(d)->t->lock;
	*open = lock->open(lock->context, (const uint8_t *)d->id, d->length, blob, length);
	if (open->kind == LK_OPEN) return OPEN_GOOD;
	lk_kind kind = open->kind;
	*why = open->refused;
	lk_opened_free(open);
	return kind == LK_WAIT ? OPEN_WAIT : OPEN_REFUSED;
}

// a loose commit's not taken, noted at its head when note says so
static open_t no(mr_doc *d, const uint8_t head[32], bool note, open_t to, mr_code code, const uint8_t *name,
	const char *why) {
	if (note) mr_refuse(d, head, code, name, why), mr_settle(d);
	return to;
}

// a loose commit's steps, the lock, the door (the envelope's id, the seal's, its stored id), then the
// seal: the seal in *sealed (malloc'd), its commit in *it (GOOD, then both are the caller's); WAIT: the
// lock cannot open it yet; PASSED: it fails the door; REFUSED: not good. Noted (note): either, at the head
static open_t opening(mr_doc *d, const uint8_t head[32], const uint8_t *blob, size_t length, bool note,
	uint8_t **sealed, size_t *sealed_length, sl_unsealed *it) {
	const char *why = NULL;
	lk_opened open;
	open_t got = unlock(d, blob, length, &open, &why);
	if (got == OPEN_WAIT) return OPEN_WAIT;
	if (got == OPEN_REFUSED) return no(d, head, note, OPEN_REFUSED, MR_LOCK, NULL, why);
	bool other;
	Json *x = unwrap(d, open.bytes, open.length, &other);
	lk_opened_free(&open);
	const Json *s = x != NULL ? jsonGet(x, "sealed") : NULL;
	if (x == NULL || x->object.count != 2 || s == NULL || s->type != JSON_BYTES) {
		jsonFree(x);
		return no(d, head, note, OPEN_REFUSED, MR_SHAPE, NULL, NULL);
	}
	if (other) return jsonFree(x), no(d, head, note, OPEN_PASSED, MR_ID, NULL, OTHER);
	uint8_t name[CM_NAME], own[32], mine[32];
	if (peek_seal(s->bytes.data, s->bytes.length, (const uint8_t *)d->id, d->length, name, own, mine)) {
		if (memcmp(own, mine, 32) != 0) return jsonFree(x), no(d, head, note, OPEN_PASSED, MR_ID, NULL, SL_ELSEWHERE);
		if (memcmp(mine, head, 32) != 0) return jsonFree(x), no(d, head, note, OPEN_PASSED, MR_STORED_ID, name, NULL);
	}
	sl_code code = sl_unseal(s->bytes.data, s->bytes.length, (const uint8_t *)d->id, d->length, it, NULL);
	if (code != SL_OK) {
		jsonFree(x);
		if (note) mr_refuse(d, head, code_of(code), NULL, code == SL_ID ? it->reason : NULL);
		return OPEN_REFUSED;
	}
	*sealed = mr_copy(s->bytes.data, s->bytes.length);
	*sealed_length = s->bytes.length;
	jsonFree(x);
	return OPEN_GOOD;
}

// what waits on the lock held, to be opened again (sb_changed): the commit as it arrived; past the
// pending limit, the oldest let go of
static void hold(mr_doc *d, im_map *map, mr_order_t *order, const uint8_t head[32], const uint8_t *list, size_t count,
	const uint8_t *checks, size_t checks_count, const uint8_t *blob, size_t length) {
	uint8_t k[32];
	memcpy(k, head, 32);
	locked_free(im_del(map, k));
	locked_t *l = calloc(1, sizeof *l);
	if (l == NULL) abort();
	l->list = mr_copy(list, count * 32);
	l->count = count;
	l->checks = mr_copy(checks, checks_count * 12);
	l->checks_count = checks_count;
	l->blob = mr_copy(blob, length);
	l->length = length;
	mr_note(map, order, k, l, mr_limits_of(d->mailroom)->pending, locked_free);
}

// the steps of a loose commit, in order: the lock, the seal, its stored id, then pending
static void take_commit(mr_doc *d, const uint8_t head[32], const uint8_t (*parents)[32], size_t count, const uint8_t *blob,
	size_t length) {
	if (im_has(&d->seen, head)) return;
	locked_free(im_del(&SBD(d)->locked, head));
	sl_unsealed u;
	uint8_t *sealed;
	size_t sealed_length;
	open_t got = opening(d, head, blob, length, true, &sealed, &sealed_length, &u);
	if (got == OPEN_REFUSED || got == OPEN_PASSED) return;
	if (got == OPEN_WAIT) {
		mr_refusal_del(&d->refused, head);
		hold(d, &SBD(d)->locked, &SBD(d)->locked_order, head, (const uint8_t *)parents, count, NULL, 0, blob, length);
		return;
	}
	mr_refusal_del(&d->refused, head);
	mr_pending_t *p = calloc(1, sizeof *p);
	if (p == NULL) abort();
	memcpy(p->key, head, 32);
	p->commit = true;
	mr_sealed_of(&p->it, &u);
	p->sealed = sealed;
	p->sealed_length = sealed_length;
	p->given = mr_copy(parents, count * 32);
	p->given_length = count;
	qsort(p->given, count, 32, by_id);
	mr_pend(d, p);
	mr_settle(d);
}

// what Subduction may store of a loose commit in a followed document (its admission, subduction.ts's
// allows): STORE, one that passes the door and opens to a good seal, or waits on the lock; PASS, one
// that fails the door (stored, it would stand under the name of a commit it isn't), or any not good
// under a name held already (that one is here); REFUSE: the commit named, not good. What is passed
// over or refused is noted, as taking it in notes it (a name held: not noted). A refusal fails the
// save, which drops the peer's connection
static door_t allows(mr_doc *d, const uint8_t head[32], const uint8_t *blob, size_t length) {
	const sb_stack *t = SBD(d)->t;
	if (t->own != NULL && memcmp(t->own_stored, head, 32) == 0 && t->own_length == length &&
		memcmp(t->own, blob, length) == 0)
		return DOOR_STORE;
	bool here = im_has(&d->seen, head);
	sl_unsealed u;
	uint8_t *sealed;
	size_t sealed_length;
	open_t got = opening(d, head, blob, length, !here, &sealed, &sealed_length, &u);
	if (got == OPEN_GOOD) sl_free(&u), free(sealed);
	if (got == OPEN_GOOD || got == OPEN_WAIT) return DOOR_STORE;
	return here || got == OPEN_PASSED ? DOOR_PASS : DOOR_REFUSE;
}

// a fragment's envelope opened: {id, run: its members as a pack (packer.h), snapshot?: packed
// tables}, or {id, members: [sealed...], snapshot?} as it was first written. Each member unsealed as it is read, in
// order: the first that is not good ends it, and the fragment is refused whole with its code (a pack
// that is not one, or comes to too much: shape). The snapshot dropped when it does not read back
typedef struct {
	mr_member_t *members;
	size_t count, room;
	uint8_t *snapshot;
	size_t snapshot_length;
	// while reading: the first member refused
	mr_code code;
} contents_t;

static void contents_free(contents_t *c) {
	for (size_t i = 0; i < c->count; i++) {
		free(c->members[i].sealed);
		mr_sealed_free(&c->members[i].it);
	}
	free(c->members);
	free(c->snapshot);
	*c = (contents_t){0};
}

// what a reading keeps: the contents, the document its seals are for, and the members vouched for
// by one not read yet
typedef struct {
	contents_t *c;
	const mr_doc *d;
	mr_member_t *vouched;
	size_t vouched_count, vouched_room;
} reading_t;

// a member kept
static mr_member_t *push_member(contents_t *c) {
	ROOM(c->members, c->count, c->room);
	mr_member_t *m = &c->members[c->count++];
	*m = (mr_member_t){0};
	return m;
}

// one member read: a seal unsealed and kept, with the ones it vouches for before it; one vouched for,
// held until then. The first that is not good ends the reading
static bool read_member(void *context, const pkr_member *r) {
	reading_t *g = context;
	contents_t *c = g->c;
	if (r->sealed == NULL) {
		cm_commit commit;
		if (cm_decode(r->commit, r->commit_length, &commit, NULL) != CM_OK) return c->code = MR_SHAPE, false;
		ROOM(g->vouched, g->vouched_count, g->vouched_room);
		mr_member_t *m = &g->vouched[g->vouched_count++];
		*m = (mr_member_t){0};
		memcpy(m->it.name, r->name, CM_NAME);
		memcpy(m->it.stored, r->stored, 32);
		m->it.bytes = mr_copy(r->commit, r->commit_length);
		m->it.length = r->commit_length;
		m->it.lamport = commit.lamport;
		m->it.parents_length = commit.parents_length;
		m->it.parents = mr_copy(commit.parents, commit.parents_length * CM_NAME);
		cm_free(&commit);
		return true;
	}
	sl_unsealed u;
	sl_code code = sl_unseal(r->sealed, r->sealed_length, (const uint8_t *)g->d->id, g->d->length, &u, NULL);
	if (code != SL_OK) {
		c->code = code_of(code);
		return false;
	}
	for (size_t i = 0; i < g->vouched_count; i++) *push_member(c) = g->vouched[i];
	g->vouched_count = 0;
	mr_member_t *m = push_member(c);
	m->sealed = mr_copy(r->sealed, r->sealed_length);
	m->length = r->sealed_length;
	mr_sealed_of(&m->it, &u);
	return true;
}

// a {members} list's one seal read
static bool read_seal(reading_t *g, const uint8_t *sealed, size_t length) {
	pkr_member r = {.sealed = sealed, .sealed_length = length};
	return read_member(g, &r);
}

// the door's reading of a fragment's members, no signature checked (subduction.ts's names): each
// one's stored id the one the id gives its commit's name (a seal for another id: MR_ID; one a pack
// claims for a commit it vouches for: MR_STORED_ID), and the head, when given, one of them. closing (a
// head given): each one's stored id and its parents' names kept, for the closure
typedef struct {
	const uint8_t *id;
	size_t length;
	const uint8_t *head;
	bool has, closing, undecoded;
	mr_code code;
	im_map ids;
	uint8_t (*parents)[CM_NAME];
	size_t count, room;
} naming_t;

static bool name_member(void *context, const pkr_member *r) {
	naming_t *n = context;
	uint8_t mine[32];
	if (!sl_stored_id(n->id, n->length, r->name, mine)) return n->code = MR_SHAPE, false;
	if (memcmp(mine, r->stored, 32) != 0) return n->code = r->sealed != NULL ? MR_ID : MR_STORED_ID, false;
	if (n->head != NULL && memcmp(r->stored, n->head, 32) == 0) n->has = true;
	if (!n->closing) return true;
	im_set(&n->ids, r->stored, SET);
	cm_commit commit;
	if (r->commit == NULL || cm_decode(r->commit, r->commit_length, &commit, NULL) != CM_OK) {
		n->undecoded = true;
		return true;
	}
	for (size_t i = 0; i < commit.parents_length; i++) {
		ROOM(n->parents, n->count, n->room);
		memcpy(n->parents[n->count++], commit.parents[i], CM_NAME);
	}
	cm_free(&commit);
	return true;
}

// the door's check of a fragment's closure (subduction.ts's closure): each member's parent a member, or
// one of the head's depth or more and in the boundary (the walk stops there); one of less depth not a
// member was taken out as a member of a fragment below (Subduction's build does so), so only with a
// boundary. None such: the boundary is those parents, no more. A commit that does not decode is the
// seals' check's. 0, or CLOSURE
static mr_code closure(const naming_t *n, const uint8_t (*boundary)[32], size_t count) {
	if (n->undecoded) return 0;
	size_t top = depth(n->head);
	im_map given = {0}, reached = {0};
	for (size_t i = 0; i < count; i++) im_set(&given, boundary[i], SET);
	bool below = false, ok = true;
	for (size_t i = 0; i < n->count && ok; i++) {
		uint8_t s[32];
		if (!sl_stored_id(n->id, n->length, n->parents[i], s) || im_has(&n->ids, s)) continue;
		if (depth(s) < top) below = true;
		else if (im_has(&given, s)) im_set(&reached, s, SET);
		else ok = false;
	}
	if (ok) ok = below ? given.count > 0 : reached.count == given.count;
	im_free(&given), im_free(&reached);
	return ok ? 0 : CLOSURE;
}

// a seal's commit, as bytes in *x (jsonFree it), or NULL
static const Json *seal_commit(const uint8_t *sealed, size_t length, Json **x) {
	*x = cborDecode(sealed, length, NULL, NULL);
	const Json *c = *x != NULL && (*x)->type == JSON_OBJECT ? jsonGet(*x, "commit") : NULL;
	return c != NULL && c->type == JSON_BYTES ? c : NULL;
}

// names' reading of the members, into n
static mr_code named(naming_t *n, const Json *packed, const Json *members) {
	if (packed != NULL) {
		if (packed->type != JSON_BYTES) return MR_SHAPE;
		pkr_code c = pkr_each(packed->bytes.data, packed->bytes.length, name_member, n, NULL);
		if (c == PKR_STOPPED) return n->code;
		if (c != PKR_OK) return MR_SHAPE;
	} else {
		if (members->type != JSON_ARRAY) return MR_SHAPE;
		for (int i = 0; i < members->array.count; i++) {
			const Json *m = members->array.items[i];
			pkr_member r = {0};
			uint8_t mine[32];
			if (m->type != JSON_BYTES || !peek_seal(m->bytes.data, m->bytes.length, NULL, 0, r.name, r.stored, mine))
				return MR_SHAPE;
			r.sealed = m->bytes.data, r.sealed_length = m->bytes.length;
			Json *x = NULL;
			const Json *c = n->closing ? seal_commit(r.sealed, r.sealed_length, &x) : NULL;
			if (c != NULL) r.commit = c->bytes.data, r.commit_length = c->bytes.length;
			bool on = name_member(n, &r);
			jsonFree(x);
			if (!on) return n->code;
		}
	}
	return n->head != NULL && !n->has ? MR_STORED_ID : 0;
}

// 0, or the code, of a pack (packed) or a list of seals (members); a pack that is not one, or a
// member that is no seal: MR_SHAPE. With the head, the closure too, against the boundary
static mr_code names(const uint8_t *id, size_t length, const Json *packed, const Json *members, const uint8_t *head,
	const uint8_t (*boundary)[32], size_t count) {
	naming_t n = {.id = id, .length = length, .head = head, .closing = head != NULL};
	mr_code code = named(&n, packed, members);
	if (code == 0 && n.closing) code = closure(&n, boundary, count);
	im_free(&n.ids);
	free(n.parents);
	return code;
}

// 0, or the code the fragment is refused with (out is left empty): ENVELOPE, an envelope for another id.
// First the door's checks (names; head, when given, one of them; with the boundary, the closure), then
// each member unsealed
static mr_code contents(const mr_doc *d, const uint8_t *open, size_t length, const uint8_t *head,
	const uint8_t (*boundary)[32], size_t count, contents_t *out) {
	*out = (contents_t){0};
	reading_t g = {out, d, NULL, 0, 0};
	bool other;
	Json *x = unwrap(d, open, length, &other);
	if (x == NULL || x->object.count < 2 || x->object.count > 3) return jsonFree(x), MR_SHAPE;
	// "run": the blob's key, as stored
	const Json *packed = jsonGet(x, "run"), *members = jsonGet(x, "members"), *snapshot = jsonGet(x, "snapshot");
	if ((packed == NULL) == (members == NULL) || (size_t)x->object.count != 2 + (snapshot != NULL)) return jsonFree(x), MR_SHAPE;
	if (other) return jsonFree(x), ENVELOPE;
	mr_code code = names((const uint8_t *)d->id, d->length, packed, members, head, boundary, count);
	if (code != 0) return jsonFree(x), code;
	if (packed != NULL) {
		if (packed->type != JSON_BYTES) code = MR_SHAPE;
		else {
			pkr_code c = pkr_each(packed->bytes.data, packed->bytes.length, read_member, &g, NULL);
			if (c == PKR_STOPPED) code = out->code;
			else if (c != PKR_OK) code = MR_SHAPE;
		}
	} else if (members->type != JSON_ARRAY) code = MR_SHAPE;
	else {
		for (int i = 0; i < members->array.count && code == 0; i++) {
			const Json *m = members->array.items[i];
			if (m->type != JSON_BYTES) code = MR_SHAPE;
			else if (!read_seal(&g, m->bytes.data, m->bytes.length)) code = out->code;
		}
	}
	for (size_t i = 0; i < g.vouched_count; i++) mr_sealed_free(&g.vouched[i].it);
	free(g.vouched);
	if (code == 0 && snapshot != NULL) {
		if (snapshot->type != JSON_BYTES) code = MR_SHAPE;
		else {
			rp_tables tables;
			rp_init(&tables);
			if (sn_tables(snapshot->bytes.data, snapshot->bytes.length, &tables) == PK_OK) {
				out->snapshot = mr_copy(snapshot->bytes.data, snapshot->bytes.length);
				out->snapshot_length = snapshot->bytes.length;
			}
			rp_free(&tables);
		}
	}
	jsonFree(x);
	if (code != 0) contents_free(out);
	return code;
}

static bool lookup(void *context, const uint8_t id[32], const uint8_t (**parents)[32], size_t *count);
static const fragment *known(void *context, const uint8_t head[32]);

// the stored ids of the members reached from the head, along each one's parents (by name) among the
// members, into reached (empty)
static void reach(const uint8_t head[32], const contents_t *c, im_map *reached) {
	const mr_member_t **todo = malloc((c->count + 1) * sizeof *todo);
	if (todo == NULL) abort();
	size_t n = 0;
	for (size_t i = 0; i < c->count; i++)
		if (memcmp(c->members[i].it.stored, head, 32) == 0) todo[n++] = &c->members[i];
	while (n > 0) {
		const mr_member_t *m = todo[--n];
		if (im_has(reached, m->it.stored)) continue;
		im_set(reached, m->it.stored, SET);
		for (size_t p = 0; p < m->it.parents_length; p++) {
			for (size_t i = 0; i < c->count; i++) {
				if (memcmp(c->members[i].it.name, m->it.parents[p], CM_NAME) != 0) continue;
				todo = realloc(todo, (n + 2) * sizeof *todo);
				if (todo == NULL) abort();
				todo[n++] = &c->members[i];
			}
		}
	}
	free(todo);
}

// whether two lists of ids hold the same ids
static bool same_ids(const uint8_t (*a)[32], size_t an, const uint8_t (*b)[32], size_t bn) {
	im_map x = {0}, y = {0};
	for (size_t i = 0; i < an; i++) im_set(&x, a[i], SET);
	for (size_t i = 0; i < bn; i++) im_set(&y, b[i], SET);
	bool same = x.count == y.count;
	for (size_t i = 0; i < an && same; i++) same = im_has(&y, a[i]);
	im_free(&x), im_free(&y);
	return same;
}

// a fragment's contents (into got), checked against what Subduction says of it, as subduction.ts's
// checked: its head one of its members, and its members and boundary closed (the door's, in contents);
// its head of depth 1 or more, every other member of less depth, and reached from the head along parents
// among the members; its boundary of the head's depth or more and none of its members; its checkpoints
// (their first 12 bytes; NULL: none said) each member but the head with a depth. A head here whose walk
// can be made here: its members and boundary that walk's.
// 0, or the code it is refused with (got left empty)
static mr_code vetted(mr_doc *d, const uint8_t head[32], const uint8_t (*boundary)[32], size_t count,
	const uint8_t *checkpoints, size_t checks, const uint8_t *open, size_t length, contents_t *got) {
	mr_code code = contents(d, open, length, head, boundary, count, got);
	if (code != 0) return code;
	size_t top = depth(head);
	im_map ids = {0}, reached = {0};
	for (size_t i = 0; i < got->count; i++) im_set(&ids, got->members[i].it.stored, SET);
	reach(head, got, &reached);
	if (top == 0 || reached.count != ids.count) code = MR_BOUNDARY;
	for (size_t i = 0; i < got->count && code == 0; i++) {
		const uint8_t *id = got->members[i].it.stored;
		if (memcmp(id, head, 32) != 0 && depth(id) >= top) code = MR_BOUNDARY;
	}
	for (size_t i = 0; i < count && code == 0; i++)
		if (depth(boundary[i]) < top || im_has(&ids, boundary[i])) code = MR_BOUNDARY;
	if (code == 0 && checkpoints != NULL) {
		im_map want = {0}, given = {0};
		uint8_t k[32] = {0};
		for (size_t i = 0; i < ids.slots; i++) {
			if (!ids.used[i] || memcmp(im_key(&ids, i), head, 32) == 0 || depth(im_key(&ids, i)) == 0) continue;
			memcpy(k, im_key(&ids, i), 12);
			im_set(&want, k, SET);
		}
		for (size_t i = 0; i < checks; i++) memcpy(k, checkpoints + 12 * i, 12), im_set(&given, k, SET);
		bool same = want.count == given.count;
		for (size_t i = 0; i < want.slots && same; i++) same = !want.used[i] || im_has(&given, im_key(&want, i));
		if (!same) code = MR_BOUNDARY;
		im_free(&want), im_free(&given);
	}
	if (code == 0 && im_has(&d->seen, head)) {
		fragment w = {0};
		if (fragment_walk(head, lookup, known, d, &w) == FRAGMENT_OK) {
			uint8_t(*mine)[32] = malloc(got->count * 32 + 1);
			if (mine == NULL) abort();
			for (size_t i = 0; i < got->count; i++) memcpy(mine[i], got->members[i].it.stored, 32);
			bool same = same_ids((const uint8_t(*)[32])w.members.ids, w.members.count, (const uint8_t(*)[32])mine,
					    got->count) &&
				same_ids((const uint8_t(*)[32])w.boundary.ids, w.boundary.count, boundary, count);
			free(mine);
			if (!same) code = MR_BOUNDARY;
		}
		fragment_free(&w);
	}
	im_free(&ids), im_free(&reached);
	if (code != 0) contents_free(got);
	return code;
}

// a fragment refused whole, by head
static void broke(mr_doc *d, const uint8_t head[32], mr_code code, const char *why) {
	mr_refusal_note(&SBD(d)->broken, &SBD(d)->broken_order, head, code, why, mr_limits_of(d->mailroom)->refused);
}

// a fragment refused whole with what vetted gave: ENVELOPE is MR_ID with OTHER, a member sealed for
// another id MR_ID with SL_ELSEWHERE, CLOSURE MR_BOUNDARY
static void broke_with(mr_doc *d, const uint8_t head[32], mr_code code) {
	if (code == ENVELOPE) broke(d, head, MR_ID, OTHER);
	else if (code == CLOSURE) broke(d, head, MR_BOUNDARY, NULL);
	else broke(d, head, code, code == MR_ID ? SL_ELSEWHERE : NULL);
}

// what Subduction may store of a fragment in a followed document (its admission), as allows: one that
// opens and is checked, or waits on the lock, stored; one that fails the door (an envelope for another
// id, a member's stored id not its own, the head none of them, a member's parent left out or a boundary
// not the members' own) passed over; one not good otherwise refused. One whose head is not here yet is
// noted refused whole
static door_t allows_fragment(mr_doc *d, const uint8_t head[32], const uint8_t (*boundary)[32], size_t count,
	const uint8_t *checkpoints, size_t checks, const uint8_t *blob, size_t length) {
	lk_opened open;
	const char *why = NULL;
	open_t opened = unlock(d, blob, length, &open, &why);
	if (opened == OPEN_WAIT) return DOOR_STORE;
	if (opened == OPEN_REFUSED) {
		if (!im_has(&d->seen, head)) broke(d, head, MR_LOCK, why);
		return DOOR_REFUSE;
	}
	contents_t got;
	mr_code code = vetted(d, head, boundary, count, checkpoints, checks, open.bytes, open.length, &got);
	lk_opened_free(&open);
	if (code == 0) return contents_free(&got), DOOR_STORE;
	if (!im_has(&d->seen, head)) broke_with(d, head, code);
	return code == ENVELOPE || code == MR_ID || code == MR_STORED_ID || code == CLOSURE ? DOOR_PASS : DOOR_REFUSE;
}

// a fragment taken in: its members as its blob has them (sorted, a seal there twice kept twice, as
// subduction.ts keeps the list), its boundary as Subduction gave it
static fragment *fragment_of(const uint8_t head[32], const contents_t *c, const uint8_t (*boundary)[32],
	size_t boundary_count) {
	fragment *f = calloc(1, sizeof *f);
	if (f == NULL) abort();
	memcpy(f->head, head, 32);
	for (size_t i = 0; i < c->count; i++) fragment_push(&f->members, c->members[i].it.stored);
	for (size_t i = 0; i < boundary_count; i++) fragment_push(&f->boundary, boundary[i]);
	if (f->members.count) qsort(f->members.ids, f->members.count, 32, by_id);
	fragment_settle(&f->boundary);
	return f;
}

static void put_fragment(mr_doc *d, fragment *f) {
	fragment *old = im_del(&SBD(d)->fragments, f->head);
	if (old != NULL) fragment_free(old), free(old);
	im_set(&SBD(d)->fragments, f->head, f);
}

// a fragment taken in: its members (each checked) as seals alone, its snapshot a hint. One whose head
// is here already has its members checked too, and is only noted
static void take_fragment(mr_doc *d, const uint8_t head[32], const uint8_t (*boundary)[32], size_t count,
	const uint8_t *checkpoints, size_t checks, const uint8_t *blob, size_t length) {
	const mr_seen_t *here = im_get(&d->seen, head);
	if (here != NULL && im_has(&SBD(d)->fragments, head) && im_has(&d->judged, here->name)) return;
	locked_free(im_del(&SBD(d)->locked_fragments, head));
	lk_opened open;
	const char *why = NULL;
	open_t opened = unlock(d, blob, length, &open, &why);
	if (opened != OPEN_GOOD) {
		// one whose head is here already is noted, with no members; else it waits, or is refused whole
		if (here != NULL) {
			if (!im_has(&SBD(d)->fragments, head)) {
				contents_t none_read = {0};
				put_fragment(d, fragment_of(head, &none_read, boundary, count));
			}
		} else if (opened == OPEN_WAIT)
			hold(d, &SBD(d)->locked_fragments, &SBD(d)->locked_fragments_order, head, (const uint8_t *)boundary, count,
				checkpoints, checks, blob, length);
		else broke(d, head, MR_LOCK, why);
		return;
	}
	contents_t got;
	mr_code code = vetted(d, head, boundary, count, checkpoints, checks, open.bytes, open.length, &got);
	lk_opened_free(&open);
	if (code != 0) {
		if (here == NULL) broke_with(d, head, code);
		return;
	}
	mr_refusal_del(&SBD(d)->broken, head);
	uint8_t top[CM_NAME];
	for (size_t i = 0; i < got.count; i++)
		if (memcmp(got.members[i].it.stored, head, 32) == 0) memcpy(top, got.members[i].it.name, CM_NAME);
	if (!im_has(&SBD(d)->fragments, head)) put_fragment(d, fragment_of(head, &got, boundary, count));
	for (size_t i = 0; i < got.count; i++) mr_member(d, &got.members[i]);
	if (got.snapshot != NULL) mr_hint(d, top, got.snapshot, got.snapshot_length, false);
	contents_free(&got);
	mr_settle(d);
}

// ---- parts of an ephemeral payload over Subduction's limit

typedef enum { NOT_A_PART, NO_PART, A_PART } part_kind;
typedef struct {
	uint8_t whole[32];
	size_t part, parts;
	const uint8_t *bytes;
	size_t length;
	Json *own;
} part_t;

// a payload that is a part: a map of exactly whole, part, parts and bytes. NOT_A_PART: not one (a

// a payload that is a part: a map of exactly whole, part, parts and bytes. NOT_A_PART: not one (a
// commit, or no map); NO_PART: one, but its values are not, or it has more than most parts (dropped)
static part_kind part_of(const uint8_t *payload, size_t length, size_t most, part_t *out) {
	*out = (part_t){0};
	Json *x = cborDecode(payload, length, NULL, NULL);
	if (x == NULL) return NOT_A_PART;
	const Json *whole = jsonGet(x, "whole"), *part = jsonGet(x, "part"), *parts = jsonGet(x, "parts"),
		   *bytes = jsonGet(x, "bytes");
	if (x->type != JSON_OBJECT || x->object.count != 4 || !whole || !part || !parts || !bytes) {
		jsonFree(x);
		return NOT_A_PART;
	}
	int64_t p, n;
	if (whole->type != JSON_BYTES || whole->bytes.length != 32 || bytes->type != JSON_BYTES ||
		bytes->bytes.length > PART || !jsonIsWhole(part, &p) || !jsonIsWhole(parts, &n) || p < 0 || p >= n ||
		(uint64_t)n > most) {
		jsonFree(x);
		return NO_PART;
	}
	memcpy(out->whole, whole->bytes.data, 32);
	out->part = (size_t)p;
	out->parts = (size_t)n;
	out->bytes = bytes->bytes.data;
	out->length = bytes->bytes.length;
	out->own = x;
	return A_PART;
}

// a payload that is a stop (tp_stop): a map of exactly stop, a string: the table, malloc'd. NULL:
// not one
static char *stop_of(const uint8_t *payload, size_t length) {
	Json *x = cborDecode(payload, length, NULL, NULL);
	if (x == NULL) return NULL;
	const Json *stop = jsonGet(x, "stop");
	char *table = NULL;
	if (x->type == JSON_OBJECT && x->object.count == 1 && stop != NULL && stop->type == JSON_STRING)
		table = copyString(jsonText(stop));
	jsonFree(x);
	return table;
}

static void join_free(join_t *j) {
	for (size_t i = 0; i < j->got_count; i++) free(j->got[i].bytes);
	free(j->got);
	free(j);
}

// the parts not joined by the setting's time dropped; all: whatever the time
static void expire(sb_stack *t, bool all) {
	uint64_t now = now_of(t);
	for (join_t **at = &t->joins_list; *at;) {
		join_t *j = *at;
		if (all || now - j->at >= t->join) {
			*at = j->next;
			join_free(j);
		} else at = &j->next;
	}
}

// one part from a sender: kept with its whole's; when all are here, joined, the hash checked: what
// they make (malloc'd), or NULL
static uint8_t *gather(sb_stack *t, const job *p, size_t *length) {
	expire(t, false);
	join_t *j = t->joins_list;
	while (j && !(j->channel == p->channel && memcmp(j->where, p->channel ? p->topic : TREE(p->d), 32) == 0 &&
			     memcmp(j->from, p->from, 32) == 0 && memcmp(j->whole, p->whole, 32) == 0))
		j = j->next;
	if (j == NULL) {
		// past the limit, the oldest let go of: the last in the list
		size_t n = 0;
		for (join_t *k = t->joins_list; k != NULL; k = k->next) n++;
		if (n >= t->joins) {
			join_t **at = &t->joins_list;
			while ((*at)->next != NULL) at = &(*at)->next;
			join_free(*at);
			*at = NULL;
		}
		j = calloc(1, sizeof *j);
		if (j == NULL) abort();
		memcpy(j->where, p->channel ? p->topic : TREE(p->d), 32);
		j->channel = p->channel;
		memcpy(j->from, p->from, 32);
		memcpy(j->whole, p->whole, 32);
		j->parts = p->parts;
		j->at = now_of(t);
		j->next = t->joins_list;
		t->joins_list = j;
	}
	if (j->parts != p->parts) return NULL;
	bool has = false;
	for (size_t i = 0; i < j->got_count && !has; i++) has = j->got[i].index == p->part;
	if (!has) {
		ROOM(j->got, j->got_count, j->got_room);
		j->got[j->got_count].index = p->part;
		j->got[j->got_count].bytes = mr_copy(p->bytes, p->length);
		j->got[j->got_count++].length = p->length;
	}
	if (j->got_count < j->parts) return NULL;
	for (join_t **at = &t->joins_list; *at; at = &(*at)->next) {
		if (*at == j) {
			*at = j->next;
			break;
		}
	}
	size_t total = 0;
	for (size_t i = 0; i < j->got_count; i++) total += j->got[i].length;
	uint8_t *all = malloc(total + 1), hash[32];
	if (all == NULL) abort();
	size_t at = 0;
	for (size_t i = 0; i < j->parts; i++) {
		for (size_t k = 0; k < j->got_count; k++) {
			if (j->got[k].index != i) continue;
			memcpy(all + at, j->got[k].bytes, j->got[k].length);
			at += j->got[k].length;
			break;
		}
	}
	cm_digest(all, total, hash);
	bool good = memcmp(hash, j->whole, 32) == 0;
	join_free(j);
	if (!good) return free(all), NULL;
	*length = total;
	return all;
}

// a payload published on a topic: whole when it is no more than LIMIT (and parts is false), else as
// parts of at most PART. The last call
static uint64_t publish(sb_stack *t, const uint8_t topic[32], const uint8_t *bytes, size_t length, bool parts) {
	if (length <= LIMIT && !parts) return erm_sd_publish(t->sd, topic, bytes, length);
	uint8_t whole[32];
	cm_digest(bytes, length, whole);
	size_t n = (length + PART - 1) / PART;
	if (n == 0) n = 1;
	uint64_t last = 0;
	for (size_t i = 0; i < n; i++) {
		size_t k = length - i * PART < PART ? length - i * PART : PART;
		Json *m = jsonObject();
		jsonAdd(m, "whole", jsonBytes(whole, 32));
		jsonAdd(m, "part", jsonNumber((double)i));
		jsonAdd(m, "parts", jsonNumber((double)n));
		jsonAdd(m, "bytes", jsonBytes(bytes + i * PART, k));
		size_t size = 0;
		cborEncode(m, NULL, 0, &size, NULL);
		uint8_t *out = malloc(size + 1);
		if (out == NULL) abort();
		cborEncode(m, out, size, &size, NULL);
		jsonFree(m);
		last = erm_sd_publish(t->sd, topic, out, size);
		free(out);
	}
	return last;
}

// a channel's topic: BLAKE3 of "ermine/v0/topic" then the topic's CBOR, so never a document's
static channel_t *channel(sb_stack *t, const char *name, uint8_t id[32]) {
	Json *s = jsonString(name);
	size_t n = 0;
	cborEncode(s, NULL, 0, &n, NULL);
	uint8_t *bytes = malloc(15 + n + 1);
	if (bytes == NULL) abort();
	memcpy(bytes, "ermine/v0/topic", 15);
	cborEncode(s, bytes + 15, n, &n, NULL);
	jsonFree(s);
	cm_digest(bytes, 15 + n, id);
	free(bytes);
	channel_t **slot = (channel_t **)im_slot(&t->channels, id);
	if (*slot == NULL) {
		*slot = calloc(1, sizeof **slot);
		if (*slot == NULL) abort();
	}
	return *slot;
}

static void tell_channel(channel_t *c, const uint8_t from[32], const uint8_t *bytes, size_t length) {
	char who[2 * SL_KEY + 1];
	uint8_t key[SL_KEY];
	mr_peer(from, key);
	mr_hex(key, SL_KEY, who);
	for (sb_listener *l = c->first; l; l = l->next)
		if (!l->gone) l->fn(l->context, who, bytes, length);
}

// every ephemeral topic this device has subscribed to: again on each connection made after
static uint64_t subscribe(sb_stack *t, const uint8_t topic[32]) {
	if (im_has(&t->wanted, topic)) return 0;
	im_set(&t->wanted, topic, SET);
	ROOM(t->wanted_order, t->wanted_count, t->wanted_room);
	memcpy(t->wanted_order[t->wanted_count++], topic, 32);
	return erm_sd_subscribe(t->sd, topic);
}

// ---- building

static bool lookup(void *context, const uint8_t id[32], const uint8_t (**parents)[32], size_t *count) {
	const mr_seen_t *s = im_get(&((mr_doc *)context)->seen, id);
	if (s == NULL) return false;
	*parents = (const uint8_t(*)[32])s->ids;
	*count = s->ids_length;
	return true;
}

static const fragment *known(void *context, const uint8_t head[32]) {
	return im_get(&SBD((mr_doc *)context)->fragments, head);
}

static int by_lamport(const void *x, const void *y) {
	const mr_seen_t *a = *(const mr_seen_t *const *)x, *b = *(const mr_seen_t *const *)y;
	if (a->lamport != b->lamport) return a->lamport < b->lamport ? -1 : 1;
	return memcmp(a->name, b->name, CM_NAME);
}

// the fragments not built yet, walked from the job's heads (all: from every head): false when there
// are none
static bool build_start(mr_doc *d, job *j) {
	if (SBD(d)->deep == 0) return false;
	uint8_t(*heads)[32] = j->list;
	size_t count = j->count;
	if (j->all) {
		im_map covered = {0};
		for (size_t i = 0; i < d->order_count; i++)
			for (size_t k = 0; k < d->order[i]->ids_length; k++) im_set(&covered, d->order[i]->ids[k], SET);
		heads = malloc(d->order_count * 32 + 1);
		if (heads == NULL) abort();
		count = 0;
		for (size_t i = 0; i < d->order_count; i++)
			if (!im_has(&covered, d->order[i]->stored)) memcpy(heads[count++], d->order[i]->stored, 32);
		im_free(&covered);
	}
	fragment *made;
	size_t n;
	fragment_build((const uint8_t(*)[32])heads, count, lookup, known, d, &made, &n);
	if (heads != j->list) free(heads);
	j->fresh = malloc((n + 1) * sizeof *j->fresh);
	if (j->fresh == NULL) abort();
	for (size_t i = 0; i < n; i++) {
		fragment *f = malloc(sizeof *f);
		if (f == NULL) abort();
		*f = made[i];
		put_fragment(d, f);
		j->fresh[i] = f;
	}
	free(made);
	j->fresh_count = n;
	j->at = 0;
	return n > 0;
}

// one fresh fragment's blob, {run, snapshot?}: its members' seals in lamport order, and the tables at
// its head, packed, when the integration gives them; added
static uint64_t build_add(sb_stack *t, mr_doc *d, const fragment *f) {
	const mr_seen_t **ms = malloc((f->members.count + 1) * sizeof *ms);
	pkr_item *items = malloc((f->members.count + 1) * sizeof *items);
	if (ms == NULL || items == NULL) abort();
	for (size_t i = 0; i < f->members.count; i++) ms[i] = im_get(&d->seen, f->members.ids[i]);
	qsort(ms, f->members.count, sizeof *ms, by_lamport);
	for (size_t i = 0; i < f->members.count; i++)
		items[i] = ms[i]->sealed != NULL ? (pkr_item){ms[i]->sealed, ms[i]->sealed_length, NULL}
						  : (pkr_item){ms[i]->bytes, ms[i]->length, ms[i]->stored};
	uint8_t *packed = NULL;
	size_t packed_length = 0;
	pkr_pack(items, f->members.count, &packed, &packed_length);
	free(ms);
	free(items);
	Json *blob = jsonObject();
	// "run": the blob's key, as stored; the envelope's id beside it
	jsonAdd(blob, "run", jsonBytes(packed, packed_length));
	free(packed);
	const mr_seen_t *top = im_get(&d->seen, f->head);
	const hy_kept *kept = hy_get(d->histories[MR_STORED], top->name);
	uint8_t *snapshot = NULL;
	size_t snapshot_length = 0;
	if (kept != NULL && t->snapshot != NULL && t->snapshot(t->context, d->id, kept, &snapshot, &snapshot_length)) {
		jsonAdd(blob, "snapshot", jsonBytes(snapshot, snapshot_length));
		mr_hint(d, top->name, snapshot, snapshot_length, true);
		free(snapshot);
	}
	size_t n;
	uint8_t *bytes = wrap(d, blob, &n);
	// closed by the lock: named by the bytes' name (a multihash), its parents the boundary's names, sorted
	uint8_t digest[CM_NAME];
	cm_name(bytes, n, digest);
	uint8_t(*names)[CM_NAME] = malloc(f->boundary.count * CM_NAME + 1);
	if (names == NULL) abort();
	for (size_t i = 0; i < f->boundary.count; i++) {
		const mr_seen_t *b = im_get(&d->seen, f->boundary.ids[i]);
		if (b != NULL) memcpy(names[i], b->name, CM_NAME);
		else memset(names[i], 0, CM_NAME);
	}
	qsort(names, f->boundary.count, CM_NAME, by_name);
	lk_closed closed = t->lock->close(t->lock->context, (const uint8_t *)d->id, d->length, digest, (const uint8_t(*)[CM_NAME])names,
		f->boundary.count, bytes, n);
	free(names);
	if (closed.bytes == NULL) return free(bytes), 0;
	uint64_t c = erm_sd_add_fragment(t->sd, TREE(d), f->head, f->boundary.count ? (const uint8_t *)f->boundary.ids : NULL,
		f->boundary.count, f->checkpoints.count ? (const uint8_t *)f->checkpoints.ids : NULL, f->checkpoints.count,
		closed.bytes, closed.length);
	lk_closed_free(&closed);
	free(bytes);
	return c;
}

// ---- the jobs

// a record from the store: its id, its parents or boundary, its blob. false: it does not decode, or
// its blob is not there
typedef struct {
	ErmSdRecord rec;
	uint8_t *blob;
	size_t length;
} record_t;


static bool record(sb_stack *t, int kind, const uint8_t *bytes, size_t length, record_t *out) {
	*out = (record_t){0};
	if (!erm_sd_decode(kind, bytes, length, &out->rec)) return false;
	if (t->inner.get(t->inner.self, ERM_STORE_BLOB, NULL, out->rec.digest, &out->blob, &out->length) != 1) {
		erm_sd_free_record(&out->rec);
		return false;
	}
	return true;
}

static void record_free(record_t *r) {
	erm_sd_free_record(&r->rec);
	erm_host_free(r->blob);
}

static const uint8_t none[1];


// a fragment stored: the loose commits it stands for let go from storage (sedimentree's minimal
// form). Only the members of the fragment the store holds for that head (Subduction keeps one a
// head), checked, and reached from its head: whatever is let go of comes back from it
static void compact(sb_stack *t, mr_doc *d, const uint8_t head[32]) {
	uint8_t *bytes = NULL;
	size_t length = 0;
	if (t->inner.get(t->inner.self, ERM_STORE_FRAGMENT, TREE(d), head, &bytes, &length) != 1) return;
	record_t r;
	bool ok = record(t, ERM_STORE_FRAGMENT, bytes != NULL ? bytes : none, length, &r);
	erm_host_free(bytes);
	if (!ok) return;
	lk_opened open;
	contents_t got;
	const char *why = NULL;
	if (unlock(d, r.blob != NULL ? r.blob : none, r.length, &open, &why) == OPEN_GOOD) {
		if (contents(d, open.bytes, open.length, NULL, NULL, 0, &got) == 0) {
			im_map reached = {0};
			reach(head, &got, &reached);
			for (size_t i = 0; i < reached.slots; i++)
				if (reached.used[i]) t->inner.remove(t->inner.self, ERM_STORE_COMMIT, TREE(d), im_key(&reached, i));
			im_free(&reached);
			contents_free(&got);
		}
		lk_opened_free(&open);
	}
	record_free(&r);
}

static void take(sb_stack *t, job *j, bool save) {
	const uint8_t *head, *blob, *checks;
	const uint8_t(*list)[32];
	size_t count, length, checks_count;
	record_t r;
	if (j->given) {
		head = j->head, list = (const uint8_t(*)[32])j->list, count = j->count, blob = j->bytes, length = j->length;
		checks = j->checks != NULL ? j->checks : none, checks_count = j->checks_count;
	} else {
		if (!record(t, j->record, j->bytes, j->length, &r)) return;
		head = r.rec.id, list = (const uint8_t(*)[32])r.rec.parents, count = r.rec.parentCount;
		blob = r.blob ? r.blob : none, length = r.length;
		checks = r.rec.checkpoints != NULL ? r.rec.checkpoints : none, checks_count = r.rec.checkpointCount;
	}
	mr_doc *d = document(t, j->tree);
	if (j->again) {
		// passed over unless held still as queued: one taken in or let go of since needs nothing, one
		// held again was opened since (the next changed opens it again)
		const locked_t *l = im_get(j->record == ERM_STORE_COMMIT ? &SBD(d)->locked : &SBD(d)->locked_fragments, head);
		if (l == NULL || !l->queued) return;
	}
	size_t deep = SBD(d)->deep;
	if (j->record == ERM_STORE_COMMIT) take_commit(d, head, list, count, blob, length);
	else take_fragment(d, head, list, count, checks, checks_count, blob, length);
	mr_tell_moved(t->mailroom, d);
	if (save) {
		if (j->record == ERM_STORE_FRAGMENT) {
			const fragment *got = im_get(&SBD(d)->fragments, head);
			if (got != NULL && got->members.count) {
				job *c = job_new(J_COMPACT, d);
				memcpy(c->head, head, 32);
				later(t, c);
			}
		}
		// only a commit taken in that can head a fragment, or a fragment, makes one to build: walking
		// every commit after each would make n commits cost n squared
		if (j->record == ERM_STORE_FRAGMENT || SBD(d)->deep != deep) next(t, build_job(d, NULL, 0));
	}
	if (!j->given) record_free(&r);
}

typedef struct {
	uint8_t (*ids)[32];
	size_t count, room;
} collected_t;


static void collect(void *context, const uint8_t id[32]) {
	collected_t *c = context;
	ROOM(c->ids, c->count, c->room);
	memcpy(c->ids[c->count++], id, 32);
}

// a tree the store holds, taken in: its fragments, then its loose commits, then its fragments built,
// queued next. Read from the store itself, so nothing is saved again
static void load_doc(sb_stack *t, mr_doc *d) {
	SBD(d)->loaded = true;
	for (int k = 0; k < 2; k++) {
		int kind = k == 0 ? ERM_STORE_FRAGMENT : ERM_STORE_COMMIT;
		collected_t ids = {0};
		t->inner.list(t->inner.self, kind, TREE(d), collect, &ids);
		for (size_t n = 0; n < ids.count; n++) {
			uint8_t *bytes = NULL;
			size_t length = 0;
			if (t->inner.get(t->inner.self, kind, TREE(d), ids.ids[n], &bytes, &length) != 1) continue;
			job *j = job_new(J_TAKE, d);
			j->record = kind;
			memcpy(j->tree, TREE(d), 32);
			j->bytes = mr_copy(bytes ? bytes : none, length);
			j->length = length;
			erm_host_free(bytes);
			next(t, j);
		}
		free(ids.ids);
	}
	next(t, build_job(d, NULL, 0));
}

// starting: what the store holds, taken in before anything else, for each tree whose id is named
// already (lazy: only the documents followed before this); every other tree only listed (a hash can't
// be turned back into an id), taken in when its document is followed
static void load(sb_stack *t) {
	collected_t trees = {0};
	t->inner.list(t->inner.self, ERM_STORE_TREE, NULL, collect, &trees);
	for (size_t i = 0; i < trees.count; i++) {
		im_set(&t->trees, trees.ids[i], SET);
		mr_doc *d = document(t, trees.ids[i]);
		if (d != NULL && (!t->lazy || SBD(d)->follow_later)) load_doc(t, d);
	}
	free(trees.ids);
	next(t, job_new(J_LOADED, NULL));
}

static void fetch(sb_stack *t, mr_doc *d, fetch_kind kind, size_t ask);
static void post_connect(sb_stack *t);

static void follow_now(sb_stack *t, mr_doc *d) {
	if (!SBD(d)->followed) {
		SBD(d)->followed = true;
		ROOM(t->followed, t->followed_count, t->followed_room);
		t->followed[t->followed_count++] = d;
	}
	subscribe(t, TREE(d));
	fetch(t, d, F_FOLLOW, 0);
}

typedef enum { STEP_DONE, STEP_WAIT } step_t;


// an ephemeral commit heard from the peer with that key: the lock's open, then the mailroom's hear
// (decode, its signer the sender's); never stored, no commit steps. one the lock cannot open yet is
// let go of (nothing ephemeral is fetched), one it refuses is noted
static void hear(mr_doc *d, const uint8_t *blob, size_t length, const uint8_t from[32]) {
	lk_opened open;
	const char *why = NULL;
	open_t got = unlock(d, blob, length, &open, &why);
	if (got != OPEN_GOOD) {
		if (got == OPEN_REFUSED) mr_unheard(d, blob, length, MR_LOCK, why);
		return;
	}
	// the envelope: {id, commit}
	bool other;
	Json *x = unwrap(d, open.bytes, open.length, &other);
	lk_opened_free(&open);
	const Json *c = x != NULL ? jsonGet(x, "commit") : NULL;
	if (x == NULL || x->object.count != 2 || c == NULL || c->type != JSON_BYTES) {
		jsonFree(x);
		mr_unheard(d, blob, length, MR_SHAPE, NULL);
		return;
	}
	if (other) {
		jsonFree(x);
		mr_unheard(d, blob, length, MR_ID, OTHER);
		return;
	}
	uint8_t who[SL_KEY];
	mr_peer(from, who);
	mr_hear(d, c->bytes.data, c->bytes.length, who);
	jsonFree(x);
}

static step_t step(sb_stack *t, job *j) {
	switch (j->kind) {
	case J_LOAD: load(t); return STEP_DONE;
	case J_LOADED:
		t->loaded = true;
		for (mr_doc *d = mr_first(t->mailroom); d; d = d->next)
			if (SBD(d)->follow_later) SBD(d)->follow_later = false, follow_now(t, d);
		post_connect(t);
		return STEP_DONE;
	case J_TAKE: take(t, j, false); return STEP_DONE;
	case J_SAVE: take(t, j, true); return STEP_DONE;
	case J_HEAR: hear(j->d, j->bytes, j->length, j->from); return STEP_DONE;
	case J_GATHER: {
		size_t length;
		uint8_t *all = gather(t, j, &length);
		if (all == NULL) return STEP_DONE;
		if (!j->channel) hear(j->d, all, length, j->from);
		else {
			channel_t *c = im_get(&t->channels, j->topic);
			if (c != NULL) tell_channel(c, j->from, all, length);
		}
		free(all);
		return STEP_DONE;
	}
	case J_COMPACT: compact(t, j->d, j->head); return STEP_DONE;
	case J_LOAD_DOC:
		// its takes and build next, then the follow, so the store is read before any peer is asked
		load_doc(t, j->d);
		next(t, job_new(J_FOLLOW, j->d));
		return STEP_DONE;
	case J_FOLLOW: follow_now(t, j->d); return STEP_DONE;
	case J_STOP: {
		uint8_t who[SL_KEY];
		mr_peer(j->from, who);
		mr_tell_stopped(j->d, who, (const char *)j->bytes);
		return STEP_DONE;
	}
	case J_SUBSCRIBE: {
		if (j->started) return STEP_DONE;
		j->started = true;
		uint64_t c = subscribe(t, j->topic);
		if (c == 0) return STEP_DONE;
		call(t, c, C_SUBSCRIBE, j);
		return STEP_WAIT;
	}
	case J_BUILD: {
		mr_doc *d = j->d;
		if (!j->started) {
			j->started = true;
			if (!build_start(d, j)) return STEP_DONE;
		} else {
			const fragment *f = j->fresh[j->at++];
			compact(t, d, f->head);
			if (j->at == j->fresh_count) return STEP_DONE;
		}
		uint64_t c = build_add(t, d, j->fresh[j->at]);
		if (c == 0) return STEP_DONE;
		call(t, c, C_FRAGMENT, j);
		return STEP_WAIT;
	}
	}
	return STEP_DONE;
}

// the jobs, one at a time, in order, as far as they go
static bool jobs(sb_stack *t) {
	bool moved = false;
	while (t->jobs != NULL && !t->jobs->waiting) {
		job *j = t->jobs;
		t->cursor = j;
		step_t s = step(t, j);
		t->cursor = NULL;
		moved = true;
		if (s == STEP_WAIT) {
			j->waiting = true;
			break;
		}
		t->jobs = j->next;
		if (t->jobs == NULL) t->jobs_last = NULL;
		if (j->waiter) j->done = true;
		else job_free(j);
	}
	return moved;
}

// ---- sending what the mailroom queued

// a stored commit of this device's: sealed (the mailroom's), its seal handed over (taken in already),
// added as a loose commit; one that can head a fragment builds it
static void store(sb_stack *t, mr_item *it) {
	mr_doc *d = it->d;
	const hy_kept *k = it->kept;
	uint8_t *sealed, s[32];
	size_t length;
	if (!mr_sealed(d, k, &sealed, &length, s)) {
		t->cur.state = 3;
		return;
	}
	// closed by the lock before it leaves, its commit's name and parents given
	Json *e = jsonObject();
	jsonAdd(e, "sealed", jsonBytes(sealed, length));
	size_t n;
	uint8_t *enveloped = wrap(d, e, &n);
	lk_closed closed = t->lock->close(t->lock->context, (const uint8_t *)d->id, d->length, k->name, k->parents,
		k->parents_length, enveloped, n);
	uint8_t(*ids)[32];
	if (closed.bytes == NULL || !mr_handed(d, k, sealed, length, s, &ids)) {
		lk_closed_free(&closed);
		free(enveloped);
		free(sealed);
		t->cur.state = 3;
		return;
	}
	memcpy(t->cur.stored, s, 32);
	free(t->own);
	memcpy(t->own_stored, s, 32);
	t->own = mr_copy(closed.bytes, closed.length);
	t->own_length = closed.length;
	uint64_t c = erm_sd_add_commit(t->sd, TREE(d), s, k->parents_length ? (const uint8_t *)ids : NULL, k->parents_length,
		closed.bytes, closed.length);
	free(ids);
	lk_closed_free(&closed);
	free(enveloped);
	free(sealed);
	if (c == 0) {
		t->cur.state = 3;
		return;
	}
	call(t, c, C_STORE, &t->cur);
	t->cur.state = 1;
}

static bool outgoing(sb_stack *t) {
	bool moved = false;
	while (mr_front(t->mailroom) != NULL) {
		mr_item *it = mr_front(t->mailroom);
		cur_t *cur = &t->cur;
		if (cur->state == 2 && cur->build->done) {
			job_free(cur->build);
			cur->build = NULL;
			cur->state = 3;
		}
		if (cur->state == 1 || cur->state == 2) break;
		if (cur->state == 0) {
			// what is sealed and stored is handed over behind what the store held
			if (!t->loaded) break;
			moved = true;
			if (it->stop != NULL) {
				// a stop: {stop: table} published on the document's topic
				Json *m = jsonObject();
				jsonAdd(m, "stop", jsonString(it->stop));
				size_t size = 0;
				cborEncode(m, NULL, 0, &size, NULL);
				uint8_t *bytes = malloc(size + 1);
				if (bytes == NULL) abort();
				cborEncode(m, bytes, size, &size, NULL);
				jsonFree(m);
				uint64_t c = publish(t, TREE(it->d), bytes, size, false);
				free(bytes);
				if (c == 0) cur->state = 3;
				else call(t, c, C_PUBLISH, cur), cur->state = 1;
			} else if (it->layer == MR_STORED) store(t, it);
			else {
				// an ephemeral commit of this device's: closed by the lock, published, as parts when over
				const hy_kept *k = it->kept;
				Json *e = jsonObject();
				jsonAdd(e, "commit", jsonBytes(k->bytes, k->length));
				size_t n;
				uint8_t *enveloped = wrap(it->d, e, &n);
				lk_closed closed = t->lock->close(t->lock->context, (const uint8_t *)it->d->id, it->d->length, k->name,
					k->parents, k->parents_length, enveloped, n);
				uint64_t c = closed.bytes == NULL ? 0 : publish(t, TREE(it->d), closed.bytes, closed.length, false);
				lk_closed_free(&closed);
				free(enveloped);
				if (c == 0) cur->state = 3;
				else call(t, c, C_PUBLISH, cur), cur->state = 1;
			}
			continue;
		}
		mr_pop(t->mailroom);
		*cur = (cur_t){0};
		moved = true;
	}
	return moved;
}

// ---- fetching

static void fetch(sb_stack *t, mr_doc *d, fetch_kind kind, size_t ask) {
	uint64_t c = erm_sd_sync(t->sd, TREE(d), 1, 0);
	if (c == 0) return;
	fetch_t *f = malloc(sizeof *f);
	if (f == NULL) abort();
	*f = (fetch_t){d, kind, 1, ask};
	call(t, c, C_FETCH, f);
	t->fetching++;
}

static size_t taken_count(mr_doc *d) {
	const hy_kept **all;
	size_t n = hy_all(d->histories[MR_STORED], &all);
	free(all);
	return n;
}

// a followed document asked for again, a while later each time: the server pushes a commit to its
// subscribers before it stores it, so an ask that lands between is answered without it and hears no
// push. Asked twice more whatever it holds, then on while it holds nothing or a commit waits on a
// parent; after the last step, every last step while a commit waits
static bool worth(mr_doc *d, size_t i) {
	return i < 2 || (i < BACKOFF && taken_count(d) == 0) || mr_waits(d);
}

static void asking(sb_stack *t, mr_doc *d, size_t i) {
	SBD(d)->asking = false;
	if (!worth(d, i)) return;
	SBD(d)->asking = true;
	SBD(d)->ask = i;
	SBD(d)->due = now_of(t) + backoff[i < BACKOFF ? i : BACKOFF - 1];
}

static bool timers(sb_stack *t, uint64_t now) {
	bool moved = false;
	for (mr_doc *d = mr_first(t->mailroom); d; d = d->next) {
		if (!SBD(d)->asking || now < SBD(d)->due) continue;
		SBD(d)->asking = false;
		moved = true;
		if (!worth(d, SBD(d)->ask)) continue;
		fetch(t, d, F_ASK, SBD(d)->ask);
	}
	return moved;
}

// connections whose handshake is done, once what the store held is in: the topics subscribed again
// (a subscription reaches only the connections there when it is made), the followed documents fetched
static void post_connect(sb_stack *t) {
	if (!t->loaded) return;
	for (size_t i = 0; i < t->conn_count; i++) {
		if (!t->conns[i].up || !t->conns[i].fresh) continue;
		t->conns[i].fresh = false;
		for (size_t k = 0; k < t->wanted_count; k++) erm_sd_subscribe(t->sd, t->wanted_order[k]);
		for (size_t k = 0; k < t->followed_count; k++) fetch(t, t->followed[k], F_CONNECT, 0);
	}
}

// ---- Subduction's events

static void ask(sb_stack *t, sb_out_kind kind, uint64_t conn, const uint8_t *bytes, size_t length) {
	ROOM(t->outs, t->out_count, t->out_room);
	t->outs[t->out_count++] = (sb_out){kind, conn, bytes ? mr_copy(bytes, length) : NULL, length};
}

static void forget_conn(sb_stack *t, uint64_t conn) {
	for (size_t i = 0; i < t->conn_count; i++) {
		if (t->conns[i].id != conn) continue;
		t->conns[i] = t->conns[--t->conn_count];
		return;
	}
}

static void given_save(sb_stack *t, put_t *p, int kind) {
	job *j = job_new(J_SAVE, p->d);
	j->record = kind;
	j->given = true;
	memcpy(j->tree, TREE(p->d), 32);
	memcpy(j->head, p->head, 32);
	j->list = p->list, j->count = p->count, p->list = NULL;
	j->bytes = p->blob, j->length = p->length, p->blob = NULL;
	j->checks = p->checks, j->checks_count = p->checks_count, p->checks = NULL;
	later(t, j);
}

static void put_free(put_t *p) {
	free(p->list);
	free(p->blob);
	free(p->checks);
	free(p);
}

static void done(sb_stack *t, uint64_t number, bool ok) {
	size_t i = 0;
	while (i < t->call_count && t->calls[i].call != number) i++;
	if (i == t->call_count) return;
	call_t c = t->calls[i];
	t->calls[i] = t->calls[--t->call_count];
	switch (c.kind) {
	case C_STORE: {
		cur_t *it = c.what;
		it->state = 3;
		free(t->own);
		t->own = NULL;
		if (ok && depth(it->stored) > 0) {
			// Subduction asks for a fragment (FragmentRequested): built in the queue, and waited for
			it->build = build_job(mr_front(t->mailroom)->d, (const uint8_t(*)[32])it->stored, 1);
			it->build->waiter = true;
			later(t, it->build);
			it->state = 2;
		}
		break;
	}
	case C_PUBLISH: ((cur_t *)c.what)->state = 3; break;
	case C_FRAGMENT:
	case C_SUBSCRIBE: ((job *)c.what)->waiting = false; break;
	case C_FETCH: {
		fetch_t *f = c.what;
		if (f->round == 1) {
			uint64_t again = erm_sd_sync(t->sd, TREE(f->d), 1, 0);
			if (again != 0) {
				f->round = 2;
				call(t, again, C_FETCH, f);
				break;
			}
		}
		t->fetching--;
		if (f->kind == F_FOLLOW) asking(t, f->d, 0);
		else if (f->kind == F_ASK) asking(t, f->d, f->ask + 1);
		free(f);
		break;
	}
	case C_PUT:
	case C_PUT_FRAGMENT: {
		put_t *p = c.what;
		t->putting--;
		int kind = c.kind == C_PUT ? ERM_STORE_COMMIT : ERM_STORE_FRAGMENT;
		if (ok) {
			// a save Subduction passed over (one it holds under that id with a lower digest) is taken in
			// as given, as the save hook would have it
			if (!p->saw) given_save(t, p, kind);
			if (kind == ERM_STORE_FRAGMENT || depth(p->head) > 0) later(t, build_job(p->d, NULL, 0));
		}
		put_free(p);
		break;
	}
	}
}

// an ephemeral message: a document's (followed), or a channel's
static void heard(sb_stack *t, const uint8_t topic[32], const uint8_t from[32], const uint8_t *payload, size_t length) {
	mr_doc *d = document(t, topic);
	part_t p;
	part_kind kind = part_of(payload, length, t->parts, &p);
	channel_t *c = im_get(&t->channels, topic);
	job *j = NULL;
	if (c != NULL && d == NULL) {
		if (kind == NOT_A_PART) tell_channel(c, from, payload, length);
		else if (kind == A_PART) {
			j = job_new(J_GATHER, NULL);
			j->channel = true;
			memcpy(j->topic, topic, 32);
		}
	} else if (d != NULL && SBD(d)->followed) {
		char *table = kind == NOT_A_PART ? stop_of(payload, length) : NULL;
		if (table != NULL) {
			// a stop: told in its turn, after the ephemeral commits heard before it
			j = job_new(J_STOP, d);
			j->bytes = (uint8_t *)table;
			j->length = strlen(table);
		} else if (kind == NOT_A_PART) {
			j = job_new(J_HEAR, d);
			j->bytes = mr_copy(payload, length);
			j->length = length;
		} else if (kind == A_PART) j = job_new(J_GATHER, d);
	}
	if (j != NULL) {
		memcpy(j->from, from, 32);
		if (j->kind == J_GATHER) {
			memcpy(j->whole, p.whole, 32);
			j->part = p.part;
			j->parts = p.parts;
			j->bytes = mr_copy(p.bytes, p.length);
			j->length = p.length;
		}
		later(t, j);
	}
	jsonFree(p.own);
}

static bool events(sb_stack *t) {
	bool any = false;
	ErmSdEvent e;
	while (erm_sd_poll(t->sd, &e)) {
		any = true;
		switch (e.kind) {
		case ERM_SD_SEND: ask(t, SB_SEND, e.conn, e.bytes, e.length); break;
		case ERM_SD_CLOSE:
			ask(t, SB_CLOSE, e.conn, NULL, 0);
			forget_conn(t, e.conn);
			break;
		case ERM_SD_DONE: done(t, e.call, e.ok); break;
		case ERM_SD_CONNECTED:
			for (size_t i = 0; i < t->conn_count; i++) {
				if (t->conns[i].id != e.conn) continue;
				if (e.ok) {
					t->conns[i].up = t->conns[i].fresh = true;
					memcpy(t->conns[i].key, e.key, 32);
				} else forget_conn(t, e.conn);
				break;
			}
			post_connect(t);
			break;
		case ERM_SD_COMMITS:
			if (e.call != t->want) break;
			free(t->found);
			t->found = malloc(e.count * 32 + 1);
			if (t->found == NULL) abort();
			for (size_t i = 0; i < e.count; i++) memcpy(t->found[i], e.commits[i].id, 32);
			t->found_count = e.count;
			t->answered = true;
			break;
		case ERM_SD_HEARD: heard(t, e.topic, e.key, e.bytes, e.length); break;
		default: break;
		}
		erm_sd_free_event(&e);
	}
	return any;
}

// ---- Subduction's store, wrapped: what it saves is taken in

// the door for a tree not named yet (subduction.ts's stranger): a loose commit's (ERM_STORE_COMMIT) or a
// fragment's envelope (with its boundary), its id read from it: the id makes this tree, and the names
// and the closure pass (as for a followed one). One the lock cannot open without its id: stored as it
// came
static door_t stranger(sb_stack *t, int kind, const uint8_t tree[32], const uint8_t head[32],
	const uint8_t (*boundary)[32], size_t count, const uint8_t *blob, size_t length) {
	lk_opened open = t->lock->open(t->lock->context, (const uint8_t *)"", 0, blob, length);
	if (open.kind != LK_OPEN) return lk_opened_free(&open), DOOR_STORE;
	Json *x = cborDecode(open.bytes, open.length, NULL, NULL);
	lk_opened_free(&open);
	const Json *id = x != NULL && x->type == JSON_OBJECT ? jsonGet(x, "id") : NULL;
	uint8_t mine[32];
	bool ok = id != NULL && id->type == JSON_STRING && sb_tree(id->string, id->stringLength, mine) &&
		memcmp(mine, tree, 32) == 0;
	const uint8_t *i = ok ? (const uint8_t *)id->string : NULL;
	size_t n = ok ? id->stringLength : 0;
	if (ok && kind == ERM_STORE_COMMIT) {
		const Json *s = jsonGet(x, "sealed");
		uint8_t name[CM_NAME], own[32];
		ok = x->object.count == 2 && s != NULL && s->type == JSON_BYTES &&
			peek_seal(s->bytes.data, s->bytes.length, i, n, name, own, mine) && memcmp(own, mine, 32) == 0 &&
			memcmp(mine, head, 32) == 0;
	} else if (ok) {
		const Json *packed = jsonGet(x, "run"), *members = jsonGet(x, "members"), *snapshot = jsonGet(x, "snapshot");
		ok = (packed == NULL) != (members == NULL) && (size_t)x->object.count == 2 + (snapshot != NULL) &&
			names(i, n, packed, members, head, boundary, count) == 0;
	}
	jsonFree(x);
	return ok ? DOOR_STORE : DOOR_PASS;
}

// what Subduction may store (its admission: allows, allows_fragment; a tree not named yet, stranger), the
// record decoded and its blob, put just before it, read. One passed over or refused has its blob let go
// of too, and the document's movers told
static door_t admits(sb_stack *t, int kind, const uint8_t tree[32], const uint8_t *bytes, size_t length) {
	record_t r;
	if (!record(t, kind, bytes, length, &r)) return DOOR_REFUSE;
	mr_doc *d = document(t, tree);
	const uint8_t *blob = r.blob != NULL ? r.blob : none;
	door_t door;
	// a tree whose id is not named yet, past the door: stored, the tree listed; taken in, each checked
	// whole, when its document is followed. Nothing is refused (it would leave Subduction never sending
	// it again on that connection)
	if (d == NULL) {
		door = stranger(t, kind, tree, r.rec.id, (const uint8_t(*)[32])r.rec.parents, r.rec.parentCount, blob, r.length);
		if (door == DOOR_STORE) im_set(&t->trees, tree, SET);
		else t->inner.remove(t->inner.self, ERM_STORE_BLOB, NULL, r.rec.digest);
		record_free(&r);
		return door;
	}
	door = kind == ERM_STORE_COMMIT
		? allows(d, r.rec.id, blob, r.length)
		: allows_fragment(d, r.rec.id, (const uint8_t(*)[32])r.rec.parents, r.rec.parentCount,
			  r.rec.checkpoints != NULL ? r.rec.checkpoints : none, r.rec.checkpointCount, blob, r.length);
	if (door != DOOR_STORE) {
		t->inner.remove(t->inner.self, ERM_STORE_BLOB, NULL, r.rec.digest);
		// passed over or refused: told now, as a take tells, so it shows (sync's status) before anything
		// else moves
		mr_tell_moved(t->mailroom, d);
	}
	record_free(&r);
	return door;
}

static int saved(void *self, int kind, const uint8_t *tree, const uint8_t id[32], const uint8_t *bytes, size_t length) {
	sb_stack *t = self;
	if (kind == ERM_STORE_COMMIT || kind == ERM_STORE_FRAGMENT) {
		door_t door = admits(t, kind, tree, bytes, length);
		// passed over: not stored, and the save is as if it were
		if (door == DOOR_PASS) return 0;
		if (door == DOOR_REFUSE) return -1;
	}
	int r = t->inner.put(t->inner.self, kind, tree, id, bytes, length);
	if (r != 0 || (kind != ERM_STORE_COMMIT && kind != ERM_STORE_FRAGMENT)) return r;
	// unnamed: only stored, taken in on follow
	if (document(t, tree) == NULL) return 0;
	call_kind waits = kind == ERM_STORE_COMMIT ? C_PUT : C_PUT_FRAGMENT;
	for (size_t i = 0; i < t->call_count; i++) {
		if (t->calls[i].kind != waits) continue;
		put_t *p = t->calls[i].what;
		if (memcmp(TREE(p->d), tree, 32) == 0 && memcmp(p->head, id, 32) == 0) p->saw = true;
	}
	job *j = job_new(J_SAVE, NULL);
	j->record = kind;
	memcpy(j->tree, tree, 32);
	j->bytes = mr_copy(bytes, length);
	j->length = length;
	later(t, j);
	return 0;
}

static int store_get(void *self, int kind, const uint8_t *tree, const uint8_t id[32], uint8_t **bytes, size_t *length) {
	sb_stack *t = self;
	return t->inner.get(t->inner.self, kind, tree, id, bytes, length);
}

static int store_list(void *self, int kind, const uint8_t *tree, void (*each)(void *context, const uint8_t id[32]),
	void *context) {
	sb_stack *t = self;
	return t->inner.list(t->inner.self, kind, tree, each, context);
}

static int store_remove(void *self, int kind, const uint8_t *tree, const uint8_t *id) {
	sb_stack *t = self;
	return t->inner.remove(t->inner.self, kind, tree, id);
}

// ---- the stack

sb_stack *sb_create(const sb_options *o, mr_mailroom *mailroom) {
	sb_stack *t = calloc(1, sizeof *t);
	if (t == NULL) abort();
	t->mailroom = mailroom;
	t->inner = *o->store;
	t->store = (ErmStore){t, saved, store_get, store_list, store_remove};
	t->service = copyString(o->service ? o->service : "ermine");
	t->join = o->join ? o->join : 30000;
	t->now = o->now;
	t->clock = o->clock;
	t->snapshot = o->snapshot;
	t->context = o->context;
	t->lock = o->lock != NULL ? o->lock : lk_unlocked();
	t->joins = o->joins ? o->joins : 64;
	t->parts = o->parts ? o->parts : 1024;
	t->lazy = o->lazy;
	t->sd = erm_sd_new(o->seed, now_of(t), &t->store);
	if (t->sd == NULL) {
		free(t->service);
		free(t);
		return NULL;
	}
	later(t, job_new(J_LOAD, NULL));
	mr_attach(mailroom, &(mr_stack){made, handed}, t);
	return t;
}

// the stack's slots of the documents let go of: before the mailroom is
void sb_free(sb_stack *t) {
	if (t == NULL) return;
	erm_sd_free(t->sd);
	for (mr_doc *d = mr_first(t->mailroom); d; d = d->next) {
		sb_doc *s = SBD(d);
		for (size_t i = 0; i < s->fragments.slots; i++) {
			if (!s->fragments.used[i]) continue;
			fragment_free(s->fragments.values[i]);
			free(s->fragments.values[i]);
		}
		im_free(&s->fragments);
		for (size_t i = 0; i < s->locked.slots; i++)
			if (s->locked.used[i]) locked_free(s->locked.values[i]);
		for (size_t i = 0; i < s->locked_fragments.slots; i++)
			if (s->locked_fragments.used[i]) locked_free(s->locked_fragments.values[i]);
		im_free(&s->locked);
		im_free(&s->locked_fragments);
		mr_order_free(&s->locked_order);
		mr_order_free(&s->locked_fragments_order);
		mr_refusals_free(&s->broken);
		mr_order_free(&s->broken_order);
		free(s);
		d->stack = NULL;
	}
	im_free(&t->trees);
	im_free(&t->docs);
	free(t->followed);
	for (job *j = t->jobs; j;) {
		job *n = j->next;
		if (!j->waiter) job_free(j);
		j = n;
	}
	if (t->cur.build != NULL) job_free(t->cur.build);
	for (size_t i = t->out_next; i < t->out_count; i++) free(t->outs[i].bytes);
	free(t->outs);
	for (size_t i = 0; i < t->call_count; i++) {
		if (t->calls[i].kind == C_FETCH) free(t->calls[i].what);
		if (t->calls[i].kind == C_PUT || t->calls[i].kind == C_PUT_FRAGMENT) put_free(t->calls[i].what);
	}
	free(t->calls);
	free(t->conns);
	im_free(&t->wanted);
	free(t->wanted_order);
	for (size_t i = 0; i < t->channels.slots; i++) {
		if (!t->channels.used[i]) continue;
		channel_t *c = t->channels.values[i];
		for (sb_listener *l = c->first; l;) {
			sb_listener *n = l->next;
			free(l);
			l = n;
		}
		free(c);
	}
	im_free(&t->channels);
	expire(t, true);
	free(t->found);
	free(t->own);
	free(t->service);
	free(t);
}
// listeners let go of since they were last told
static void sweep(sb_stack *t) {
	for (size_t i = 0; i < t->channels.slots; i++) {
		if (!t->channels.used[i]) continue;
		channel_t *c = t->channels.values[i];
		for (sb_listener **at = &c->first; *at;) {
			sb_listener *l = *at;
			if (l->gone) *at = l->next, free(l);
			else at = &l->next;
		}
	}
}

int64_t sb_run(sb_stack *t) {
	for (;;) {
		uint64_t now = now_of(t);
		int64_t wait = erm_sd_run(t->sd, now);
		bool moved = events(t);
		moved = mr_rejudge(t->mailroom) || moved;
		moved = jobs(t) || moved;
		moved = outgoing(t) || moved;
		moved = timers(t, now) || moved;
		if (moved || wait == 0) continue;
		sweep(t);
		mr_forgotten(t->mailroom);
		int64_t timer = -1;
		for (mr_doc *d = mr_first(t->mailroom); d; d = d->next) {
			if (!SBD(d)->asking) continue;
			int64_t in = SBD(d)->due > now ? (int64_t)(SBD(d)->due - now) : 0;
			if (timer < 0 || in < timer) timer = in;
		}
		if (wait < 0) return timer;
		return timer < 0 || wait < timer ? wait : timer;
	}
}

// nothing left to take in, build or publish here (the mailroom's own takes aside)
bool sb_idle(const sb_stack *t) {
	return t->jobs == NULL;
}

bool sb_ready(const sb_stack *t) {
	return t->loaded;
}

size_t sb_fetching(const sb_stack *t) {
	return t->fetching;
}

uint64_t sb_connect(sb_stack *t, const char *service) {
	uint64_t c = erm_sd_connect(t->sd, service != NULL ? service : t->service);
	if (c == 0) return 0;
	ROOM(t->conns, t->conn_count, t->conn_room);
	t->conns[t->conn_count++] = (conn_t){.id = c};
	return c;
}

void sb_received(sb_stack *t, uint64_t conn, const uint8_t *bytes, size_t length) {
	erm_sd_received(t->sd, conn, bytes, length);
}

void sb_closed(sb_stack *t, uint64_t conn) {
	erm_sd_closed(t->sd, conn);
	forget_conn(t, conn);
}

bool sb_connected(const sb_stack *t, uint64_t conn, uint8_t key[SL_KEY]) {
	for (size_t i = 0; i < t->conn_count; i++) {
		if (t->conns[i].id != conn || !t->conns[i].up) continue;
		if (key != NULL) mr_peer(t->conns[i].key, key);
		return true;
	}
	return false;
}

void sb_disconnect(sb_stack *t, const uint8_t key[SL_KEY]) {
	// the peer by its Ed25519 key: the multikey's
	if (key[0] != 0xed || key[1] != 0x01) return;
	for (size_t i = 0; i < t->conn_count;) {
		if (!t->conns[i].up || memcmp(t->conns[i].key, key + 2, 32) != 0) {
			i++;
			continue;
		}
		uint64_t conn = t->conns[i].id;
		erm_sd_closed(t->sd, conn);
		ask(t, SB_CLOSE, conn, NULL, 0);
		t->conns[i] = t->conns[--t->conn_count];
	}
}

void sb_service(const char *url, char *out, size_t size) {
	const char *at = strstr(url, "://");
	at = at ? at + 3 : url;
	size_t n = strcspn(at, "/?#");
	const char *login = memchr(at, '@', n);
	if (login) n -= (size_t)(login + 1 - at), at = login + 1;
	if (n >= size) n = size - 1;
	memcpy(out, at, n);
	out[n] = 0;
}

bool sb_next(sb_stack *t, sb_out *out) {
	if (t->out_next == t->out_count) {
		t->out_count = t->out_next = 0;
		return false;
	}
	*out = t->outs[t->out_next++];
	return true;
}

void sb_out_free(sb_out *out) {
	free(out->bytes);
	out->bytes = NULL;
}

bool sb_follow(sb_stack *t, const char *id) {
	mr_doc *d = mr_named(t->mailroom, id);
	if (d == NULL) return false;
	if (!t->loaded) SBD(d)->follow_later = true;
	else if (!SBD(d)->loaded && im_has(&t->trees, TREE(d))) {
		// its tree read from the store first, the follow behind it (J_LOAD_DOC)
		SBD(d)->loaded = true;
		later(t, job_new(J_LOAD_DOC, d));
	} else follow_now(t, d);
	return true;
}

size_t sb_stored(sb_stack *t, const char *id, uint8_t (**out)[32]) {
	*out = NULL;
	mr_doc *d = mr_named(t->mailroom, id);
	if (d == NULL) return 0;
	free(t->found);
	t->found = NULL;
	t->found_count = 0;
	t->answered = false;
	t->want = erm_sd_commits(t->sd, TREE(d));
	for (int round = 0; round < 10000 && !t->answered; round++) sb_run(t);
	*out = t->found;
	t->found = NULL;
	size_t n = t->found_count;
	t->found_count = 0;
	return n;
}

size_t sb_unnamed(const sb_stack *t) {
	size_t n = 0;
	for (size_t i = 0; i < t->trees.slots; i++)
		if (t->trees.used[i] && document(t, im_key(&t->trees, i)) == NULL) n++;
	return n;
}

size_t sb_fragments(sb_stack *t, const char *id, const fragment ***out) {
	*out = NULL;
	mr_doc *d = mr_named(t->mailroom, id);
	if (d == NULL) return 0;
	const fragment **list = malloc((SBD(d)->fragments.count + 1) * sizeof *list);
	if (list == NULL) abort();
	size_t n = 0;
	for (size_t i = 0; i < SBD(d)->fragments.slots; i++)
		if (SBD(d)->fragments.used[i]) list[n++] = SBD(d)->fragments.values[i];
	*out = list;
	return n;
}

void sb_send(sb_stack *t, const char *topic, const uint8_t *bytes, size_t length) {
	uint8_t id[32];
	channel(t, topic, id);
	// a server relays a publish only from a subscriber of its topic
	subscribe(t, id);
	part_t p;
	part_kind kind = part_of(bytes, length, t->parts, &p);
	jsonFree(p.own);
	// a payload that looks like a part is sent as parts too, so it arrives as it was sent
	publish(t, id, bytes, length, kind != NOT_A_PART);
}

sb_listener *sb_listen(sb_stack *t, const char *topic, sb_heard_fn fn, void *context) {
	uint8_t id[32];
	channel_t *c = channel(t, topic, id);
	sb_listener *l = calloc(1, sizeof *l);
	if (l == NULL) abort();
	l->fn = fn;
	l->context = context;
	sb_listener **at = &c->first;
	while (*at) at = &(*at)->next;
	*at = l;
	job *j = job_new(J_SUBSCRIBE, NULL);
	memcpy(j->topic, id, 32);
	later(t, j);
	return l;
}

void sb_unlisten(sb_stack *t, sb_listener *l) {
	(void)t;
	l->gone = true;
}


const im_map *sb_broken(const sb_stack *t, mr_doc *d) {
	(void)t;
	return &SBD(d)->broken;
}

const im_map *sb_locked(const sb_stack *t, mr_doc *d) {
	(void)t;
	return &SBD(d)->locked;
}

static int by_waiting_commit(const void *a, const void *b) {
	return memcmp(((const mr_waiting_row *)a)->commit, ((const mr_waiting_row *)b)->commit, 32);
}

// what the stack adds to a taking (mr_taking_of's): the fragments waiting on the lock, each by its
// head with its boundary
void sb_taking(const sb_stack *t, mr_doc *d, mr_taking *taking) {
	(void)t;
	const im_map *m = &SBD(d)->locked_fragments;
	if (m->count > 0) {
		taking->waiting = realloc(taking->waiting, (taking->waiting_count + m->count + 1) * sizeof *taking->waiting);
		if (taking->waiting == NULL) abort();
		for (size_t i = 0; i < m->slots; i++) {
			if (!m->used[i]) continue;
			const locked_t *l = m->values[i];
			mr_waiting_row *w = &taking->waiting[taking->waiting_count++];
			*w = (mr_waiting_row){.fragment = true, .boundary_count = l->count};
			memcpy(w->commit, im_key(m, i), 32);
			w->boundary = mr_copy(l->list, l->count * 32);
		}
		qsort(taking->waiting, taking->waiting_count, sizeof *taking->waiting, by_waiting_commit);
	}
}

// what waited on the lock, each taken in again as it arrived, queued at the end of the jobs: once,
// however often this is called before it runs
void sb_changed(sb_stack *t) {
	for (mr_doc *d = mr_first(t->mailroom); d; d = d->next) {
		for (int k = 0; k < 2; k++) {
			const im_map *m = k == 0 ? &SBD(d)->locked : &SBD(d)->locked_fragments;
			for (size_t i = 0; i < m->slots; i++) {
				if (!m->used[i]) continue;
				locked_t *l = m->values[i];
				if (l->queued) continue;
				l->queued = true;
				job *j = job_new(J_TAKE, d);
				j->record = k == 0 ? ERM_STORE_COMMIT : ERM_STORE_FRAGMENT;
				memcpy(j->tree, TREE(d), 32);
				j->given = true;
				j->again = true;
				memcpy(j->head, im_key(m, i), 32);
				j->list = (uint8_t(*)[32])mr_copy(l->list, l->count * 32);
				j->count = l->count;
				j->checks = l->checks_count ? mr_copy(l->checks, l->checks_count * 12) : NULL;
				j->checks_count = l->checks_count;
				j->bytes = mr_copy(l->blob, l->length);
				j->length = l->length;
				later(t, j);
			}
		}
	}
}

// the harnesses' hooks (subduction_conformance_hook.h), only in their builds
#ifdef CONFORMANCE_HOOK
#include "subduction_conformance_hook.c"
#endif
