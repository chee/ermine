// steady use: what each row does, again and again, levels off. leaks (conformance/leaks.sh) sees
// only what is lost at es_close; this sees what is held while the ermine runs: a scope, a handle,
// a view or a record kept for each round, where the reference's WeakMaps let each go [chee 10-26:
// "the C should "garbage collect" via something like a weakmap"]. each row on an ermine of its
// own: WARM rounds, then two windows of ROUNDS: the first's most in use over where it began, and
// the second's over the first's, each a round; the second must be under LIMIT. prints both; exits 1
// when a row grows. the counts: the allocator's (macOS' zone statistics, glibc's mallinfo2);
// elsewhere nothing is measured and every row passes
#include "ermine.h"

#include <stdio.h>

#if defined(__APPLE__)
#include <malloc/malloc.h>
#include <unistd.h>
// the nano zone counts what it holds for its size classes as in use: its numbers wander by
// hundreds of kilobytes. off (before the first malloc: the variable, then this program again), the
// counts are the blocks'
static void counted(char **argv) {
	const char *nano = getenv("MallocNanoZone");
	if (nano != NULL && strcmp(nano, "0") == 0) return;
	setenv("MallocNanoZone", "0", 1);
	execv(argv[0], argv);
}
static size_t used(void) {
	malloc_statistics_t s;
	malloc_zone_statistics(NULL, &s);
	return s.size_in_use;
}
#define MEASURED 1
#elif defined(__GLIBC__) && (__GLIBC__ > 2 || (__GLIBC__ == 2 && __GLIBC_MINOR__ >= 33))
#include <malloc.h>
static void counted(char **argv) { (void)argv; }
static size_t used(void) {
	struct mallinfo2 m = mallinfo2();
	return m.uordblks + m.hblkhd;
}
#define MEASURED 1
#else
static void counted(char **argv) { (void)argv; }
static size_t used(void) { return 0; }
#define MEASURED 0
#endif

// STEADY_ROUNDS: another window (WARM as long)
static long WARM = 8000, ROUNDS = 8000;
// bytes a round, in the second window: a map doubling once in it is well under
#define LIMIT 2.0

#define CHECK(x) \
	do { \
		if (!(x)) { \
			fprintf(stderr, "%s:%d: %s (%s)\n", __FILE__, __LINE__, #x, \
				es_thrown()->message ? es_thrown()->message : ""); \
			exit(1); \
		} \
	} while (0)

// what a memo does each run, beside reading /a: the row's
typedef enum {
	IN_NOTHING,
	IN_GET_NODE,
	IN_READ_CHILDREN,
	IN_READ_ALL,
	IN_EXPLAIN,
	IN_PIPE,
	IN_TEARDOWN,
} in_memo;

typedef struct {
	es_ermine *e;
	es_context *host;
	es_started *started;
	in_memo memo;
} world;

static void noop_teardown(void *ctx, const char *why) { (void)ctx, (void)why; }
static int noop_tell(es_context *c, void *ctx, const es_watched *w) {
	(void)c, (void)ctx, (void)w;
	return 0;
}

static es_out memo_fn(es_context *c, void *ctx, const op_value *previous) {
	(void)previous;
	world *w = ctx;
	const op_value *v;
	int code = es_read(c, es_on_path(es_text("/a")), NULL, 0, &v);
	if (code) return es_out_code(code);
	switch (w->memo) {
	case IN_NOTHING: break;
	case IN_GET_NODE: {
		es_handle *h;
		CHECK(es_get_node(c, es_text("/a"), &h) == 0);
		break;
	}
	case IN_READ_CHILDREN: {
		es_children ch;
		CHECK(es_read_children(c, es_on_path(es_text("/dir")), &ch) == 0);
		es_children_free(&ch);
		break;
	}
	case IN_READ_ALL: {
		es_versions vs;
		CHECK(es_read_all(c, es_on_path(es_text("/a")), NULL, 0, &vs) == 0);
		es_versions_free(&vs);
		break;
	}
	case IN_EXPLAIN: {
		es_explained *x = NULL;
		CHECK(es_explain(c, es_on_path(es_text("/a")), NULL, 0, &x) == 0);
		es_explained_free(x);
		break;
	}
	case IN_PIPE: {
		es_pipe_options o = {.tell = noop_tell};
		es_handle *h;
		CHECK(es_pipe(c, es_on_path(es_text("/dir")), &o, &h) == 0);
		break;
	}
	case IN_TEARDOWN: CHECK(es_add_teardown(c, noop_teardown, NULL) == 0); break;
	}
	return es_out_of(v ? op_ref((op_value *)v) : NULL);
}

static es_out act_fn(es_context *c, void *ctx, const op_value *const *args, size_t n) {
	(void)c, (void)ctx, (void)args, (void)n;
	return es_out_of(op_num(1));
}

static es_out setup(es_context *c, void *ctx) {
	es_handle *h;
	int code = es_create_memo(c, es_text("m"), memo_fn, ctx, NULL, &h);
	CHECK(code == 0 || code == ES_PENDING);
	CHECK(es_create_action(c, es_text("act"), act_fn, NULL, &h) == 0);
	return es_out_of(NULL);
}

static void start(world *w) {
	es_refused no = {0};
	CHECK(es_start(w->e, setup, w, es_text("/code/p"), NULL, &w->started, &no) == 0);
}

static void make(world *w, in_memo memo) {
	*w = (world){.memo = memo};
	CHECK(es_create(&(es_options){0}, &w->e) == 0);
	w->host = es_host_context(w->e);
	es_handle *h;
	op_value *zero = op_num(0);
	CHECK(es_ensure_node(w->host, es_text("/a"), zero, &h) == 0);
	CHECK(es_ensure_node(w->host, es_text("/dir"), NULL, &h) == 0);
	for (int i = 0; i < 5; i++) {
		char p[32];
		snprintf(p, sizeof p, "/dir/k%d", i);
		CHECK(es_ensure_node(w->host, es_text(p), zero, &h) == 0);
	}
	op_free(zero);
	start(w);
	es_pulse(w->host);
}

// /a written: the memo runs again
static void write_a(world *w, long i) {
	op_value *v = op_num((double)i);
	op_patch p = {.has_value = 1, .value = v};
	CHECK(es_patch(w->host, es_on_path(es_text("/a")), &p, 1) == 0);
	op_free(v);
}

typedef enum {
	ROW_PATCH_READ,
	ROW_GET_NODE_HOST,
	ROW_GET_NODE_MEMO,
	ROW_READ_CHILDREN_MEMO,
	ROW_READ_ALL_HOST,
	ROW_READ_ALL_MEMO,
	ROW_EXPLAIN_MEMO,
	ROW_PIPE_MEMO,
	ROW_TEARDOWN_MEMO,
	ROW_EXECUTE_HOST,
	ROW_ENSURE_REMOVE_HOST,
	ROW_RESTART,
	ROW_SCOPE,
	ROWS,
} row;

static const struct {
	const char *name;
	in_memo memo;
} rows[ROWS] = {
	[ROW_PATCH_READ] = {"patch + read (memo)", IN_NOTHING},
	[ROW_GET_NODE_HOST] = {"getNode (host)", IN_NOTHING},
	[ROW_GET_NODE_MEMO] = {"getNode (memo)", IN_GET_NODE},
	[ROW_READ_CHILDREN_MEMO] = {"readChildren (memo)", IN_READ_CHILDREN},
	[ROW_READ_ALL_HOST] = {"readAll (host)", IN_NOTHING},
	[ROW_READ_ALL_MEMO] = {"readAll (memo)", IN_READ_ALL},
	[ROW_EXPLAIN_MEMO] = {"explain (memo)", IN_EXPLAIN},
	[ROW_PIPE_MEMO] = {"pipe (memo)", IN_PIPE},
	[ROW_TEARDOWN_MEMO] = {"addTeardown (memo)", IN_TEARDOWN},
	[ROW_EXECUTE_HOST] = {"executeAction (host)", IN_NOTHING},
	[ROW_ENSURE_REMOVE_HOST] = {"ensureNode + remove (host)", IN_NOTHING},
	[ROW_RESTART] = {"stop + start", IN_NOTHING},
	[ROW_SCOPE] = {"scheduler: scope made, torn down", IN_NOTHING},
};

// every part at id taken out, as the host
static void remove_node(world *w, const char *id) {
	size_t n;
	const tb_entry *at = tb_at(w->e->table, tb_string(id), &n);
	char **parts = es_alloc((n + 1) * sizeof *parts);
	for (size_t i = 0; i < n; i++) parts[i] = es_dup(at[i].part.string);
	for (size_t i = 0; i < n; i++) {
		es_aim aim = {.id = id};
		CHECK(es_context_remove(w->host, parts[i], &aim) == 0);
		free(parts[i]);
	}
	free(parts);
}

static void round_of(world *w, row r, long i) {
	switch (r) {
	case ROW_GET_NODE_HOST: {
		es_handle *h;
		CHECK(es_get_node(w->host, es_text("/a"), &h) == 0);
		break;
	}
	case ROW_READ_ALL_HOST: {
		write_a(w, i);
		es_versions vs;
		CHECK(es_read_all(w->host, es_on_path(es_text("/a")), NULL, 0, &vs) == 0);
		es_versions_free(&vs);
		break;
	}
	case ROW_EXECUTE_HOST: {
		op_value *out = NULL;
		CHECK(es_execute_action(w->host, es_on_path(es_text("/code/p/act")), NULL, 0, &out) == 0);
		op_free(out);
		break;
	}
	case ROW_ENSURE_REMOVE_HOST: {
		op_value *v = op_num((double)i);
		es_handle *h;
		CHECK(es_ensure_node(w->host, es_text("/tmp"), v, &h) == 0);
		CHECK(es_remove(w->host, es_on_path(es_text("/tmp"))) == 0);
		op_free(v);
		break;
	}
	case ROW_RESTART: {
		// the stopped process's node, and the action's it placed, are data the host keeps, as the
		// reference's table does: taken out here (by id: a handle a new name each round would be kept),
		// so what is left is what the C holds of its own
		char *id = es_dup(pr_id(w->started->process));
		CHECK(es_remove(w->host, es_on_path(es_text("/code/p/act"))) == 0);
		CHECK(es_stop(w->started, NULL) == 0);
		es_started_free(w->started);
		remove_node(w, id);
		free(id);
		start(w);
		break;
	}
	case ROW_SCOPE: {
		op_value *v = op_num((double)i);
		sc_pair pair = {"call", v};
		sc_scope *o = sc_create_scope(w->e->scheduler, &pair, 1, w->e->host_scope);
		free(sc_teardown(o));
		sc_release(o);
		op_free(v);
		break;
	}
	default: write_a(w, i); break;
	}
	CHECK(es_pulse(w->host) == 0);
}

int main(int argc, char **argv) {
	counted(argv);
	const char *rounds = getenv("STEADY_ROUNDS");
	if (rounds != NULL && atol(rounds) > 0) ROUNDS = WARM = atol(rounds);
	// a row's name given: that row alone
	const char *only = argc > 1 ? argv[1] : NULL;
	int failed = 0;
	if (!MEASURED) printf("no allocator counts here: nothing measured\n");
	for (int r = 0; r < ROWS; r++) {
		if (only != NULL && strcmp(only, rows[r].name) != 0) continue;
		world w;
		make(&w, rows[r].memo);
		long i = 1;
		for (; i <= WARM; i++) round_of(&w, (row)r, i);
		// the most in use in each window, looked at every 64 rounds: what is let go of now and then
		// (a sweep) rises and falls under it, what is kept raises it window on window
		size_t at = used(), most[2] = {0, 0};
		for (int k = 0; k < 2; k++) {
			for (long j = 0; j < ROUNDS; j++, i++) {
				round_of(&w, (row)r, i);
				if (j % 64 == 0) {
					size_t u = used();
					if (u > most[k]) most[k] = u;
				}
			}
		}
		double first = ((double)most[0] - (double)at) / (double)ROUNDS,
		       second = ((double)most[1] - (double)most[0]) / (double)ROUNDS;
		int grows = MEASURED && second >= LIMIT;
		printf("%-34s %8.1f %8.1f bytes a round%s\n", rows[r].name, first, second, grows ? "  GROWS" : "");
		failed |= grows;
		CHECK(es_close(w.e) == 0);
		es_free(w.e);
	}
	return failed;
}
