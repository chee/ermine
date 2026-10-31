// tippet in C: steps, packs, the log and its stores, sync, and the http long-poll client.
// No global state, no recursion; every allocation goes through the tp_mem the caller gives.
// Spans in a decoded step point into the bytes given. Whatever tp_pack/tp_unpack make is the
// caller's to free (tp_span_free, tp_steps_free).
#ifndef TIPPET_H
#define TIPPET_H

#include <stddef.h>
#include <stdint.h>


// The one allocator: fn(ctx, p, old, size) allocates, resizes or frees (size 0); NULL if out of
// memory.
typedef struct {
	void *(*fn)(void *ctx, void *p, size_t old, size_t size);
	void *ctx;
} tp_mem;

typedef struct {
	const uint8_t *p;
	size_t n;
} tp_span;

enum {
	TP_NOMEM = -1, // the allocator said no
	TP_BOUND = -2, // past a bound
	TP_NOTSTEP = -3, // not a step, or not a pack
	TP_STORE = -4, // the store failed
	TP_NOKEY = -5, // a log with no key writes nothing
	TP_END = -6, // lamport is at its end
	TP_KEY = -7, // the store holds another key than the seed given
	TP_GONE = -8, // an http link closed: link again, with a new id
	TP_OWN = -10,
	TP_GAP = -11,
	TP_CHAIN = -12,
	TP_SIGNATURE = -14,
	TP_BEFORE = -15,
};
const char *tp_why(int code);

#define TP_WHOLE 9007199254740991ull
// the most bytes a run's steps make, all told (WIRE.md, runs)
#define TP_RUN ((size_t)1 << 24)


// One write; its spans point into the step's bytes. node, part and who are UTF-8 text.
typedef struct {
	tp_span bytes;
	const uint8_t *device; // 32
	uint64_t n;
	const uint8_t *before; // 32, or NULL at n = 1
	tp_span node, part, patches, who; // who.p NULL: none
	size_t count;
	uint64_t lamport, when;
	int relative;
	tp_span on;
	tp_span ids; // per patch: null or [after, gone] (WIRE.md, ids); p NULL: none
} tp_step;

#define TP_OWN_ID 75

int tp_step_decode(const uint8_t *bytes, size_t length, tp_step *s);
size_t tp_step_encode(const tp_step *s, uint8_t *out, size_t cap);
void tp_step_hash(const uint8_t *bytes, size_t length, uint8_t hash[32]);
size_t tp_step_node(const tp_step *s, char *out, size_t cap);
long tp_step_rest(const uint8_t device[32], tp_span node);

typedef struct {
	tp_span path, value, move;
	int ranged;
	uint64_t from, to;
} tp_patch;
int tp_patch_next(tp_span patches, size_t *at, tp_patch *p);
// how many elements a patch inserts, and a step's patches all told (WIRE.md, ids): a splice's
// string's code points or array's items
uint64_t tp_patch_made(const tp_patch *p);
uint64_t tp_step_made(const tp_step *s);
int tp_on_next(const tp_step *s, size_t *at, const uint8_t **device, uint64_t *n);


typedef struct {
	uint8_t *bytes;
	size_t *at;
	size_t count;
	size_t size, room; // the allocations' sizes
} tp_steps;
void tp_steps_free(const tp_mem *mem, tp_steps *s);

#define TP_STEPS 4096
#define TP_PATCHES 65536

typedef struct {
	uint8_t device[32];
	uint64_t n;
	uint8_t hash[32];
	uint64_t lamport, when;
} tp_prior;
int tp_prior_of(const uint8_t *bytes, size_t length, tp_prior *p);

int tp_pack(const tp_mem *mem, const tp_span *steps, size_t n, size_t max, tp_span *pack);
int tp_pack_after(const tp_mem *mem, const tp_prior *prior, const tp_span *steps, size_t n, size_t max,
	tp_span *pack);
int tp_unpack(const tp_mem *mem, tp_span pack, size_t max, tp_steps *out);
int tp_unpack_after(const tp_mem *mem, tp_span pack, size_t max, const tp_prior *prior, tp_steps *out);
int tp_pack_first(tp_span pack, uint64_t *n, int *after);
size_t tp_pack_count(tp_span pack);
void tp_span_free(const tp_mem *mem, tp_span *s);


typedef struct {
	uint8_t a[32], prefix[32], pub[32];
} tp_key;
void tp_key_of(tp_key *k, const uint8_t seed[32]);
void tp_sign(const tp_key *k, const uint8_t *m, size_t n, uint8_t sig[64]);
int tp_verify(const uint8_t device[32], const uint8_t *m, size_t n, const uint8_t sig[64]);


typedef struct {
	const uint8_t *device;
	uint64_t first, last;
} tp_at;
typedef int (*tp_read)(void *ctx, const uint8_t *record, size_t length, tp_at *at);

// Where a log keeps itself; every function returns 0 or an error code.
typedef struct tp_store {
	void *self;
	int (*load)(void *self, tp_read read, void *ctx);
	int (*append)(void *self, const uint8_t *record, size_t length, const tp_at *at);
	long (*get)(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap);
	long (*run)(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap,
		uint64_t *first, uint64_t *last);
	int (*snapshot)(void *self, const uint8_t *bytes, size_t length);
	long (*snapped)(void *self, uint8_t *out, size_t cap);
	int (*key)(void *self, const uint8_t seed[32], uint8_t key[32]);
	// Flush to disk so it survives a power cut. May be NULL.
	int (*sync)(void *self);
	void (*close)(void *self);
	// Forget: stop returning the records holding device's steps through n. May be NULL.
	long (*drop)(void *self, const uint8_t device[32], uint64_t n);
	// Store an open step of this device's. NULL means it is appended alone as a record.
	int (*open)(void *self, const uint8_t *step, size_t length, const tp_at *at);
} tp_store;

tp_store *tp_memory_store(const tp_mem *mem, size_t max);
// On disk (POSIX), like typescript/store_file.ts: dir/log, dir/open, dir/snapshot, dir/key, and an
// index rebuilt on load if missing. NULL if out of memory or dir can't be made.
tp_store *tp_file_store(const tp_mem *mem, const char *dir, size_t max);


typedef struct {
	size_t devices; // devices held (4096)
	uint64_t steps; // steps of one device's (1 << 24)
	size_t step; // bytes of one step (a run's most, 1 << 24)
} tp_limits;

typedef struct tp_log tp_log;

typedef void (*tp_told)(void *ctx, const uint8_t device[32], uint64_t from, size_t count);

typedef struct {
	tp_mem mem;
	tp_store *store; // the log's; closed with it
	// seed is the key a fresh store starts with; strict makes a store with another key an error.
	// With no seed the log writes nothing (a relay).
	const uint8_t *seed;
	int strict;
	tp_limits limits; // 0s: the defaults
	tp_told told;
	void *ctx;
} tp_log_options;

tp_log *tp_log_new(const tp_log_options *o);
void tp_log_free(tp_log *log);
// Chains are checked on load, signatures are trusted; records that don't continue are skipped.
int tp_log_load(tp_log *log);
const uint8_t *tp_log_device(const tp_log *log);
uint64_t tp_log_lamport(const tp_log *log);
tp_limits tp_log_limits(const tp_log *log);

// on is an encoded array of the step's own steps, stored as how far back from its n.
typedef struct {
	tp_span node, part, patches, who;
	uint64_t when;
	tp_span on;
	tp_span ids; // after on only; none: p NULL
} tp_write;
// Stays open in the store until its run closes (32 steps or 2048 bytes).
int tp_log_write(tp_log *log, const tp_write *w, uint64_t *n, uint64_t *lamport);

size_t tp_log_devices(const tp_log *log);
const uint8_t *tp_log_have(const tp_log *log, size_t i, uint64_t *have);
uint64_t tp_log_count(const tp_log *log, const uint8_t device[32]);
// how many elements the device's steps before step n insert (WIRE.md, ids); n past count + 1: TP_BOUND
int tp_log_seq(const tp_log *log, const uint8_t device[32], uint64_t n, uint64_t *seq);
int tp_log_prior(const tp_log *log, const uint8_t device[32], uint64_t n, tp_prior *p);
long tp_log_step(const tp_log *log, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap);
// Closes and syncs this device's open run first.
int tp_log_run(tp_log *log, const uint8_t device[32], uint64_t from, uint64_t *to, uint8_t sig[64]);
long tp_log_message(tp_log *log, const uint8_t device[32], uint64_t from, uint8_t *out, size_t cap);
// Returns the steps added or a refusal. came, if given, is stored as is when every step is new,
// otherwise only what is new is packed.
long tp_log_take(tp_log *log, const uint8_t device[32], const tp_span *steps, size_t n,
	const uint8_t sig[64], tp_span came);
int tp_log_snapshot(tp_log *log, const uint8_t *bytes, size_t length);
long tp_log_snapped(const tp_log *log, uint8_t *out, size_t cap);
// Forget: stop reading device's steps through n, so they are never sent. Survives a reload.
int tp_log_drop(tp_log *log, const uint8_t device[32], uint64_t n);


typedef struct tp_sync tp_sync;
typedef struct tp_link tp_link;

// Returns 0 if sent, 1 if sent but the link is full (wait for tp_sync_go), else the link is gone.
typedef int (*tp_send)(void *ctx, const uint8_t *bytes, size_t length);

typedef struct {
	tp_mem mem;
	tp_log *log; // its told goes to tp_sync_told (with the history's, if any)
	int relay; // live things passed to the other links
	void (*heard)(void *ctx, const uint8_t *data, size_t length);
	void (*random)(void *ctx, uint8_t *out, size_t n);
	void *ctx;
	size_t seen; // live ids remembered (1024)
	size_t max; // the most bytes of a run's steps, or a message (TP_RUN; less: runs past it refused)
} tp_sync_options;

tp_sync *tp_sync_new(const tp_sync_options *o);
void tp_sync_free(tp_sync *s);
// With many set, one link serves any number of peers (a broadcast). NULL if out of memory.
tp_link *tp_sync_link(tp_sync *s, tp_send send, void *ctx, int many);
void tp_sync_go(tp_sync *s, tp_link *l);
void tp_sync_unlink(tp_sync *s, tp_link *l);
size_t tp_sync_links(const tp_sync *s);
void tp_sync_receive(tp_sync *s, tp_link *l, const uint8_t *bytes, size_t length);
void tp_sync_told(void *ctx, const uint8_t device[32], uint64_t from, size_t count);
int tp_sync_live(tp_sync *s, const uint8_t *data, size_t length);
void tp_sync_keeper(tp_sync *s, tp_link *l);
// How many of device's steps have passed to every link (its own: to a keeper), for forgetting.
uint64_t tp_sync_passed(const tp_sync *s, const uint8_t device[32]);


// Client side of ../WIRE.md's http long-poll, with no sockets: the device makes the requests and
// hands the answers here.
//   POST url/send?<query>   body from tp_http_body; then tp_http_sent(status)
//   GET  url/recv?<query>   then tp_http_recv(status, answer)
// A sent message stays in the outbox until a send of it is answered 2xx.
typedef struct {
	tp_mem mem;
	char id[65]; // the link's id, made fresh each time it links
	uint64_t ack, sent; // the last message got; how many of the outbox's were taken
	size_t room; // room= on each request (0: none)
	uint8_t *frames;
	size_t length, cap, waiting, bytes;
	int closed;
} tp_http;

#define TP_BODY (1024 * 1024)

int tp_http_open(tp_http *h, const tp_mem *mem, const char *id, size_t room);
void tp_http_close(tp_http *h);
// Returns 0; 1 if taken but the link is full; TP_BOUND, TP_GONE (over TP_BODY unsent), TP_NOMEM.
int tp_http_send(tp_http *h, const uint8_t *message, size_t length);
size_t tp_http_query(const tp_http *h, char *out, size_t cap);
size_t tp_http_body(const tp_http *h, const uint8_t **body, size_t *count);
// Statuses: 0 ok, 1 try again later, TP_GONE (409, 410).
int tp_http_sent(tp_http *h, int status, size_t count);
int tp_http_recv(tp_http *h, int status, const uint8_t *answer, size_t length,
	void (*told)(void *ctx, const uint8_t *message, size_t length), void *ctx);

#endif
