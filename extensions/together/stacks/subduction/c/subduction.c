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

#include "../../../c/run.h"
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

static size_t depth(const uint8_t id[32]) {
	return fragment_depth(id);
}

// ---- documents

// what the stack keeps of a document: its fragments, and what is its alone
typedef struct {
	mr_doc *d;
	// by head (fragment *)
	im_map fragments;
	// fragments refused whole, by head (codes)
	im_map broken;
	mr_order_t broken_order;
	// how many taken-in seals have a depth, so a build with none is passed over
	size_t deep;
	bool followed, follow_later;
	// lazy: its tree taken in from the store (or queued to be)
	bool loaded;
	// asked for again at due, the ask'th time
	bool asking;
	size_t ask;
	uint64_t due;
} sb_doc;

#define SBD(d) ((sb_doc *)(d)->stack)

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
	bool loaded;
	// lazy, and the trees the store held at the start, each taken in when its document is followed
	bool lazy;
	im_map trees;
	// sb_stored's call, and its answer
	uint64_t want;
	bool answered;
	uint8_t (*found)[32];
	size_t found_count;
};

// the stack's slot of a document, made as the mailroom makes the document; the stack's fragments go with it
static void made(void *context, mr_doc *d) {
	(void)context;
	sb_doc *s = calloc(1, sizeof *s);
	if (s == NULL) abort();
	s->d = d;
	d->stack = s;
}

// a seal taken in at the document: a depth makes it worth building
static void handed(void *context, mr_doc *d, const uint8_t stored[32]) {
	(void)context;
	if (depth(stored) > 0) SBD(d)->deep++;
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

// ---- taking in

static mr_code code_of(sl_code code) {
	return code == SL_SIGNATURE ? MR_SIGNATURE : MR_SHAPE;
}

// a loose commit's first steps, the lock (unlocked), the seal, its stored id: its commit in *it;
// false: refused, noted
static bool opening(mr_doc *d, const uint8_t head[32], const uint8_t *blob, size_t length, sl_unsealed *it) {
	sl_code code = sl_unseal(blob, length, d->bytes, it, NULL);
	if (code != SL_OK) {
		mr_refuse(d, head, code_of(code), NULL);
		return false;
	}
	if (memcmp(it->stored, head, 32) != 0) {
		uint8_t name[CM_NAME];
		memcpy(name, it->name, CM_NAME);
		sl_free(it);
		mr_refuse(d, head, MR_STORED_ID, name);
		mr_settle(d);
		return false;
	}
	return true;
}

// the steps of a loose commit, in order: the lock (unlocked), the seal, its stored id, then pending
static void take_commit(mr_doc *d, const uint8_t head[32], const uint8_t (*parents)[32], size_t count, const uint8_t *blob,
	size_t length) {
	if (im_has(&d->seen, head)) return;
	sl_unsealed u;
	if (!opening(d, head, blob, length, &u)) return;
	im_del(&d->refused, head);
	mr_pending_t *p = calloc(1, sizeof *p);
	if (p == NULL) abort();
	memcpy(p->key, head, 32);
	p->commit = true;
	mr_sealed_of(&p->it, &u);
	p->sealed = mr_copy(blob, length);
	p->sealed_length = length;
	p->given = mr_copy(parents, count * 32);
	p->given_length = count;
	qsort(p->given, count, 32, by_id);
	mr_pend(d, p);
	mr_settle(d);
}

// what Subduction may store of a loose commit (its admission): one that unseals under its stored id
// (the lock, unlocked, opens all). What is refused is noted, as taking it in notes it
static bool allows(mr_doc *d, const uint8_t head[32], const uint8_t *blob, size_t length) {
	if (im_has(&d->seen, head)) return true;
	sl_unsealed u;
	if (!opening(d, head, blob, length, &u)) return false;
	sl_free(&u);
	return true;
}

// a fragment's blob opened: {run: its members as columns (run.h), snapshot?: packed tables}, or
// {members: [sealed...], snapshot?} as it was first written. Each member unsealed as it is read, in
// order: the first that is not good ends it, and the fragment is refused whole with its code (a run
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
	const uint8_t *doc;
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
static bool read_member(void *context, const rn_member *r) {
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
	sl_code code = sl_unseal(r->sealed, r->sealed_length, g->doc, &u, NULL);
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
	rn_member r = {.sealed = sealed, .sealed_length = length};
	return read_member(g, &r);
}

// 0, or the code the fragment is refused with (out is left empty)
static mr_code contents(const uint8_t doc[32], const uint8_t *open, size_t length, contents_t *out) {
	*out = (contents_t){0};
	reading_t g = {out, doc, NULL, 0, 0};
	Json *x = cborDecode(open, length, NULL, NULL);
	if (x == NULL || x->type != JSON_OBJECT || x->object.count < 1 || x->object.count > 2) return jsonFree(x), MR_SHAPE;
	const Json *run = jsonGet(x, "run"), *members = jsonGet(x, "members"), *snapshot = jsonGet(x, "snapshot");
	if ((run == NULL) == (members == NULL) || (size_t)x->object.count != 1 + (snapshot != NULL)) return jsonFree(x), MR_SHAPE;
	mr_code code = 0;
	if (run != NULL) {
		if (run->type != JSON_BYTES) code = MR_SHAPE;
		else {
			rn_code c = rn_each(run->bytes.data, run->bytes.length, read_member, &g, NULL);
			if (c == RN_STOPPED) code = out->code;
			else if (c != RN_OK) code = MR_SHAPE;
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
// checked: its head one of its members; its head of depth 1 or more, every other member of less depth,
// and reached from the head along parents among the members; its boundary of the head's depth or more
// and none of its members; its checkpoints (their first 12 bytes; NULL: none said) each member but the
// head with a depth; a member's stored id seen here under its own name. A head here whose walk can be
// made here: its members and boundary that walk's.
// 0, or the code it is refused with (got left empty)
static mr_code vetted(mr_doc *d, const uint8_t head[32], const uint8_t (*boundary)[32], size_t count,
	const uint8_t *checkpoints, size_t checks, const uint8_t *open, size_t length, contents_t *got) {
	mr_code code = contents(d->bytes, open, length, got);
	if (code != 0) return code;
	size_t top = depth(head);
	bool has = false;
	im_map ids = {0}, reached = {0};
	for (size_t i = 0; i < got->count; i++) {
		has = has || memcmp(got->members[i].it.stored, head, 32) == 0;
		im_set(&ids, got->members[i].it.stored, SET);
	}
	// a stored id here already is under the name it has here (a vouched one's is only said)
	for (size_t i = 0; i < got->count && has; i++) {
		const mr_seen_t *was = im_get(&d->seen, got->members[i].it.stored);
		if (was != NULL && memcmp(was->name, got->members[i].it.name, CM_NAME) != 0) has = false;
	}
	if (!has) code = MR_STORED_ID;
	else {
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
	}
	im_free(&ids), im_free(&reached);
	if (code != 0) contents_free(got);
	return code;
}

// a fragment refused whole, by head
static void broke(mr_doc *d, const uint8_t head[32], mr_code code) {
	mr_note(&SBD(d)->broken, &SBD(d)->broken_order, head, CODE(code), mr_limits_of(d->mailroom)->refused, NULL);
}

// what Subduction may store of a fragment (its admission): one that is checked (vetted; the lock,
// unlocked, opens all). One whose head is not here yet is noted refused whole
static bool allows_fragment(mr_doc *d, const uint8_t head[32], const uint8_t (*boundary)[32], size_t count,
	const uint8_t *checkpoints, size_t checks, const uint8_t *blob, size_t length) {
	contents_t got;
	mr_code code = vetted(d, head, boundary, count, checkpoints, checks, blob, length, &got);
	if (code == 0) return contents_free(&got), true;
	if (!im_has(&d->seen, head)) broke(d, head, code);
	return false;
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
	contents_t got;
	mr_code code = vetted(d, head, boundary, count, checkpoints, checks, blob, length, &got);
	if (code != 0) {
		if (here == NULL) broke(d, head, code);
		return;
	}
	im_del(&SBD(d)->broken, head);
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
	while (j && !(j->channel == p->channel && memcmp(j->where, p->channel ? p->topic : p->d->bytes, 32) == 0 &&
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
		memcpy(j->where, p->channel ? p->topic : p->d->bytes, 32);
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
	rn_item *items = malloc((f->members.count + 1) * sizeof *items);
	if (ms == NULL || items == NULL) abort();
	for (size_t i = 0; i < f->members.count; i++) ms[i] = im_get(&d->seen, f->members.ids[i]);
	qsort(ms, f->members.count, sizeof *ms, by_lamport);
	for (size_t i = 0; i < f->members.count; i++)
		items[i] = ms[i]->sealed != NULL ? (rn_item){ms[i]->sealed, ms[i]->sealed_length, NULL}
						  : (rn_item){ms[i]->bytes, ms[i]->length, ms[i]->stored};
	uint8_t *run = NULL;
	size_t run_length = 0;
	rn_pack(items, f->members.count, &run, &run_length);
	free(ms);
	free(items);
	Json *blob = jsonObject();
	jsonAdd(blob, "run", jsonBytes(run, run_length));
	free(run);
	const mr_seen_t *top = im_get(&d->seen, f->head);
	const hy_kept *kept = hy_get(d->histories[MR_STORED], top->name);
	uint8_t *snapshot = NULL;
	size_t snapshot_length = 0;
	if (kept != NULL && t->snapshot != NULL && t->snapshot(t->context, d->id, kept, &snapshot, &snapshot_length)) {
		jsonAdd(blob, "snapshot", jsonBytes(snapshot, snapshot_length));
		mr_hint(d, top->name, snapshot, snapshot_length, true);
		free(snapshot);
	}
	size_t n = 0;
	cborEncode(blob, NULL, 0, &n, NULL);
	uint8_t *bytes = malloc(n + 1);
	if (bytes == NULL) abort();
	cborEncode(blob, bytes, n, &n, NULL);
	jsonFree(blob);
	uint64_t c = erm_sd_add_fragment(t->sd, d->bytes, f->head, f->boundary.count ? (const uint8_t *)f->boundary.ids : NULL,
		f->boundary.count, f->checkpoints.count ? (const uint8_t *)f->checkpoints.ids : NULL, f->checkpoints.count, bytes, n);
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
	if (t->inner.get(t->inner.self, ERM_STORE_FRAGMENT, d->bytes, head, &bytes, &length) != 1) return;
	record_t r;
	bool ok = record(t, ERM_STORE_FRAGMENT, bytes != NULL ? bytes : none, length, &r);
	erm_host_free(bytes);
	if (!ok) return;
	contents_t got;
	if (contents(d->bytes, r.blob != NULL ? r.blob : none, r.length, &got) == 0) {
		im_map reached = {0};
		reach(head, &got, &reached);
		for (size_t i = 0; i < reached.slots; i++)
			if (reached.used[i]) t->inner.remove(t->inner.self, ERM_STORE_COMMIT, d->bytes, im_key(&reached, i));
		im_free(&reached);
		contents_free(&got);
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
	mr_doc *d = mr_document(t->mailroom, j->tree);
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
		t->inner.list(t->inner.self, kind, d->bytes, collect, &ids);
		for (size_t n = 0; n < ids.count; n++) {
			uint8_t *bytes = NULL;
			size_t length = 0;
			if (t->inner.get(t->inner.self, kind, d->bytes, ids.ids[n], &bytes, &length) != 1) continue;
			job *j = job_new(J_TAKE, d);
			j->record = kind;
			memcpy(j->tree, d->bytes, 32);
			j->bytes = mr_copy(bytes ? bytes : none, length);
			j->length = length;
			erm_host_free(bytes);
			next(t, j);
		}
		free(ids.ids);
	}
	next(t, build_job(d, NULL, 0));
}

// starting: what the store holds, taken in before anything else, each tree; lazy: only listed, and
// the trees of the documents followed before this taken in
static void load(sb_stack *t) {
	collected_t trees = {0};
	t->inner.list(t->inner.self, ERM_STORE_TREE, NULL, collect, &trees);
	for (size_t i = 0; i < trees.count; i++) {
		if (!t->lazy) load_doc(t, mr_document(t->mailroom, trees.ids[i]));
		else {
			im_set(&t->trees, trees.ids[i], SET);
			mr_doc *d = mr_find(t->mailroom, trees.ids[i]);
			if (d != NULL && SBD(d)->follow_later) load_doc(t, d);
		}
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
	subscribe(t, d->bytes);
	fetch(t, d, F_FOLLOW, 0);
}

typedef enum { STEP_DONE, STEP_WAIT } step_t;


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
	case J_HEAR: {
		uint8_t who[SL_KEY];
		mr_peer(j->from, who);
		mr_hear(j->d, j->bytes, j->length, who);
		return STEP_DONE;
	}
	case J_GATHER: {
		size_t length;
		uint8_t *all = gather(t, j, &length);
		if (all == NULL) return STEP_DONE;
		if (!j->channel) {
			uint8_t who[SL_KEY];
			mr_peer(j->from, who);
			mr_hear(j->d, all, length, who);
		} else {
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
	uint8_t(*ids)[32];
	if (!mr_handed(d, k, sealed, length, s, &ids)) {
		free(sealed);
		t->cur.state = 3;
		return;
	}
	memcpy(t->cur.stored, s, 32);
	uint64_t c = erm_sd_add_commit(t->sd, d->bytes, s, k->parents_length ? (const uint8_t *)ids : NULL, k->parents_length,
		sealed, length);
	free(ids);
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
				uint64_t c = publish(t, it->d->bytes, bytes, size, false);
				free(bytes);
				if (c == 0) cur->state = 3;
				else call(t, c, C_PUBLISH, cur), cur->state = 1;
			} else if (it->layer == MR_STORED) store(t, it);
			else {
				// an ephemeral commit of this device's: closed (unlocked), published, as parts when over
				uint64_t c = publish(t, it->d->bytes, it->kept->bytes, it->kept->length, false);
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
	uint64_t c = erm_sd_sync(t->sd, d->bytes, 1, 0);
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
	memcpy(j->tree, p->d->bytes, 32);
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
			uint64_t again = erm_sd_sync(t->sd, f->d->bytes, 1, 0);
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
	mr_doc *d = mr_find(t->mailroom, topic);
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

// what Subduction may store (its admission: allows, allows_fragment), the record decoded and its blob,
// put just before it, read. One not admitted is refused (the save fails), its blob let go of too
static bool admits(sb_stack *t, int kind, const uint8_t tree[32], const uint8_t *bytes, size_t length) {
	record_t r;
	if (!record(t, kind, bytes, length, &r)) return false;
	mr_doc *d = mr_document(t->mailroom, tree);
	const uint8_t *blob = r.blob != NULL ? r.blob : none;
	bool ok = kind == ERM_STORE_COMMIT
		? allows(d, r.rec.id, blob, r.length)
		: allows_fragment(d, r.rec.id, (const uint8_t(*)[32])r.rec.parents, r.rec.parentCount,
			  r.rec.checkpoints != NULL ? r.rec.checkpoints : none, r.rec.checkpointCount, blob, r.length);
	if (!ok) t->inner.remove(t->inner.self, ERM_STORE_BLOB, NULL, r.rec.digest);
	record_free(&r);
	return ok;
}

static int saved(void *self, int kind, const uint8_t *tree, const uint8_t id[32], const uint8_t *bytes, size_t length) {
	sb_stack *t = self;
	if ((kind == ERM_STORE_COMMIT || kind == ERM_STORE_FRAGMENT) && !admits(t, kind, tree, bytes, length)) return -1;
	int r = t->inner.put(t->inner.self, kind, tree, id, bytes, length);
	if (r != 0 || (kind != ERM_STORE_COMMIT && kind != ERM_STORE_FRAGMENT)) return r;
	call_kind waits = kind == ERM_STORE_COMMIT ? C_PUT : C_PUT_FRAGMENT;
	for (size_t i = 0; i < t->call_count; i++) {
		if (t->calls[i].kind != waits) continue;
		put_t *p = t->calls[i].what;
		if (memcmp(p->d->bytes, tree, 32) == 0 && memcmp(p->head, id, 32) == 0) p->saw = true;
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
		im_free(&s->broken);
		mr_order_free(&s->broken_order);
		free(s);
		d->stack = NULL;
	}
	im_free(&t->trees);
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
	else if (t->lazy && !SBD(d)->loaded && im_has(&t->trees, d->bytes)) {
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
	t->want = erm_sd_commits(t->sd, d->bytes);
	for (int round = 0; round < 10000 && !t->answered; round++) sb_run(t);
	*out = t->found;
	t->found = NULL;
	size_t n = t->found_count;
	t->found_count = 0;
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

// the harnesses' hooks (subduction_conformance_hook.h), only in their builds
#ifdef CONFORMANCE_HOOK
#include "subduction_conformance_hook.c"
#endif
