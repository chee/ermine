// the host (host.h): an ermine (ermine/system's es_create) over places at the root "root", with the
// den's trie of other dens ("away": host.ts' world: other dens' things placed in) beside the
// processes' rows, in a view of its places. a pulse is asked for soon (host_settle runs it); a
// process is a scope and a row, as es_start makes it
#include "host.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ermine/processes/c/processes.h"

static struct {
	es_ermine *e;
	pl *places;
	pr_processes rows, away;
	const pl_contributor *walk[3];
	struct {
		void (*f)(void *);
		void *data;
	} *queue;
	size_t qn, qcap, qhead;
} w;

static void schedule(void *ctx, void (*f)(void *), void *data) {
	(void)ctx;
	if (w.qn == w.qcap) {
		w.qcap = w.qcap ? w.qcap * 2 : 16;
		w.queue = realloc(w.queue, w.qcap * sizeof *w.queue);
		if (w.queue == NULL) abort();
	}
	w.queue[w.qn].f = f, w.queue[w.qn].data = data, w.qn++;
}

extern int getenv_trace;
int64_t den_clock(void);
void host_settle(void) {
	while (w.qhead < w.qn) {
		size_t i = w.qhead++;
		int64_t t = getenv_trace ? den_clock() : 0;
		w.queue[i].f(w.queue[i].data);
		if (getenv_trace && den_clock() - t > 20)
			printf("trace: a job took %lld ms\n", (long long)(den_clock() - t));
	}
	w.qn = w.qhead = 0;
}

void host_pulse_soon(void) { es_queue_pulse(w.e); }

host_world host_get(void) {
	es_ermine *e = w.e;
	return (host_world){e->scheduler, e->table, w.places, e->scopes, e->sites, e->host_scope, schedule, e,
		es_host_context(e)};
}

void host_init(void) {
	static sc_pair actor;
	actor = (sc_pair){"actor", op_str("cardputer")};
	// no policy: all allowed
	es_options o = {.schedule = schedule, .root = HOST_ROOT, .info = &actor, .ninfo = 1};
	int code = es_create(&o, &w.e);
	if (code) {
		fprintf(stderr, "host: es_create: %s %s\n", es_code_name(code), es_thrown()->message);
		abort();
	}
	// the processes' rows, the den's away trie, then children
	pr_processes_init(&w.rows, tb_string(HOST_ROOT));
	pr_trie_init(&w.away, "away", tb_string(HOST_ROOT), "away");
	w.walk[0] = &w.rows.contributor, w.walk[1] = &w.away.contributor, w.walk[2] = &pl_children;
	w.places = pl_view(w.e->places, tb_string(HOST_ROOT), w.walk, 3);
}

es_context *host_start(const char *name, host_program program, void *ctx) {
	return host_start_at(name, "programs", program, ctx);
}

es_context *host_start_at(const char *name, const char *folder, host_program program, void *ctx) {
	char at[160];
	snprintf(at, sizeof at, "/%s/%s", folder, name);
	es_started *s;
	es_refused no = {0};
	int code = es_start(w.e, program, ctx, es_text(at), NULL, &s, &no);
	if (code) {
		fprintf(stderr, "host: %s: %s %s\n", name, es_code_name(code), es_thrown()->message);
		es_refused_free(&no);
		return NULL;
	}
	host_settle();
	return es_get_process_context(w.e, s->process);
}
