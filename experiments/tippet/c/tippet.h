// tippet in C (../WIRE.md): steps, packs, a device's key, the log and its stores, sync, and the
// http long-poll client's framing. the graph's side (history.ts) is history.h
//
// small: no global state; every allocation through the one tp_mem a caller gives, and every
// buffer bounded (tp_limits). nothing here recurses
//
//   tp_step s; tp_step_decode(bytes, length, &s)          // 0: a step, its fields spans of bytes
//   tp_pack(&mem, steps, n, max, &pack)                   // and tp_unpack(&mem, pack, max, &steps)
//   tp_key k; tp_key_of(&k, seed); tp_sign(&k, m, n, sig)  // tp_verify(device, m, n, sig)
//   tp_store *store = tp_memory_store(&mem, max)           // or tp_file_store(&mem, dir)
//   tp_log *log = tp_log_new(&o); tp_log_load(log); tp_log_write(log, &w, &n, &lamport)
//   tp_sync *sync = tp_sync_new(&so); tp_link *l = tp_sync_link(sync, send, ctx, 0)
//   tp_sync_receive(sync, l, bytes, length)                // each message that comes on l
#ifndef TIPPET_H
#define TIPPET_H

#include <stddef.h>
#include <stdint.h>

// ---- memory

// the one allocator: p (NULL: none yet) made size bytes, old its size before; size 0 lets p go
// (NULL back). NULL back for a size past 0: no memory
typedef struct {
	void *(*fn)(void *ctx, void *p, size_t old, size_t size);
	void *ctx;
} tp_mem;

// bytes somewhere else: p NULL is none
typedef struct {
	const uint8_t *p;
	size_t n;
} tp_span;

// what goes wrong: 0 is nothing
enum {
	TP_NOMEM = -1, // the allocator said no
	TP_BOUND = -2, // past a bound
	TP_NOTSTEP = -3, // not a step, or not a pack
	TP_STORE = -4, // the store failed
	TP_NOKEY = -5, // a log with no key writes nothing
	TP_END = -6, // lamport is at its end
	TP_KEY = -7, // the store holds another key than the seed given
	TP_GONE = -8, // an http link closed: link again, with a new id
	// take's refusals (../WIRE.md runs, 1 4 5 6, and 2: a gap)
	TP_OWN = -10,
	TP_GAP = -11,
	TP_CHAIN = -12,
	TP_LAMPORT = -13,
	TP_SIGNATURE = -14,
};
// what a code is called: "own", "gap", "chain", "lamport", "signature", …
const char *tp_why(int code);

// the most a whole number is: 2^53 - 1
#define TP_WHOLE 9007199254740991ull

// ---- step

// one kept write: [device, n, before, node, part, patches, lamport, when, who?]. its fields point
// into its bytes: node, part and who as the text's bytes (UTF-8), patches as the array's whole
// encoding (count of them)
typedef struct {
	tp_span bytes;
	const uint8_t *device; // 32
	uint64_t n;
	const uint8_t *before; // 32, or NULL at n = 1
	tp_span node, part, patches, who; // who.p NULL: none
	size_t count;
	uint64_t lamport, when;
} tp_step;

// 0: the bytes are a step, its fields in *s; TP_NOTSTEP: they are not (../WIRE.md step)
int tp_step_decode(const uint8_t *bytes, size_t length, tp_step *s);
// a step's bytes from its fields (bytes not read; patches as encoded): its length, written to out
// when no more than cap
size_t tp_step_encode(const tp_step *s, uint8_t *out, size_t cap);
// blake3 of a step's bytes
void tp_step_hash(const uint8_t *bytes, size_t length, uint8_t hash[32]);

// one patch of a step's, its fields as encoded: path the array, value any (p NULL: none), move
// the map (p NULL: none)
typedef struct {
	tp_span path, value, move;
	int ranged;
	uint64_t from, to;
} tp_patch;
// patches is a step's; each call gives the next of them, *at where it is (0 to begin). 0: one in
// *p; 1: none left
int tp_patch_next(tp_span patches, size_t *at, tp_patch *p);

// ---- pack

// a run's steps, back to back: step i is bytes[at[i] .. at[i + 1])
typedef struct {
	uint8_t *bytes;
	size_t *at;
	size_t count;
	size_t size, room; // the allocations' sizes
} tp_steps;
void tp_steps_free(const tp_mem *mem, tp_steps *s);

// the most steps after the first a pack holds, and patches
#define TP_STEPS 4096
#define TP_PATCHES 65536

// a pack of n steps (each a step, n from 1, at most TP_STEPS): its bytes in *pack, made with mem,
// at most max of them. 0, TP_NOTSTEP, TP_BOUND or TP_NOMEM
int tp_pack(const tp_mem *mem, const tp_span *steps, size_t n, size_t max, tp_span *pack);
// a pack's steps, each worked out from the one before: at most max bytes of them. 0, TP_NOTSTEP
// (refused: nothing made), TP_BOUND or TP_NOMEM
int tp_unpack(const tp_mem *mem, tp_span pack, size_t max, tp_steps *out);
// a span made by tp_pack, let go
void tp_span_free(const tp_mem *mem, tp_span *s);

// ---- sign

// a device's key from its seed (RFC 8032): pub is the device
typedef struct {
	uint8_t a[32], prefix[32], pub[32];
} tp_key;
void tp_key_of(tp_key *k, const uint8_t seed[32]);
void tp_sign(const tp_key *k, const uint8_t *m, size_t n, uint8_t sig[64]);
// 1: sig is device's over m
int tp_verify(const uint8_t device[32], const uint8_t *m, size_t n, const uint8_t sig[64]);

// ---- store

// a record's steps: their device, and the n of the first and of the last. a record is a run as it
// came or as it goes, its run message (../WIRE.md messages), or a step of this device's kept alone
// until its run closes
typedef struct {
	const uint8_t *device;
	uint64_t first, last;
} tp_at;
// told each record held, in order: 1 and *at when it holds steps to keep, 0 when not
typedef int (*tp_read)(void *ctx, const uint8_t *record, size_t length, tp_at *at);

// where a log keeps itself: records appended in order, the steps among them got again by place,
// one snapshot, replaced, and the key of the device that writes here. each answers 0 or a code
typedef struct tp_store {
	void *self;
	int (*load)(void *self, tp_read read, void *ctx);
	// a record after every one before it; at: the steps it holds, in place of any held that it
	// covers; NULL: none
	int (*append)(void *self, const uint8_t *record, size_t length, const tp_at *at);
	// step n's length, or -1 (not held); its bytes into out when no more than cap, as if kept
	// alone: out of its run, unpacked
	long (*get)(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap);
	// the record holding step n: its length, or -1 (not held); its first and last; its first cap
	// bytes, at most, into out
	long (*run)(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap,
		uint64_t *first, uint64_t *last);
	// the snapshot, in place of the one before (NULL: none kept)
	int (*snapshot)(void *self, const uint8_t *bytes, size_t length);
	// the snapshot's length, or -1 (none); its bytes into out when no more than cap
	long (*snapped)(void *self, uint8_t *out, size_t cap);
	// the key held, else seed, held from now on
	int (*key)(void *self, const uint8_t seed[32], uint8_t key[32]);
	// every record appended so far on disk, through a power cut (NULL: nothing to do)
	int (*sync)(void *self);
	// all it holds let go, the store too
	void (*close)(void *self);
	// forgetting (history.h): the records holding device's steps through n no longer got, their
	// bytes left where they are: how many (NULL: it never lets any go)
	long (*drop)(void *self, const uint8_t device[32], uint64_t n);
} tp_store;

// in memory: at most max bytes of records. NULL: no memory
tp_store *tp_memory_store(const tp_mem *mem, size_t max);
// on disk (POSIX), as typescript/store_file.ts: dir/log, frames (4 bytes big-endian length, then
// the record), a frame cut short cut off when loaded; dir/snapshot, written beside it then renamed
// into place; dir/key, written once. a record at most max bytes. NULL: no memory, or dir not made
tp_store *tp_file_store(const tp_mem *mem, const char *dir, size_t max);

// ---- log

typedef struct {
	size_t devices; // devices held (4096)
	uint64_t steps; // steps of one device's (1 << 24)
	size_t step; // bytes of one step (1 << 20)
} tp_limits;

typedef struct tp_log tp_log;

// steps added: device's, from (its n) on, count of them
typedef void (*tp_told)(void *ctx, const uint8_t device[32], uint64_t from, size_t count);

typedef struct {
	tp_mem mem;
	tp_store *store; // the log's; closed with it
	// writes: steps of its own, under the store's key. seed: the key a fresh store starts with;
	// strict: a store with another is an error (TP_KEY). no seed: it writes nothing (a relay)
	const uint8_t *seed;
	int strict;
	tp_limits limits; // 0s: the defaults
	tp_told told;
	void *ctx;
} tp_log_options;

// NULL: no memory
tp_log *tp_log_new(const tp_log_options *o);
// the store let go, and all the log holds
void tp_log_free(tp_log *log);
// the key, and what the store holds, back in memory: each step's chain checked, signatures
// trusted; a record that is neither, or doesn't go on from what is held, passed over
int tp_log_load(tp_log *log);
// the device that writes here, or NULL
const uint8_t *tp_log_device(const tp_log *log);
uint64_t tp_log_lamport(const tp_log *log);
// its limits, the defaults filled in
tp_limits tp_log_limits(const tp_log *log);

// a write: node, part, patches (an array, encoded), when, who (p NULL: none)
typedef struct {
	tp_span node, part, patches, who;
	uint64_t when;
} tp_write;
// a step of this device's, lamport one past the highest seen: its n and lamport. kept alone until
// its run closes, at 32 steps or 2048 bytes since the last close
int tp_log_write(tp_log *log, const tp_write *w, uint64_t *n, uint64_t *lamport);

// the devices held: the i-th's key, and how many of its steps are held (another's: all signed)
size_t tp_log_devices(const tp_log *log);
const uint8_t *tp_log_have(const tp_log *log, size_t i, uint64_t *have);
// how many of device's steps are held
uint64_t tp_log_count(const tp_log *log, const uint8_t device[32]);
// step n of device's: its length, the bytes in out when no more than cap; -1: none
long tp_log_step(const tp_log *log, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap);
// the run with step from in it, from there: 0 and its end and sig; 1: none held, or none closed.
// this device's run still open is closed now, and its steps synced first (1: they couldn't be)
int tp_log_run(tp_log *log, const uint8_t device[32], uint64_t from, uint64_t *to, uint8_t sig[64]);
// that run as held, its run message, when it is held from from: its length, the bytes in out when
// no more than cap; -1: it isn't (pack it from from)
long tp_log_message(tp_log *log, const uint8_t device[32], uint64_t from, uint8_t *out, size_t cap);
// another's run, its steps in order and the sig over the last: the steps added, or a refusal
// (TP_OWN, TP_GAP, TP_CHAIN, TP_LAMPORT, TP_SIGNATURE) or another code. came: the run message
// they came in (p NULL: none), held as it is when every step is new; else what is new is packed
long tp_log_take(tp_log *log, const uint8_t device[32], const tp_span *steps, size_t n,
	const uint8_t sig[64], tp_span came);
// the history's snapshot into the store, in place of the one before: 0 or a code
int tp_log_snapshot(tp_log *log, const uint8_t *bytes, size_t length);
// the snapshot: its length, the bytes in out when no more than cap; -1: none
long tp_log_snapped(const tp_log *log, uint8_t *out, size_t cap);
// forgetting (history.h): device's steps through n no longer got from the store, and so never
// sent; said in a record, so a load lets them go too. 0 or a code
int tp_log_drop(tp_log *log, const uint8_t device[32], uint64_t n);

// ---- sync

// a log's steps caught up over links (typescript/sync.ts): each side says what it has (have), and
// is sent what it lacks, a run at a time, packed. steps added later go to every link that lacks
// them, but the one they came on. a run refused for good is told back (refused), and that device
// is sent no more on that link. live things are passed on, never kept. a message that isn't one
// is dropped. one push per link and device, the link's pushes taking turns a run each
typedef struct tp_sync tp_sync;
typedef struct tp_link tp_link;

// a message's bytes onto a link: 0 sent; 1 sent, but full: no more runs until tp_sync_go;
// anything else, the link is gone (let go here)
typedef int (*tp_send)(void *ctx, const uint8_t *bytes, size_t length);

typedef struct {
	tp_mem mem;
	tp_log *log; // its told goes to tp_sync_told (with the history's, if any)
	int relay; // live things passed to the other links
	// live data heard (NULL: none)
	void (*heard)(void *ctx, const uint8_t *data, size_t length);
	// n random bytes, a live id's
	void (*random)(void *ctx, uint8_t *out, size_t n);
	void *ctx;
	size_t seen; // live ids remembered (1024)
	size_t max; // the most bytes of a run's steps, or a message (1 << 24)
} tp_sync_options;

// NULL: no memory
tp_sync *tp_sync_new(const tp_sync_options *o);
// every link let go
void tp_sync_free(tp_sync *s);
// a link, told have. many: one link to any number of peers (a broadcast): what they have is not
// kept, only answered, with this device's own steps alone. NULL: no memory, or the have couldn't
// be sent
tp_link *tp_sync_link(tp_sync *s, tp_send send, void *ctx, int many);
// a link that said it was full takes runs again
void tp_sync_go(tp_sync *s, tp_link *l);
// a link let go (once nothing here is using it): what it was owed is dropped
void tp_sync_unlink(tp_sync *s, tp_link *l);
size_t tp_sync_links(const tp_sync *s);
// a message come on a link
void tp_sync_receive(tp_sync *s, tp_link *l, const uint8_t *bytes, size_t length);
// the log's told (a tp_told, ctx the sync)
void tp_sync_told(void *ctx, const uint8_t device[32], uint64_t from, size_t count);
// a live thing to every link: 0, or TP_NOMEM / TP_BOUND
int tp_sync_live(tp_sync *s, const uint8_t *data, size_t length);
// forgetting (history.h): l's other side keeps every run it is sent (galaxy), as the host knows
void tp_sync_keeper(tp_sync *s, tp_link *l);
// forgetting: how many of device's steps have passed on. another's: as many as every link has, or
// has been sent (a broadcast is sent only this device's own; one that refused them is sent no
// more); none without a link. this device's own: as many as a link to a keeper last said it holds
uint64_t tp_sync_passed(const tp_sync *s, const uint8_t device[32]);

// ---- http long-poll

// the client's side of ../WIRE.md's http long-poll, no sockets: the device makes the requests
// (esp_http_client on the Cardputer) and hands their answers here
//
//   POST url/send?<query>   body: tp_http_body's; then tp_http_sent(status)
//   GET  url/recv?<query>   then tp_http_recv(status, answer): each message, once
//
// a message sent is framed into the outbox until a send of it is answered 2xx. ack: the last
// message got; a recv answer repeats what came after it, and only the new are told
typedef struct {
	tp_mem mem;
	char id[65]; // the link's id, made fresh each time it links
	uint64_t ack, sent; // the last message got; how many of the outbox's were taken
	size_t room; // room= on each request (0: none)
	// the outbox: frames back to back, length bytes of them (cap allocated); waiting: how many
	// messages, bytes: theirs (not their lengths')
	uint8_t *frames;
	size_t length, cap, waiting, bytes;
	int closed;
} tp_http;

// a send's body, at most; what the outbox holds before it closes
#define TP_BODY (1024 * 1024)

// a link, numbered from 1. 0, or TP_BOUND (an id past 64 chars)
int tp_http_open(tp_http *h, const tp_mem *mem, const char *id, size_t room);
// what it holds let go
void tp_http_close(tp_http *h);
// a message into the outbox: 0; 1 (taken, but half a TP_BODY or more waits: a link's full,
// tp_sync_go once sent answers make it less); TP_BOUND (bigger than a body); TP_GONE (more than
// TP_BODY unsent: it closes); TP_NOMEM
int tp_http_send(tp_http *h, const uint8_t *message, size_t length);
// the query of the next request (link, ack, n, room): its length, written to out when less than cap
size_t tp_http_query(const tp_http *h, char *out, size_t cap);
// the next send's body, the outbox's first frames that fit in TP_BODY: its length (0: nothing to
// send), *count the messages in it
size_t tp_http_body(const tp_http *h, const uint8_t **body, size_t *count);
// a send answered: 0 (2xx: count messages taken); 1 (try again later); TP_GONE (409, 410)
int tp_http_sent(tp_http *h, int status, size_t count);
// a recv answered: each message past ack told, ack moved. 0; 1 (not an answer: try again later);
// TP_GONE (409, 410)
int tp_http_recv(tp_http *h, int status, const uint8_t *answer, size_t length,
	void (*told)(void *ctx, const uint8_t *message, size_t length), void *ctx);

#endif
