// host.c: ermineOS's host on today's core (host.h; PORT.md). Core 0's own
// work: the graph (api.h), the card (card/), the image, /hw from the device
// tree, the types and runners programs are found by (ermine/programs), what
// boots, the drain, which hands each turn's records to the driver that
// claimed their line, the clock, and the commands to the metal.
//
// A process is ermine/programs' (start.h): satisfy finds a program's way by
// its type (/ermine/types) and the runners in /loaders, start puts it at its
// path and runs it, and what it is given is newOS's API (create_api). What
// the host keeps for itself (/hw, /loaders, /ermine/types, the clock) is
// ephemeral, made again each boot.
//
// newOS is a den too (ermine/dens' dens.h), made at boot after /loaders, at
// /system/dens/<id> and /system/den (makeDen). Its id: the device tree's host
// as a name, then a uuid kept on the card beside sync/ (<sd>/den, made at the
// first boot; a fresh card empties sync/, not it: the machine is the same).
// It offers what /loaders holds, the same live functions: the runners
// (javascript, driver, exec, wasm, dlopen: each its form, the api its
// program is given, where it runs), the compilers clang and clang-native,
// and the display (the frame buffer) as a surface. A boot entry
// { start, runner, program } starts its program by the den (dn_start: the
// runner a path from the root, /system/den/runners/<name>; the program's
// ermine.type its form), as the image's drivers do; { start, program } is
// satisfy's, as before, and so is every start a program asks for. What the
// den started stops by dn_stop (hostKill, hostRestart); nothing stops at
// power off, as before.

#include "host.h"
#include "../../../ermine/encoding/c/json_text.h"

#include "drivers.h"
#include "drv.h"
#include "exec.h"
#include "jsc.h"
#include "dylib.h"
#include "loader.h"
#include "card/net.h"

#include "../../../extensions/programs/c/start.h"
#include "../../../extensions/subduction/c/subduction/platform.h"
#include "../../../ermine/dens/c/dens.h"
#include "../../../ermine/types/c/types.h"

#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/** how many records a line keeps while no driver has it: past that the oldest go */
#define KEEPS 64

/** the target clang-native builds for (cc.c's), in its identity */
#define NATIVE_TARGET "arm64-apple-macos11"

/** a line: its arrivals counted; while no driver has it, its newest KEEPS records, oldest first */
typedef struct Held {
	int irq;
	Json **records;
	int count, room;
	int64_t arrived, dropped; // records come, and dropped unclaimed
	bool dirty;               // the counts not yet written to /hw/irq/<n> (tick)
} Held;

/** a plane the compositor asked for (hostPlane): mapped while its node says the same memory */
typedef struct Mapped {
	char *source;
	int64_t id;
	char *node; // its node's name in /dev/<source>/planes, read first next time
	HostPlaneSaid said;
	void *mapping;
	size_t bytes;
	int64_t asked; // hostNow when last asked for: let go once not asked for a while
} Mapped;

/**
 * a process's work, counted as it runs: the CPU of its runs (its setup, its computes, the
 * handlers the host calls: an irq's, a timer's), how many, how many failed, and its writes;
 * written to its node's info "work" at most once a second, when it changed (tick)
 */
typedef struct Work {
	char *pid;
	sc_scope *scope; // NULL once torn down: the entry goes at the next tick
	int64_t cpu;     // µs
	int64_t runs, failed, writes;
	int64_t written; // hostNow at the last write
	bool dirty;
} Work;

/** a process started: its id, and start's */
typedef struct Proc {
	char *id;
	ps_process *p;
} Proc;

struct Host {
	ErmosConfig config;
	Json *dt;
	ap_os *os;
	Card *card;
	Net *net;    // the connection to /etc/sync's server (card/net.c)
	hf *functions;
	bd *builds;
	ps *programs;
	dn *den; // newOS as a den (ermine/dens): its runners, compilers and surfaces offered (makeDen); NULL: none
	ty_ids types;
	Proc *procs;
	int nprocs, procs_room;
	// processes started inside another's node: their id, and where they were asked to be
	struct { char *id; const char **at; size_t n; } *nested;
	int nnested;
	int64_t started; // µs, CLOCK_MONOTONIC, at boot
	int64_t wake;    // the earliest turn a driver asked for; 0: none
	int64_t second;  // the clock's last second written
	bool running;
	Held *held;
	int nheld;
	Mapped *mapped;
	int nmapped;
	Work **work;
	int nwork;
	// a run's start (monotonic), innermost last, for the run listeners
	int64_t runAt[16];
	int runDepth;
	ap_api *peep; // the host's reads told to no one: what the compositor opens, what the host counts
	// processes to stop (hostKill), once the part asking has returned
	char **kills;
	int nkills;
	// timers (hostAfter): when, and the handler to call
	int64_t *timerAt;
	Json **timerTo;
	int ntimers;
};

// the types programs and runners say (ty_install's list): a JavaScript program, a driver built in,
// an exec program ({argv}), a wasm module, a library for this machine (dylib.h), and what they conform to
static const ty_known TYPES[] = {
	{"public.item", NULL, NULL, NULL},
	{"public.data", (const char *const[]){"public.item", NULL}, NULL, NULL},
	{"public.content", (const char *const[]){"public.item", NULL}, NULL, NULL},
	{"public.executable", (const char *const[]){"public.item", NULL}, NULL, NULL},
	{"public.text", (const char *const[]){"public.data", "public.content", NULL}, NULL, NULL},
	{"public.source-code", (const char *const[]){"public.text", NULL}, NULL, NULL},
	{"com.netscape.javascript-source", (const char *const[]){"public.source-code", "public.executable", NULL}, (const char *const[]){".js", NULL}, NULL},
	{"public.c-source", (const char *const[]){"public.source-code", NULL}, (const char *const[]){".c", NULL}, NULL},
	{"party.chee.ermine.driver", (const char *const[]){"public.data", NULL}, NULL, NULL},
	{"party.chee.ermine.exec", (const char *const[]){"public.data", NULL}, NULL, NULL},
	{"org.webassembly.wasm", (const char *const[]){"public.data", "public.executable", NULL}, (const char *const[]){".wasm", NULL}, NULL},
	{DYLIB_TYPE, (const char *const[]){"public.data", "public.executable", NULL}, (const char *const[]){".dylib", NULL}, NULL},
};

// the runners (ermine/programs' host runners, and the den's): a name, what it takes, the api its program is
// given and where it runs (the den's ermine.runner.api and .where), its function
typedef struct {
	const char *name, *takes, *api, *where;
	hf_runner run;
} Runner;
static const Runner RUNNERS[] = {
	{"javascript", "com.netscape.javascript-source", "ermine.js", "thread", jscRun},
	{"driver", "party.chee.ermine.driver", "ermine.native", "den", driverRun},
	{"exec", "party.chee.ermine.exec", "ermine.wire", "os-process", execRun},
	{"wasm", "org.webassembly.wasm", "ermine.js", "thread", loaderRun},
};

static const ap_error *startProgram(void *ctx, const char *const *at, size_t nat, const char *const *program, size_t nprogram,
	const op_value *data, const char **id);
static const ap_error *startByDen(Host *h, const char *const *at, size_t nat, const char *const *runner, size_t nrunner,
	const char *const *program, size_t nprogram, const op_value *data, const char **id);
static void denStop(Host *h, dn_process *p);

// --- small things

static Json *parse(const char *text) {
	char *why = NULL;
	return jsonParse(text, strlen(text), &why);
}

static int64_t monotonic(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

static char *slurp(const char *path) {
	FILE *f = fopen(path, "rb");
	if (!f) return NULL;
	fseek(f, 0, SEEK_END);
	long n = ftell(f);
	fseek(f, 0, SEEK_SET);
	char *text = malloc((size_t)n + 1);
	size_t got = fread(text, 1, (size_t)n, f);
	text[got] = 0;
	fclose(f);
	return text;
}

/** the bytes base64 text holds (standard alphabet, padded or not, as the metal sends them): fresh */
static unsigned char *unbase64(const char *text, size_t *n) {
	size_t len = strlen(text);
	unsigned char *out = malloc(len * 3 / 4 + 3);
	unsigned bits = 0;
	int have = 0;
	*n = 0;
	for (const char *c = text; *c; c++) {
		const char *at = strchr("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", *c);
		if (!at || !*c) continue;
		bits = bits << 6 | (unsigned)(at - "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
		if ((have += 6) >= 8) out[(*n)++] = (unsigned char)(bits >> (have -= 8));
	}
	return out;
}

// --- this turn's memory: the API's

void *hostTemp(Host *h, size_t n) { return ap_temp(h->os, n); }
char *hostTempDup(Host *h, const char *text) { return ap_dup(h->os, text); }

ap_os *hostOs(Host *h) { return h->os; }
Card *hostCard(Host *h) { return h->card; }

struct Net *hostNet(Host *h) {
	return h->net;
}
const ErmosConfig *hostConfig(Host *h) { return &h->config; }
Json *hostTree(Host *h) { return h->dt; }
int64_t hostNow(Host *h) { return monotonic() - h->started; }

void hostWake(Host *h, int64_t at) {
	if (!h->wake || at < h->wake) h->wake = at;
}

const char *hostPid(Host *h) { return ap_pid(h->os); }

void hostKill(Host *h, const char *pid) {
	h->kills = realloc(h->kills, sizeof *h->kills * (size_t)(h->nkills + 1));
	h->kills[h->nkills++] = strdup(pid);
	hostWake(h, hostNow(h));
}

/** whether path (n names) is strictly under at (nat names) */
static bool under(const char *const *path, size_t n, const char *const *at, size_t nat) {
	if (n <= nat) return false;
	for (size_t i = 0; i < nat; i++)
		if (strcmp(path[i], at[i])) return false;
	return true;
}

/**
 * a process stopped (its runner's stop, its row, its scope), the processes started under its path first: one
 * started under another's runs at /proc/<pid>, in front where it was asked (startProgram), and that place goes
 * with the process it is in, so it goes too, as a part's children end with it. One the den started: dn_stop
 */
static void stop(Host *h, const char *pid) {
	Proc *proc = NULL;
	for (int i = 0; i < h->nprocs && !proc; i++)
		if (!strcmp(h->procs[i].id, pid)) proc = &h->procs[i];
	dn_process *by = !proc && h->den ? dn_find(h->den, pid) : NULL;
	if (!proc && !by) return;
	// its path, and the one it was asked for when it is nested itself
	const char *const *at;
	size_t nat = proc ? ps_at(proc->p, &at) : dn_process_at(by, &at);
	const char *const *asked = NULL;
	size_t nasked = 0;
	for (int i = 0; i < h->nnested; i++)
		if (!strcmp(h->nested[i].id, pid)) asked = h->nested[i].at, nasked = h->nested[i].n;
	// the ones under it, by id (stopping one takes it out of nested)
	char **kids = NULL;
	int nkids = 0;
	for (int i = 0; i < h->nnested; i++) {
		const char *const *where = h->nested[i].at;
		size_t n = h->nested[i].n;
		if (!strcmp(h->nested[i].id, pid)) continue;
		if (!under(where, n, at, nat) && !(asked && under(where, n, asked, nasked))) continue;
		kids = realloc(kids, sizeof *kids * (size_t)(nkids + 1));
		kids[nkids++] = strdup(h->nested[i].id);
	}
	for (int i = 0; i < nkids; i++) stop(h, kids[i]), free(kids[i]);
	free(kids);
	for (int i = 0; i < h->nnested; i++)
		if (!strcmp(h->nested[i].id, pid)) {
			free(h->nested[i].id);
			for (size_t k = 0; k < h->nested[i].n; k++) free((char *)h->nested[i].at[k]);
			free(h->nested[i].at);
			h->nested[i] = h->nested[--h->nnested];
			break;
		}
	if (proc) ps_stop(h->programs, proc->p);
	else denStop(h, by);
}

/** the stops asked for */
static void reap(Host *h) {
	while (h->nkills) {
		char *pid = h->kills[--h->nkills];
		stop(h, pid);
		free(pid);
	}
}

/** a list of names in a value (an attribute's), as an address for this turn (hostTemp); NULL if it is not one */
static const char *const *namesOf(Host *h, const op_value *v, size_t *n) {
	if (!v || v->type != OP_LIST) return NULL;
	const char **names = hostTemp(h, sizeof *names * (v->count + 1));
	for (size_t i = 0; i < v->count; i++) {
		if (v->items[i]->type != OP_STR) return NULL;
		names[i] = hostTempDup(h, v->items[i]->str);
	}
	names[v->count] = NULL;
	*n = v->count;
	return names;
}

/** a process the den started, stopped and started again by the den: its runner and program as its node says them */
static const ap_error *restartByDen(Host *h, dn_process *p) {
	const nd_entry *e = tb_get(ap_table(h->os), tb_string("attributes"), tb_string(dn_process_id(p)));
	const op_value *runner = e && e->value && e->value->type == OP_MAP ? op_get(e->value, DN_RUNNER) : NULL;
	const op_value *program = e && e->value && e->value->type == OP_MAP ? op_get(e->value, DN_PROGRAM) : NULL;
	size_t nr = 0, np = 0;
	const char *const *by = runner && runner->type == OP_MAP ? namesOf(h, op_get(runner, "at"), &nr) : NULL;
	const char *const *path = program && program->type == OP_MAP ? namesOf(h, op_get(program, "at"), &np) : NULL;
	if (!by || !path) return ap_error_new(h->os, "not-a-process", "its node says no runner or no program");
	const char *const *where;
	size_t nwhere = dn_process_at(p, &where);
	const char **copy = hostTemp(h, sizeof *copy * (nwhere + 1));
	for (size_t i = 0; i < nwhere; i++) copy[i] = hostTempDup(h, where[i]);
	denStop(h, p);
	const char *id = NULL;
	return startByDen(h, copy, nwhere, by, nr, path, np, NULL, &id);
}

const ap_error *hostRestart(Host *h, const char *const *address, size_t n) {
	const ap_item *it = ap_first(ap_host(h->os), address, n);
	Proc *proc = NULL;
	for (int i = 0; it && i < h->nprocs && !proc; i++)
		if (!strcmp(h->procs[i].id, it->id)) proc = &h->procs[i];
	dn_process *by = !proc && it && h->den ? dn_find(h->den, it->id) : NULL;
	if (by) return restartByDen(h, by);
	if (!proc) return ap_error_new(h->os, "not-a-process", "no process there");
	// its program and path, from its pin, before it goes
	const nd_entry *e = tb_get(ap_table(h->os), tb_string("attributes"), tb_string(proc->id));
	const op_value *pin = e && e->value && e->value->type == OP_MAP ? op_get(e->value, PR_PIN) : NULL;
	const op_value *program = pin && pin->type == OP_MAP ? op_get(pin, "program") : NULL;
	const op_value *at = program && program->type == OP_MAP ? op_get(program, "at") : NULL;
	if (!at || at->type != OP_LIST) return ap_error_new(h->os, "not-a-process", "its pin says no program");
	const char **path = hostTemp(h, sizeof *path * (at->count + 1));
	for (size_t i = 0; i < at->count; i++) path[i] = at->items[i]->type == OP_STR ? hostTempDup(h, at->items[i]->str) : "";
	const char *const *where;
	size_t nwhere = ps_at(proc->p, &where);
	const char **copy = hostTemp(h, sizeof *copy * (nwhere + 1));
	for (size_t i = 0; i < nwhere; i++) copy[i] = hostTempDup(h, where[i]);
	ps_stop(h->programs, proc->p);
	const char *id = NULL;
	return startProgram(h, copy, nwhere, path, at->count, NULL, &id);
}

void hostAfter(Host *h, int64_t at, Json *address) {
	h->timerAt = realloc(h->timerAt, sizeof *h->timerAt * (size_t)(h->ntimers + 1));
	h->timerTo = realloc(h->timerTo, sizeof *h->timerTo * (size_t)(h->ntimers + 1));
	h->timerAt[h->ntimers] = at;
	h->timerTo[h->ntimers++] = address;
	hostWake(h, at);
}

void hostCommand(Host *h, const Json *command) {
	char *text = jsonPrint(command);
	h->config.command(h->config.data, text);
	free(text);
}

void hostSay(Host *h, const char *format, ...) {
	(void)h;
	va_list ap;
	va_start(ap, format);
	fprintf(stderr, "[os] ");
	vfprintf(stderr, format, ap);
	fputc('\n', stderr);
	va_end(ap);
}

static void said(void *ctx, const char *line) {
	hostSay(ctx, "%s", line);
}

// the card's network (card_host): net.c's, once it is open
static void netSend(void *ctx, const tp_out *out) {
	Host *h = ctx;
	if (h->net) netOut(h->net, out);
}

static void netCounts(void *ctx, size_t followed, int made, int stored, int heard) {
	Host *h = ctx;
	if (h->net) netCount(h->net, followed, made, stored, heard);
}

bool hostFailed(Host *h, const ap_error *e, const char *doing) {
	if (!e) return false;
	hostSay(h, "%s: %s%s%s", doing, e->code ? e->code : "thrown", e->message ? ": " : "", e->message ? e->message : "");
	return true;
}

// --- planes: found by their nodes, /dev/<source>/planes/<name> {id, w, h, stride?, shm | file, offset?}

/** what the node at /dev/<source>/planes/<name> says, if a plane with that id */
static bool planeNode(Host *h, const char *source, const char *name, int64_t id, HostPlaneSaid *out) {
	size_t n;
	const op_value *v = ap_read(h->peep, hostPath(h, &n, "dev", source, "planes", name, NULL), n);
	const op_value *vid = v && v->type == OP_MAP ? op_get(v, "id") : NULL;
	if (!vid || vid->type != OP_NUM || (int64_t)vid->num != id) return false;
	const op_value *shm = op_get(v, "shm"), *file = op_get(v, "file"), *w = op_get(v, "w"), *hh = op_get(v, "h"), *stride = op_get(v, "stride"), *offset = op_get(v, "offset");
	const op_value *said = shm && shm->type == OP_STR ? shm : file && file->type == OP_STR ? file : NULL;
	if (!said || !w || w->type != OP_NUM || !hh || hh->type != OP_NUM || w->num < 1 || hh->num < 1 || strlen(said->str) >= sizeof out->name) return false;
	snprintf(out->name, sizeof out->name, "%s", said->str);
	out->file = said == file;
	out->w = (int)w->num, out->h = (int)hh->num;
	out->stride = stride && stride->type == OP_NUM && stride->num >= w->num ? (int)stride->num : out->w;
	out->offset = offset && offset->type == OP_NUM && offset->num > 0 ? (size_t)offset->num : 0;
	return true;
}

/** the same, the node found among the source's planes; *node its name (the turn's) */
static bool planeFound(Host *h, const char *source, int64_t id, HostPlaneSaid *out, const char **node) {
	if (!source) return false;
	size_t n;
	ap_namelist names = { 0 };
	if (ap_names(h->peep, hostPath(h, &n, "dev", source, "planes", NULL), n, &names)) return false;
	for (size_t i = 0; i < names.n; i++)
		if (planeNode(h, source, names.names[i], id, out)) {
			if (node) *node = names.names[i];
			return true;
		}
	return false;
}

bool hostPlaneSaid(Host *h, const char *source, int64_t id, HostPlaneSaid *out) {
	return planeFound(h, source, id, out, NULL);
}

void *hostPlaneMap(const HostPlaneSaid *p, size_t *bytes) {
	int fd = p->file ? open(p->name, O_RDWR) : shm_open(p->name, O_RDWR, 0);
	if (fd < 0) return NULL;
	struct stat st;
	void *mapping = MAP_FAILED;
	if (!fstat(fd, &st) && st.st_size > 0) mapping = mmap(NULL, (size_t)st.st_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	close(fd);
	if (mapping == MAP_FAILED) return NULL;
	*bytes = (size_t)st.st_size;
	return mapping;
}

void hostPlaneUnmap(void *mapping, size_t bytes) {
	if (mapping) munmap(mapping, bytes);
}

static void unmapped(Host *h, int i) {
	hostPlaneUnmap(h->mapped[i].mapping, h->mapped[i].bytes);
	free(h->mapped[i].source);
	free(h->mapped[i].node);
	h->mapped[i] = h->mapped[--h->nmapped];
}

bool hostPlane(Host *h, const char *source, int64_t id, HostPlane *out) {
	int at = -1;
	for (int i = 0; source && i < h->nmapped && at < 0; i++)
		if (h->mapped[i].id == id && !strcmp(h->mapped[i].source, source)) at = i;
	// its node, by the name it had last time; else found among the source's planes
	HostPlaneSaid said;
	const char *node = NULL;
	if (!(at >= 0 && planeNode(h, source, h->mapped[at].node, id, &said)) && !planeFound(h, source, id, &said, &node)) {
		if (at >= 0) unmapped(h, at);
		return false;
	}
	if (at >= 0 && (strcmp(h->mapped[at].said.name, said.name) || h->mapped[at].said.file != said.file)) {
		unmapped(h, at);
		at = -1;
	}
	if (at < 0) {
		size_t bytes = 0;
		void *mapping = hostPlaneMap(&said, &bytes);
		if (!mapping) return false;
		h->mapped = realloc(h->mapped, sizeof *h->mapped * (size_t)(h->nmapped + 1));
		at = h->nmapped++;
		h->mapped[at] = (Mapped){ .source = strdup(source), .id = id, .mapping = mapping, .bytes = bytes };
	}
	Mapped *m = &h->mapped[at];
	if (node && (!m->node || strcmp(m->node, node))) {
		free(m->node);
		m->node = strdup(node);
	}
	m->said = said;
	m->asked = hostNow(h);
	// never past the memory: what the node says must fit what was mapped
	if (said.offset + (size_t)said.stride * (size_t)said.h * 4 > m->bytes) return false;
	*out = (HostPlane){ (const uint32_t *)((const char *)m->mapping + said.offset), said.w, said.h, said.stride };
	return true;
}

/** the planes not asked for in a while let go: a plane whose node went, or whose layer did */
static void planesSweep(Host *h) {
	int64_t now = hostNow(h);
	for (int i = 0; i < h->nmapped;)
		if (now - h->mapped[i].asked > 2000000) unmapped(h, i);
		else i++;
}

// --- work: what each process's runs cost, counted where the host sees them run

static Work *workOfPid(Host *h, const char *pid) {
	for (int i = 0; pid && i < h->nwork; i++)
		if (!strcmp(h->work[i]->pid, pid)) return h->work[i];
	return NULL;
}

/** the process a scope is in: the scope itself, or one above it (a computed node's is under its process's) */
static Work *workOfScope(Host *h, const sc_scope *o) {
	for (; o; o = sc_scope_parent(o))
		for (int i = 0; i < h->nwork; i++)
			if (h->work[i]->scope == o) return h->work[i];
	return NULL;
}

static void worked(Work *w, int64_t cpu, bool failed) {
	w->cpu += cpu;
	w->runs++;
	if (failed) w->failed++;
	w->dirty = true;
}

/** the scope's teardown: the process is gone; its entry goes at the next tick */
static char *workGone(void *data) {
	Work *w = data;
	w->scope = NULL;
	return NULL;
}

static void runStarted(sc_computer *c, unsigned n, int rank, void *data) {
	(void)c, (void)n, (void)rank;
	Host *h = data;
	if (h->runDepth < 16) h->runAt[h->runDepth] = monotonic();
	h->runDepth++;
}

static void runEnded(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads, size_t nreads, const sc_more *more, void *data) {
	(void)n, (void)reads, (void)nreads, (void)more;
	Host *h = data;
	if (h->runDepth > 0) h->runDepth--;
	Work *w = workOfScope(h, c);
	if (w && h->runDepth < 16) worked(w, monotonic() - h->runAt[h->runDepth], ended == SC_FAIL);
}

/** a write (a mark of keys) by whatever scope is open: the process's */
static void marked(const void *const *keys, size_t nkeys, sc_run *run, sc_computer *const *due, size_t ndue, uint64_t tick, void *data) {
	(void)keys, (void)run, (void)due, (void)ndue, (void)tick;
	Host *h = data;
	if (!nkeys) return;
	Work *w = workOfScope(h, sc_get_current_scope(ap_scheduler(h->os)));
	if (w) w->writes++, w->dirty = true;
}

/** a handler the host called, at ./on/<name> of a process's node: charged to that process */
static void charge(Host *h, const char *const *address, size_t n, int64_t cpu, bool failed) {
	if (n < 3) return;
	const ap_item *it = ap_first(h->peep, address, n - 2);
	Work *w = it ? workOfPid(h, it->id) : NULL;
	if (w) worked(w, cpu, failed);
}

/** a runner's run (the setup) timed, and charged to the process whose api it was given */
typedef struct {
	Host *h;
	hf_runner run;
} Running;

static hf_run running(const op_value *code, void *api, void *data) {
	Running *r = data;
	int64_t at = monotonic();
	hf_run out = r->run(code, api, r->h);
	ap_api *a = api;
	Work *w = a ? workOfPid(r->h, a->self) : NULL;
	if (w) worked(w, monotonic() - at, out.error != NULL);
	return out;
}

/** each process's work written to its node, once a second at most, when it changed; the gone let go */
static void workFlush(Host *h) {
	int64_t now = hostNow(h);
	int k = 0;
	for (int i = 0; i < h->nwork; i++) {
		Work *w = h->work[i];
		if (!w->scope) {
			free(w->pid);
			free(w);
			continue;
		}
		h->work[k++] = w;
		if (!w->dirty || now - w->written < 1000000) continue;
		w->dirty = false;
		w->written = now;
		op_value *v = op_map();
		op_set(v, "cpu", op_num((double)w->cpu));
		op_set(v, "runs", op_num((double)w->runs));
		op_set(v, "failed", op_num((double)w->failed));
		op_set(v, "writes", op_num((double)w->writes));
		const char *address[] = { AP_ID, w->pid, NULL };
		op_patch p = valWhole(v);
		hostFailed(h, ap_set(ap_host(h->os), address, 2, "work", &p, 1, NULL, NULL), "work");
		op_free(v);
	}
	h->nwork = k;
}

// --- addresses and the small reads and writes every host writes (AFFORDANCES.md)

const char *const *hostPath(Host *h, size_t *n, const char *first, ...) {
	va_list ap;
	size_t count = 0;
	va_start(ap, first);
	for (const char *s = first; s; s = va_arg(ap, const char *)) count++;
	va_end(ap);
	const char **names = hostTemp(h, sizeof *names * (count + 1));
	va_start(ap, first);
	size_t i = 0;
	for (const char *s = first; s; s = va_arg(ap, const char *)) names[i++] = hostTempDup(h, s);
	va_end(ap);
	names[count] = NULL;
	*n = count;
	return names;
}

const char *const *hostPathOf(Host *h, const Json *list, size_t *n) {
	if (!jsonIsArray(list)) return NULL;
	size_t size = sizeof(char *) * (size_t)(list->array.count + 1);
	const char **names = hostTemp(h, size);
	for (int i = 0; i < list->array.count; i++) {
		const char *t = jsonText(list->array.items[i]);
		if (!t) return NULL;
		names[i] = hostTempDup(h, t);
	}
	names[list->array.count] = NULL;
	*n = (size_t)list->array.count;
	return names;
}


const ap_item *hostLook(ap_api *api, const char *const *address, size_t n) {
	return ap_first(api, address, n);
}

const op_value *hostRead(ap_api *api, const char *const *address, size_t n) {
	return ap_read(api, address, n);
}

const char *hostPut(Host *h, ap_api *api, const char *parent, const char *name, const op_value *value, bool ephemeral) {
	(void)h;
	return ap_put(api, parent, name, value, ephemeral);
}

const ap_error *hostSnap(ap_api *api, const char *const *address, size_t n, const op_value *value) {
	return ap_snap(api, address, n, value);
}

Json *hostHere(Host *h, const char *pid) {
	size_t n;
	const char *const *at = ap_here(h->os, pid, &n);
	if (!at) return NULL;
	Json *out = jsonArray();
	for (size_t i = 0; i < n; i++) jsonPush(out, jsonString(at[i]));
	return out;
}

/** the id at an address from the root, NULL if none */
static const char *idAt(Host *h, const char *const *address, size_t n) {
	const ap_item *it = ap_first(ap_host(h->os), address, n);
	return it ? it->id : NULL;
}

/** a node of the host's own (ephemeral, its id the host's) made and placed by its parent's address */
static const char *own(Host *h, const char *const *at, size_t nat, const char *name, const char *id, const op_value *value) {
	ap_api *api = ap_host(h->os);
	const char *parent = nat ? idAt(h, at, nat) : pl_root(ap_places(h->os)).string;
	if (!parent) {
		hostSay(h, "make %s: nothing at its parent", name);
		return NULL;
	}
	char doing[256];
	snprintf(doing, sizeof doing, "make %s", id);
	const char *made = NULL;
	if (hostFailed(h, ap_create(api, value, id, 1, &made), doing)) return NULL;
	ap_items items = { 0 };
	if (!ap_children(api, at, nat, name, &items))
		for (size_t i = 0; i < items.n; i++)
			if (!strcmp(items.items[i].id, made)) return made;
	if (hostFailed(h, ap_insert(api, parent, name, made, NULL, NULL), doing)) return NULL;
	return made;
}

/** an attribute of the node at an address written, unless it is so already */
static void attribute(Host *h, const char *const *address, size_t n, const char *name, const op_value *value) {
	ap_api *api = ap_host(h->os);
	ap_items items;
	if (!ap_info(api, address, n, name, &items) && items.n && items.items[0].nversions && valEqual(items.items[0].versions[0].content, value)) return;
	op_patch p = valWhole(value);
	char doing[256];
	snprintf(doing, sizeof doing, "info %s", name);
	hostFailed(h, ap_set(api, address, n, name, &p, 1, NULL, NULL), doing);
}

// --- processes: ermine/programs' start, found by satisfy

/** newOS's API for a process's scope and path, its work counted from its first run */
static ap_api *processApi(Host *h, sc_scope *scope, const char *pid, const char *const *at, size_t nat) {
	ap_goes_with(h->os, scope, pid);
	ap_api *api = ap_process(h->os, scope, pid, at, nat);
	if (!workOfPid(h, pid)) {
		Work *w = calloc(1, sizeof *w);
		w->pid = strdup(pid);
		w->scope = scope;
		h->work = realloc(h->work, sizeof *h->work * (size_t)(h->nwork + 1));
		h->work[h->nwork++] = w;
		free(sc_register_teardown(ap_scheduler(h->os), scope, workGone, w));
	}
	return api;
}

/** what the program is given: newOS's API, for the process's scope and path (start.h's create_api) */
static void *createApi(const ps_context *ctx, void *data) {
	Host *h = data;
	ap_api *api = processApi(h, ctx->scope, ctx->process.id, ctx->process.at, ctx->process.nat);
	// started inside another process's node: where it was asked to be, in front (startProgram)
	for (int i = 0; i < h->nnested; i++)
		if (!strcmp(h->nested[i].id, ctx->process.id)) ap_here_is(h->os, ctx->process.id, h->nested[i].at, h->nested[i].n), api->place = h->nested[i].at, api->nplace = h->nested[i].n - 1, api->name = h->nested[i].at[h->nested[i].n - 1];
	return api;
}

/** a process's data in a node "data" inside it, before its runner runs (at the next pulse); NULL: none */
static void dataIn(Host *h, const char *id, const op_value *data) {
	if (!data) return;
	ap_api *api = ap_host(h->os);
	const char *made = NULL;
	const ap_error *e = ap_create(api, data, NULL, 1, &made);
	if (!e) e = ap_insert(api, id, "data", made, NULL, NULL);
	hostFailed(h, e, "start: its data");
}

/** a program (a path from the root) started at at, its data in a node "data" inside it */
static const ap_error *startProgram(void *ctx, const char *const *at, size_t nat, const char *const *program, size_t nprogram,
	const op_value *data, const char **id) {
	Host *h = ctx;
	// a process at the path already (a part that starts the same child again, as 10-12 had it): that one
	pl_answers there = pl_gets(ap_places(h->os), at, nat);
	for (size_t i = 0; i < there.n; i++)
		if (there.items[i].from && !strcmp(there.items[i].from, PR_PART) && there.items[i].id.string) {
			*id = hostTempDup(h, there.items[i].id.string);
			pl_answers_free(&there);
			return NULL;
		}
	pl_answers_free(&there);
	char name[1024] = "";
	for (size_t i = 0; i < nprogram; i++) snprintf(name + strlen(name), sizeof name - strlen(name), "/%s", program[i]);
	pg_found *found = pg_satisfy(ap_places(h->os), name, at, nat ? nat - 1 : 0);
	if (found->refused || !found->chains.n) {
		char why[1200];
		snprintf(why, sizeof why, "%s: %s", name, found->refused ? found->refused : "no way to run it");
		for (size_t i = 0; i < found->why.n && i < 4; i++)
			snprintf(why + strlen(why), sizeof why - strlen(why), "; %s %s", found->why.items[i].for_ ? found->why.items[i].for_ : "", pg_reason_name(found->why.items[i].why));
		pg_found_free(found);
		return ap_error_new(h->os, "not-a-program", why);
	}
	pg_way way = { found->program, found->chains.items[0] };
	// inside another process's node: a process's path holds no process under it (start.h's "taken"),
	// so it runs at /proc/<pid>, and is put in front where it was asked to be (a pick: PORT.md)
	const char *const *where = at;
	size_t nwhere = nat;
	tb_key above = { 0 };
	bool nested = false;
	for (size_t k = 1; k < nat && !nested; k++) {
		pl_answers up = pl_gets(ap_places(h->os), at, k);
		for (size_t i = 0; i < up.n && !nested; i++)
			if (up.items[i].from && !strcmp(up.items[i].from, PR_PART)) nested = true;
		pl_answers_free(&up);
	}
	if (nested) {
		if (nat < 2 || !pl_get(ap_places(h->os), at, nat - 1, &above)) {
			pg_found_free(found);
			return ap_error_new(h->os, "nothing-there", "nothing where it is to be put");
		}
		const char **proc = hostTemp(h, sizeof *proc * 2);
		proc[0] = "proc", proc[1] = hostPid(h);
		where = proc, nwhere = 2;
	}
	ps_refusal no;
	ps_process *p = ps_start(h->programs, ap_places(h->os), &way, where, nwhere, NULL, &no);
	pg_found_free(found);
	if (!p) return ap_error_new(h->os, no.refused && !strcmp(no.refused, "taken") ? "already-there" : "refused", no.refused ? no.refused : "refused");
	if (h->nprocs == h->procs_room) {
		h->procs_room = h->procs_room ? h->procs_room * 2 : 32;
		h->procs = realloc(h->procs, sizeof *h->procs * (size_t)h->procs_room);
	}
	h->procs[h->nprocs++] = (Proc){ strdup(ps_id(p)), p };
	*id = ps_id(p);
	if (nested) {
		h->nested = realloc(h->nested, sizeof *h->nested * (size_t)(h->nnested + 1));
		const char **copy = calloc(nat + 1, sizeof *copy);
		for (size_t i = 0; i < nat; i++) copy[i] = strdup(at[i]);
		h->nested[h->nnested].id = strdup(*id), h->nested[h->nnested].at = copy, h->nested[h->nnested].n = nat;
		h->nnested++;
		hostFailed(h, ap_insert(ap_host(h->os), above.string ? hostTempDup(h, above.string) : "", at[nat - 1], *id, NULL, NULL), "start: in front where it was asked to be");
	}
	dataIn(h, *id, data);
	return NULL;
}

// --- processes the den starts: dens' start, by a runner it offers (makeDen)

/** what the program is given: newOS's API, as createApi gives it (dens.h's create_api) */
static void *denApi(const dn_context *ctx, void *data) {
	return processApi(data, ctx->scope, ctx->process.id, ctx->process.at, ctx->process.nat);
}

/** a start by the den, with the machine's scope open */
typedef struct {
	Host *h;
	const char *const *at, *const *runner, *const *program;
	size_t nat, nrunner, nprogram;
	dn_process *p;
	dn_refusal no;
} DenStart;

static void denStarting(void *data) {
	DenStart *s = data;
	// its pin, {program: {at}, runner: {at}}: what jsc.c's frames read (the program's url), and lookup
	op_value *pin = op_map(), *program = op_map(), *runner = op_map(), *pat = op_list(), *rat = op_list();
	for (size_t i = 0; i < s->nprogram; i++) op_push(pat, op_str(s->program[i]));
	for (size_t i = 0; i < s->nrunner; i++) op_push(rat, op_str(s->runner[i]));
	op_set(program, "at", pat);
	op_set(runner, "at", rat);
	op_set(pin, "program", program);
	op_set(pin, "runner", runner);
	s->p = dn_start(s->h->den, s->runner, s->nrunner, &(dn_program){ .at = s->program, .nat = s->nprogram, .has_at = 1 }, s->at,
		s->nat, &(dn_options){ .pin = pin }, &s->no);
	op_free(pin);
}

/**
 * a program (a path from the root) started at at by the den, on the runner at runner (a path from the root,
 * /system/den/runners/<name>): no satisfy, no chain; the program's ermine.type is the runner's form. Its data
 * in a node "data" inside it, as startProgram's
 */
static const ap_error *startByDen(Host *h, const char *const *at, size_t nat, const char *const *runner, size_t nrunner,
	const char *const *program, size_t nprogram, const op_value *data, const char **id) {
	if (!h->den) return ap_error_new(h->os, "refused", "no den");
	DenStart s = { h, at, runner, program, nat, nrunner, nprogram, NULL, { 0 } };
	sc_run_with_scope(ap_machine(h->os), denStarting, &s);
	if (!s.p) {
		op_value *why = dn_refusal_value(&s.no);
		char *text = valPrint(why);
		const ap_error *e = ap_error_new(h->os, s.no.refused && !strcmp(s.no.refused, "taken") ? "already-there" : "refused", text);
		free(text);
		op_free(why);
		return e;
	}
	*id = hostTempDup(h, dn_process_id(s.p));
	dataIn(h, *id, data);
	return NULL;
}

typedef struct {
	Host *h;
	dn_process *p;
} DenStop;

static void denStopping(void *data) {
	DenStop *s = data;
	dn_refusal no;
	if (dn_stop(s->h->den, s->p, NULL, &no)) hostSay(s->h, "stop %s: refused (%s)", dn_process_id(s->p), no.refused);
}

/** a process the den started, stopped (dn_stop: asked, its handle's stop, its row, its scope), the machine's scope open */
static void denStop(Host *h, dn_process *p) {
	DenStop s = { h, p };
	sc_run_with_scope(ap_machine(h->os), denStopping, &s);
}

// --- /hw, from the device tree: the host's own, ids its own

static void makeHw(Host *h) {
	Json *dt = h->dt;
	Json *hw = jsonObject();
	for (int i = 0; i < dt->object.count; i++) {
		const char *k = dt->object.members[i].key;
		if (strcmp(k, "font") && strcmp(k, "devices") && strcmp(k, "fb") && strcmp(k, "screens")) jsonAdd(hw, k, dt->object.members[i].value);
	}
	size_t n;
	const char *const *root = hostPath(h, &n, NULL);
	own(h, root, 0, "hw", "hw", valOf(hw));
	const char *const *at = hostPath(h, &n, "hw", NULL);
	own(h, at, n, "fb", "hw.fb", valOf(jsonGet(dt, "fb")));
	own(h, at, n, "screens", "hw.screens", valOf(jsonGet(dt, "screens") ? jsonGet(dt, "screens") : jsonArray()));
	// the font ROM, its coverage as bytes
	Json *font = jsonGet(dt, "font"), *rom = jsonObject();
	for (int i = 0; font && i < font->object.count; i++) {
		const char *k = font->object.members[i].key;
		if (strcmp(k, "alpha") == 0) {
			size_t len = 0;
			const char *text = jsonText(font->object.members[i].value);
			unsigned char *bytes = unbase64(text ? text : "", &len);
			jsonAdd(rom, "alpha", jsonBytes(bytes, len));
			free(bytes);
		} else jsonAdd(rom, k, font->object.members[i].value);
	}
	own(h, at, n, "font", "hw.font", valOf(rom));
	own(h, at, n, "devices", "hw.devices", NULL);
	own(h, at, n, "irq", "hw.irq", NULL);
	Json *own_ = parse("[{\"name\": \"timer\", \"irq\": 97, \"note\": \"core 0's own\"},"
	                   " {\"name\": \"exec\", \"irq\": 60, \"note\": \"core 0's own: the exec programs' sockets, output and exits (exec.c)\"},"
	                   " {\"name\": \"sync\", \"irq\": 61,\"note\": \"core 0's own: the connection to /etc/sync's server (net.c)\"},"
	                   " {\"name\": \"wayland\", \"irq\": 62, \"note\": \"the Wayland compositor's socket (drv_wayland.c)\"},"
	                   " {\"name\": \"pty\", \"irq\": 63, \"note\": \"the pseudo-terminals' masters (drv_pty.c)\"},"
	                   " {\"name\": \"sock\", \"irq\": 64, \"note\": \"the shell's Unix socket and its connections (drv_sock.c)\"},"
	                   " {\"name\": \"history\", \"irq\": 65, \"note\": \"a history served may have changed (drv_sync.c)\"},"
	                   " {\"name\": \"vnc\", \"irq\": 66, \"note\": \"the VNC connections' sockets (drv_vnc.c)\"},"
	                   " {\"name\": \"cc\", \"irq\": 67, \"note\": \"core 0's own: a C program's compile done (loader.c)\"},"
	                   " {\"name\": \"presence\", \"irq\": 68, \"note\": \"a peer's live state standing at a shared document changed (drv_sync.c)\"},"
	                   " {\"name\": \"blitter\", \"note\": \"core 0's own: BitBlt, text, and the draw device's ops\"}]");
	size_t nd, ni;
	const char *const *devices = hostPath(h, &nd, "hw", "devices", NULL);
	const char *const *irqs = hostPath(h, &ni, "hw", "irq", NULL);
	for (int pass = 0; pass < 2; pass++) {
		Json *list = pass ? own_ : jsonGet(dt, "devices");
		for (int i = 0; list && i < list->array.count; i++) {
			Json *d = list->array.items[i];
			const char *name = jsonText(jsonGet(d, "name"));
			if (!name) continue;
			char id[128];
			snprintf(id, sizeof id, "hw.dev.%s", name);
			own(h, devices, nd, name, id, valOf(d));
			int64_t irq;
			if (!jsonIsWhole(jsonGet(d, "irq"), &irq)) continue;
			char line[32], lid[64];
			snprintf(line, sizeof line, "%lld", (long long)irq);
			snprintf(lid, sizeof lid, "hw.irq.%s", line);
			// count: records come; keeps: how many wait while no driver has the line, the oldest
			// dropped past it (dropped counts them); waiting: how many wait now
			op_value *v = op_map();
			op_set(v, "device", op_str(name));
			op_set(v, "owner", op_null());
			op_set(v, "count", op_num(0));
			op_set(v, "keeps", op_num(KEEPS));
			op_set(v, "dropped", op_num(0));
			op_set(v, "waiting", op_num(0));
			own(h, irqs, ni, line, lid, v);
			op_free(v);
		}
	}
}

// --- what programs are found by: the types, and the runners

typedef struct {
	Host *h;
	int code;
} Installing;

static void installing(void *data) {
	Installing *in = data;
	Host *h = in->h;
	in->code = ty_install(&(ty_install_setup){ .places = ap_places(h->os), .table = ap_table(h->os), .root = pl_root(ap_places(h->os)),
		.list = TYPES, .n = sizeof TYPES / sizeof *TYPES, .commit = ap_commit, .commit_ctx = h->os, .ids = &h->types });
}

/** a compiler's identity (build.h's ermine.programs.compiler), by which the cache keeps its builds apart: clang, the flags, and the target (NULL: wasm's); new */
static op_value *compilerIdentity(const char *target) {
	op_value *identity = op_map(), *flags = op_list();
	op_push(flags, op_str("-O2"));
	op_push(flags, op_str("-Wall"));
	op_set(identity, "compiler", op_str("clang"));
	if (target) op_set(identity, "target", op_str(target));
	op_set(identity, "flags", flags);
	return identity;
}

/** /ermine/types (ty_install), and /loaders: a folder of runners (ermine.programs.loaders), each a live function of the host's taking a type */
static void makeLoaders(Host *h) {
	Installing in = { h, 0 };
	sc_run_with_scope(ap_machine(h->os), installing, &in);
	if (in.code) hostSay(h, "the types could not be installed");
	size_t n;
	const char *const *root = hostPath(h, &n, NULL);
	own(h, root, 0, "loaders", "os.loaders", NULL);
	const char *const *at = hostPath(h, &n, "loaders", NULL);
	op_value *yes = op_bool(1);
	attribute(h, at, n, PG_LOADERS, yes);
	op_free(yes);
	// the compiler: C source to a wasm module (loader.c), cached by build.c
	hf_add_compiler(h->functions, "clang", loaderCompile, h);
	op_value *clang = hf_value("clang");
	own(h, at, n, "clang", "os.loader.clang", clang);
	op_free(clang);
	size_t nc;
	const char *const *compiler = hostPath(h, &nc, "loaders", "clang", NULL);
	op_value *takes = op_list(), *gives = op_str("org.webassembly.wasm"), *identity = compilerIdentity(NULL);
	op_push(takes, op_str("public.c-source"));
	attribute(h, compiler, nc, PG_TAKES, takes);
	attribute(h, compiler, nc, PG_GIVES, gives);
	attribute(h, compiler, nc, BD_COMPILER, identity);
	op_free(takes), op_free(gives), op_free(identity);
	// native: C source to a library for this machine (loader.c, cc.c), run by "dlopen" (dylib.c). A program
	// says so by its ermine.programs.loader, "/loaders/clang-native"; the cache keeps its build apart from
	// wasm's by its identity
	hf_add_compiler(h->functions, "clang-native", loaderCompileNative, h);
	op_value *native = hf_value("clang-native");
	own(h, at, n, "clang-native", "os.loader.clang-native", native);
	op_free(native);
	compiler = hostPath(h, &nc, "loaders", "clang-native", NULL);
	takes = op_list(), gives = op_str(DYLIB_TYPE), identity = compilerIdentity(NATIVE_TARGET);
	op_push(takes, op_str("public.c-source"));
	attribute(h, compiler, nc, PG_TAKES, takes);
	attribute(h, compiler, nc, PG_GIVES, gives);
	attribute(h, compiler, nc, BD_COMPILER, identity);
	op_free(takes), op_free(gives), op_free(identity);
	dylibAdd(h, h->functions, "dlopen");
	op_value *dlopen = hf_value("dlopen"), *dylibs = op_list();
	own(h, at, n, "dlopen", "os.loader.dlopen", dlopen);
	size_t nr;
	const char *const *runner = hostPath(h, &nr, "loaders", "dlopen", NULL);
	op_push(dylibs, op_str(DYLIB_TYPE));
	attribute(h, runner, nr, PG_TAKES, dylibs);
	op_free(dlopen), op_free(dylibs);
	static Running running_[sizeof RUNNERS / sizeof *RUNNERS];
	for (size_t i = 0; i < sizeof RUNNERS / sizeof *RUNNERS; i++) {
		const Runner *r = &RUNNERS[i];
		running_[i] = (Running){ h, r->run };
		hf_add_runner(h->functions, r->name, running, &running_[i]);
		char id[64];
		snprintf(id, sizeof id, "os.loader.%s", r->name);
		op_value *fn = hf_value(r->name);
		own(h, at, n, r->name, id, fn);
		op_free(fn);
		size_t nr;
		const char *const *runner = hostPath(h, &nr, "loaders", r->name, NULL);
		op_value *takes = op_list();
		op_push(takes, op_str(r->takes));
		attribute(h, runner, nr, PG_TAKES, takes);
		op_free(takes);
	}
}

// --- the den: newOS as ermine/dens has it, offering what /loaders holds

/** dlopen's (dylib.h), not in RUNNERS: its function is a loader's too (dylibAdd) */
static const Runner DLOPEN = {"dlopen", DYLIB_TYPE, "ermine.native", "thread", NULL};

/** the den's id: the device tree's host as a name (lower case letters and digits, the rest one "-"), then a
 * uuid kept on the card beside sync/ (sd/den), made at the first boot; fresh */
static char *denId(Host *h, const char *sd) {
	char path[1024], uuid[37] = "";
	snprintf(path, sizeof path, "%s/den", sd);
	char *kept = slurp(path);
	size_t n = kept ? strcspn(kept, "\r\n ") : 0;
	bool ok = n == 36;
	for (size_t i = 0; ok && i < n; i++)
		ok = i == 8 || i == 13 || i == 18 || i == 23 ? kept[i] == '-' : !!strchr("0123456789abcdef", kept[i]);
	if (ok) memcpy(uuid, kept, 36);
	else {
		// a version 4 uuid, from the card's random bytes (erm_host_random)
		uint8_t b[16];
		erm_host_random(b, sizeof b);
		b[6] = (uint8_t)(b[6] & 0x0f) | 0x40, b[8] = (uint8_t)(b[8] & 0x3f) | 0x80;
		for (int i = 0, at = 0; i < 16; i++) at += sprintf(uuid + at, i == 4 || i == 6 || i == 8 || i == 10 ? "-%02x" : "%02x", b[i]);
		FILE *f = fopen(path, "w");
		if (!f || fprintf(f, "%s\n", uuid) < 0) hostSay(h, "the den's id could not be kept at %s: a new one each boot", path);
		if (f) fclose(f);
		if (kept) hostSay(h, "%s is not a uuid: a new one", path);
	}
	free(kept);
	const char *host = jsonText(jsonGet(h->dt, "host"));
	char name[64] = "";
	size_t len = 0;
	for (const char *c = host ? host : ""; *c && len < sizeof name - 2; c++) {
		char l = *c >= 'A' && *c <= 'Z' ? (char)(*c - 'A' + 'a') : *c;
		if ((l >= 'a' && l <= 'z') || (l >= '0' && l <= '9')) name[len++] = l;
		else if (len && name[len - 1] != '-') name[len++] = '-';
	}
	while (len && name[len - 1] == '-') len--;
	name[len] = 0;
	const char *base = len ? name : "ermineos";
	char *id = malloc(strlen(base) + 1 + 36 + 1);
	sprintf(id, "%s-%s", base, uuid);
	return id;
}

/** an offer of the den's, its attributes taken (op_free'd); refused: said */
static void offer(Host *h, dn_kind kind, const char *name, op_value *attributes, const op_value *live) {
	dn_refusal no;
	if (!dn_offer(h->den, NULL, kind, name, attributes, live, &no)) hostSay(h, "den: %s not offered: %s", name, no.refused);
	op_free(attributes);
}

/** a runner's attributes: its form, the api its program is given, where it runs */
static op_value *runnerAttributes(const Runner *r) {
	op_value *v = op_map();
	op_set(v, DN_TAKES, op_str(r->takes));
	op_set(v, DN_API, op_str(r->api));
	op_set(v, DN_WHERE, op_str(r->where));
	return v;
}

/** a compiler's attributes: what it takes, what it gives, its identity (the cache's, as /loaders says it) */
static op_value *compilerAttributes(const char *gives, const char *target) {
	op_value *v = op_map();
	op_set(v, DN_COMPILER_TAKES, op_str("public.c-source"));
	op_set(v, DN_GIVES, op_str(gives));
	op_set(v, BD_COMPILER, compilerIdentity(target));
	return v;
}

typedef struct {
	Host *h;
	const char *sd;
} Denning;

static void denning(void *data) {
	Denning *in = data;
	Host *h = in->h;
	char *id = denId(h, in->sd);
	// what the machine is: /hw's, from the device tree (ermine.den.device; not matched on: its runners are)
	op_value *device = op_map();
	static const char *const SAYS[] = { "model", "cpu", "cores", "memory", "os" };
	for (size_t i = 0; i < sizeof SAYS / sizeof *SAYS; i++)
		if (jsonGet(h->dt, SAYS[i])) op_set(device, SAYS[i], valOf(jsonGet(h->dt, SAYS[i])));
	const char *why = NULL;
	h->den = dn_new(&(dn_setup){ .scheduler = ap_scheduler(h->os), .table = ap_table(h->os), .places = ap_places(h->os), .scopes = ap_scopes(h->os),
		.functions = h->functions, .id = id, .name = jsonText(jsonGet(h->dt, "host")), .device = device, .create_api = denApi, .data = h,
		.commit = ap_commit, .commit_ctx = h->os, .sites = ap_sites(h->os) }, &why);
	op_free(device);
	if (!h->den) {
		hostSay(h, "no den (%s): %s", id, why ? why : "refused");
		free(id);
		return;
	}
	hostSay(h, "den %s at /system/dens/%s", dn_node(h->den), id);
	free(id);
	// the runners: the same live functions /loaders holds
	for (size_t i = 0; i < sizeof RUNNERS / sizeof *RUNNERS; i++) {
		op_value *fn = hf_value(RUNNERS[i].name);
		offer(h, DN_RUNNERS, RUNNERS[i].name, runnerAttributes(&RUNNERS[i]), fn);
		op_free(fn);
	}
	op_value *dlopen = hf_value(DLOPEN.name);
	offer(h, DN_RUNNERS, DLOPEN.name, runnerAttributes(&DLOPEN), dlopen);
	op_free(dlopen);
	// the compilers: C to wasm, and C to a library for this machine
	op_value *clang = hf_value("clang"), *native = hf_value("clang-native");
	offer(h, DN_COMPILERS, "clang", compilerAttributes("org.webassembly.wasm", NULL), clang);
	offer(h, DN_COMPILERS, "clang-native", compilerAttributes(DYLIB_TYPE, NATIVE_TARGET), native);
	op_free(clang), op_free(native);
	// the surfaces: the frame buffer the display driver draws on, its size the device tree's; no live part
	// (what draws on it is the display driver, at /dev/display)
	Json *fb = jsonGet(h->dt, "fb");
	int64_t w = 0, hh = 0;
	if (jsonIsWhole(jsonGet(fb, "w"), &w) && jsonIsWhole(jsonGet(fb, "h"), &hh)) {
		op_value *display = op_map(), *size = op_list();
		op_push(size, op_num((double)w));
		op_push(size, op_num((double)hh));
		op_set(display, DN_KIND, op_str("pixels"));
		op_set(display, DN_SIZE, size);
		offer(h, DN_SURFACES, "display", display, NULL);
	}
}

/** newOS as a den (dens.h), after /loaders: its node, its runners, compilers and surfaces; sd the card's folder */
static void makeDen(Host *h, const char *sd) {
	Denning in = { h, sd };
	sc_run_with_scope(ap_machine(h->os), denning, &in);
}

// --- the image: loaded at every boot (image/image.json): a first boot loads it whole; a later boot loads
// what it lacks, and loads again what changed in the image and only the image ever wrote here

/** the site file the image's writes carry, by which a boot tells them from anyone else's */
#define IMAGE_SITE "image"

static Json *image(Host *h) {
	char path[1024];
	snprintf(path, sizeof path, "%s/image.json", h->config.image);
	char *text = slurp(path);
	if (!text) {
		hostSay(h, "no image at %s", h->config.image);
		return NULL;
	}
	char *why = NULL;
	Json *img = jsonParse(text, strlen(text), &why);
	free(text);
	if (!img) hostSay(h, "the image is not JSON: %s", why);
	return img;
}

/** a node's value as the image gives it: its value, or a program's source read from the image's folder */
static op_value *imageValue(Host *h, Json *entry) {
	const char *source = jsonText(jsonGet(entry, "source"));
	if (!source) return valOf(jsonGet(entry, "value"));
	char path[1024];
	snprintf(path, sizeof path, "%s/%s", h->config.image, source);
	char *text = slurp(path);
	op_value *v = op_str(text ? text : "");
	free(text);
	return v;
}

/** the image's own interface: what it writes says so (the change's site, file "image"), so a later boot can tell the image's writes from a person's or a program's */
static ap_api imageApi(Host *h) {
	ap_api a = *ap_host(h->os);
	a.self = IMAGE_SITE;
	return a;
}

/** "/programs/files": an address as the log says it */
static const char *pathText(Host *h, const char *const *address, size_t n) {
	size_t len = 2;
	for (size_t i = 0; i < n; i++) len += strlen(address[i]) + 1;
	char *text = hostTemp(h, len), *p = text;
	for (size_t i = 0; i < n; i++) p += sprintf(p, "/%s", address[i]);
	if (!n) *p++ = '/';
	*p = 0;
	return text;
}

/** whether a change was the image's: its site says "image"; or "machine", the host's, which on a card from before
 * the image said so is all the host ever wrote to a node the image describes */
static bool imageChange(void *ctx, const ch_header *c) {
	bool *others = ctx;
	const char *file = c->external_length ? c->external[0].file : NULL;
	if (file && (!strcmp(file, IMAGE_SITE) || !strcmp(file, "machine"))) return true;
	*others = true;
	return false;
}

/** whether the image may load a document's table again: every stored change of it (every head's) was the image's.
 * None stored counts as the image's too: nothing else could have written it */
static bool imageOwns(Host *h, const char *id, const char *table) {
	bool others = false;
	cardChanges(h->card, id, table, imageChange, &others);
	return !others;
}

/** what loadImage counts, for its log */
typedef struct {
	int loaded, again;
	char *names;
	size_t n, room;
} Imaged;

static void loadedAgain(Imaged *m, const char *path) {
	size_t len = strlen(path) + 2;
	if (m->n + len + 1 > m->room) m->names = realloc(m->names, m->room = (m->n + len + 1) * 2);
	m->n += (size_t)sprintf(m->names + m->n, "%s%s", m->again++ ? ", " : "", path);
}

/**
 * An entry's info (attributes): each loaded where it is not so already, unless a person or a program changed the
 * node's attributes here: then they are not loaded
 */
static void imageInfo(Host *h, Json *e, const char *const *at, size_t n, const char *name) {
	Json *info = jsonGet(e, "info");
	if (!jsonIsObject(info)) return;
	const char **address = hostTemp(h, sizeof *address * (n + 2));
	for (size_t k = 0; k < n; k++) address[k] = at[k];
	address[n] = name, address[n + 1] = NULL;
	ap_api api = imageApi(h);
	int owned = -1;
	for (int i = 0; i < info->object.count; i++) {
		op_value *v = valOf(info->object.members[i].value);
		const char *key = info->object.members[i].key;
		ap_items items;
		if (!ap_info(&api, address, n + 1, key, &items) && items.n && items.items[0].nversions && valEqual(items.items[0].versions[0].content, v)) {
			op_free(v);
			continue;
		}
		if (owned < 0) {
			const ap_item *it = ap_first(&api, address, n + 1);
			owned = !it || !id_is(it->id) || imageOwns(h, it->id, "attributes");
		}
		if (owned) {
			op_patch p = valWhole(v);
			char doing[256];
			snprintf(doing, sizeof doing, "info %s", key);
			hostFailed(h, ap_set(&api, address, n + 1, key, &p, 1, NULL, NULL), doing);
		}
		op_free(v);
	}
}

/**
 * A node the card holds already, the image's value differing from its: loaded again when every stored change of
 * the value was the image's own; not loaded the moment a person or a program changed it here
 */
static void loadImageAgain(Host *h, Imaged *m, Json *e, const char *const *address, size_t n) {
	ap_api api = imageApi(h);
	const ap_item *it = ap_first(&api, address, n);
	if (!it || !id_is(it->id)) return;
	op_value *v = imageValue(h, e);
	const op_value *held = hostRead(&api, address, n);
	bool same = valEqual(held, v) || (!held && v->type == OP_NULL);
	if (!same) {
		const char *path = pathText(h, address, n);
		if (imageOwns(h, it->id, "value") && !hostFailed(h, hostSnap(&api, address, n, v), path)) loadedAgain(m, path);
	}
	op_free(v);
}

/**
 * An entry {at, name, link}: the node the image made at link (a path from the
 * root) placed again, at name, as the shell's ln places one: one node at two
 * names (/etc/theme, the theme in use, is one of /etc/themes'). A name that
 * holds a node already is left alone. True when it placed it.
 */
static bool linkImage(Host *h, Json *e, const char *parent, const char *const *at, size_t n, const char *name) {
	size_t nl;
	const char *const *to = hostPathOf(h, jsonGet(e, "link"), &nl);
	const char *id = to ? idAt(h, to, nl) : NULL;
	if (!id) {
		hostSay(h, "image: %s: nothing at its link", name);
		return false;
	}
	const char **address = hostTemp(h, sizeof *address * (n + 2));
	for (size_t k = 0; k < n; k++) address[k] = at[k];
	address[n] = name, address[n + 1] = NULL;
	if (idAt(h, address, n + 1)) return false;
	char doing[256];
	snprintf(doing, sizeof doing, "link %s", name);
	ap_api api = imageApi(h);
	return !hostFailed(h, ap_insert(&api, parent, name, id, NULL, NULL), doing);
}

/** the parent's id of an entry: its at from the root */
static const char *parentOf(Host *h, Json *e, const char *const **at, size_t *n) {
	*at = hostPathOf(h, jsonGet(e, "at"), n);
	if (!*at) return NULL;
	return *n ? idAt(h, *at, *n) : pl_root(ap_places(h->os)).string;
}

/**
 * The image loaded: each node made and placed by name. A card with none of
 * the image's nodes gets them all; a card that has them gets those it lacks,
 * by name, the info (attributes) the image gives, and the image's value
 * loaded again where it changed and only the image ever wrote the node's
 * (loadImageAgain). What a person or a program changed is not loaded.
 * Children: only made where lacking, never loaded again.
 */
static void loadImage(Host *h, Json *img) {
	Json *nodes = jsonGet(img, "nodes");
	Imaged m = { 0 };
	ap_api api = imageApi(h);
	for (int i = 0; nodes && i < nodes->array.count; i++) {
		Json *e = nodes->array.items[i];
		const char *name = jsonText(jsonGet(e, "name"));
		if (!name) continue;
		size_t n;
		const char *const *at;
		const char *parent = parentOf(h, e, &at, &n);
		if (!parent) {
			hostSay(h, "image: %s: nothing at its parent", name);
			continue;
		}
		if (jsonGet(e, "link")) {
			if (linkImage(h, e, parent, at, n, name)) m.loaded++;
			continue;
		}
		const char **address = hostTemp(h, sizeof *address * (n + 2));
		for (size_t k = 0; k < n; k++) address[k] = at[k];
		address[n] = name, address[n + 1] = NULL;
		if (!idAt(h, address, n + 1)) {
			op_value *v = imageValue(h, e);
			if (hostPut(h, &api, parent, name, v, false)) m.loaded++;
			op_free(v);
		} else loadImageAgain(h, &m, e, address, n + 1);
		imageInfo(h, e, at, n, name);
	}
	if (m.loaded) hostSay(h, "image: %d node%s loaded", m.loaded, m.loaded == 1 ? "" : "s");
	if (m.again) hostSay(h, "image: %d node%s loaded again: %s", m.again, m.again == 1 ? "" : "s", m.names);
	free(m.names);
}

/**
 * what boots: each entry started at its path (start, then its name or a fresh one), its data inside it. An
 * entry with a runner (a path from the root, /system/den/runners/<name>) is started by the den, on that runner
 * (startByDen); one without, by satisfy's way (startProgram)
 */
static void boot(Host *h, Json *img) {
	Json *list = jsonGet(img, "boot");
	for (int i = 0; list && i < list->array.count; i++) {
		Json *e = list->array.items[i];
		size_t na, np, nr = 0;
		const char *const *address = hostPathOf(h, jsonGet(e, "start"), &na);
		const char *const *program = hostPathOf(h, jsonGet(e, "program"), &np);
		const char *const *runner = jsonGet(e, "runner") ? hostPathOf(h, jsonGet(e, "runner"), &nr) : NULL;
		if (!address || !program || (jsonGet(e, "runner") && !runner)) continue;
		const char *name = jsonText(jsonGet(e, "name"));
		const char **at = hostTemp(h, sizeof *at * (na + 2));
		for (size_t k = 0; k < na; k++) at[k] = address[k];
		at[na] = name ? name : hostPid(h);
		char *where = jsonPrint(jsonGet(e, "start")), *what = jsonPrint(jsonGet(e, "program"));
		char doing[512];
		snprintf(doing, sizeof doing, "boot: %s %s", where, what);
		op_value *data = jsonGet(e, "data") ? valOf(jsonGet(e, "data")) : NULL;
		const char *pid = NULL;
		const ap_error *no = runner ? startByDen(h, at, na + 1, runner, nr, program, np, data, &pid) : startProgram(h, at, na + 1, program, np, data, &pid);
		if (!hostFailed(h, no, doing)) hostSay(h, "start %s  %s  %s%s%s", pid, where, what, runner ? "  by " : "", runner ? pathText(h, runner, nr) : "");
		op_free(data);
		free(where);
		free(what);
	}
}

// --- booting

/** ermine/programs' builds and start, made with the machine's scope open */
static void programsUp(void *data) {
	Host *h = data;
	h->builds = bd_new(&(bd_setup){ .places = ap_places(h->os), .table = ap_table(h->os), .scheduler = ap_scheduler(h->os),
		.cache = "os.cache", .functions = h->functions, .commit = ap_commit, .commit_ctx = h->os });
	h->programs = ps_new(&(ps_setup){ .scheduler = ap_scheduler(h->os), .table = ap_table(h->os), .places = ap_places(h->os),
		.builds = h->builds, .scopes = ap_scopes(h->os), .sites = ap_sites(h->os), .functions = h->functions, .create_api = createApi, .data = h,
		.commit = ap_commit, .commit_ctx = h->os });
}

Host *hostBoot(const ErmosConfig *config) {
	Host *h = calloc(1, sizeof *h);
	h->config = *config;
	hostSay(h, "image %s, runner %s, card %s", h->config.image, h->config.runner ? h->config.runner : "(none)", h->config.sd ? h->config.sd : "(none)");
	h->started = monotonic();
	char *why = NULL;
	h->dt = config->dt ? jsonParse(config->dt, strlen(config->dt), &why) : NULL;
	if (!jsonIsObject(h->dt)) {
		hostSay(h, "no device tree: %s", why ? why : "none given");
		return NULL;
	}
	// the card: the device, and what Subduction holds, from which the graph is made again
	const char *sd = h->config.sd ? h->config.sd : "/tmp/ermineOS-card", *wrong = NULL;
	h->card = cardOpen(sd, h->config.fresh, &wrong);
	if (!h->card) {
		hostSay(h, "the card (%s) could not be used: %s", sd, wrong);
		return NULL;
	}
	h->os = ap_new(&(ap_setup){ .card = h->card, .root = cardRoot(h->card), .say = said, .start = startProgram, .ctx = h });
	h->peep = ap_peep(ap_host(h->os));
	sc_on_run_start(ap_scheduler(h->os), runStarted, h);
	sc_on_run_end(ap_scheduler(h->os), runEnded, h);
	sc_on_mark(ap_scheduler(h->os), marked, h);
	drvUse(h);
	bool held = cardStart(h->card, ap_places(h->os), ap_table(h->os), ap_scheduler(h->os),
		&(card_host){ .say = said, .send = netSend, .count = netCounts, .context = h });
	h->net = netOpen(h, cardDevice(h->card), cardKey(h->card));
	h->running = true;
	// ermine/programs: the host's functions, the build cache, start
	h->functions = hf_new();
	sc_run_with_scope(ap_machine(h->os), programsUp, h);
	Json *img = image(h);
	hostSay(h, held ? "the card (%s) holds a graph: %s" : "the card (%s) is empty: %s", sd, cardRoot(h->card));
	if (img) loadImage(h, img);
	makeHw(h);
	makeLoaders(h);
	makeDen(h, sd);
	if (!h->config.bare && img) boot(h, img);
	ap_pulse(h->os);
	reap(h);
	cardTurn(h->card);
	ap_sweep(h->os);
	hostCommand(h, parse("{\"op\": \"ready\"}"));
	return h;
}

// --- the drain: each record to the driver that claimed its line

/** the owner of a line: the address of its driver's handler, or NULL while no driver has it */
static const op_value *ownerOf(Host *h, int irq) {
	char line[32];
	snprintf(line, sizeof line, "%d", irq);
	size_t n;
	const op_value *v = hostRead(ap_host(h->os), hostPath(h, &n, "hw", "irq", line, NULL), n);
	const op_value *owner = v && v->type == OP_MAP ? op_get(v, "owner") : NULL;
	return owner && owner->type == OP_LIST ? owner : NULL;
}

/** the line's entry, made at its first record */
static Held *lineOf(Host *h, int irq) {
	for (int i = 0; i < h->nheld; i++) if (h->held[i].irq == irq) return &h->held[i];
	h->held = realloc(h->held, sizeof *h->held * (size_t)(h->nheld + 1));
	Held *held = &h->held[h->nheld++];
	*held = (Held){ .irq = irq };
	return held;
}

static void deliver(Host *h, int irq, Json *records) {
	Held *line = lineOf(h, irq);
	line->arrived += records->array.count;
	line->dirty = true;
	// the network's line (net.c): what came is read at the card's turn, each turn; a compile done
	// (loader.c): taken at the turn's end, each turn
	if (irq == 61 || irq == LOADER_IRQ) {
		jsonFree(records);
		return;
	}
	// the exec programs' line (exec.c): a program's frames or lines came, or it exited
	if (irq == EXEC_IRQ) {
		execRecords(h, records);
		jsonFree(records);
		return;
	}
	const op_value *owner = ownerOf(h, irq);
	if (!owner) {
		// no driver has the line yet: its newest KEEPS wait, as a level-triggered interrupt does; the oldest go
		for (int i = 0; i < records->array.count; i++) {
			if (line->count == KEEPS) {
				jsonFree(line->records[0]);
				memmove(line->records, line->records + 1, sizeof *line->records * (size_t)(line->count - 1));
				line->count--;
				line->dropped++;
			}
			if (line->count == line->room) {
				line->room = line->room ? line->room * 2 : 8;
				line->records = realloc(line->records, sizeof *line->records * (size_t)line->room);
			}
			line->records[line->count++] = records->array.items[i];
		}
		// the records taken are the line's now; the list goes
		records->array.count = 0;
		jsonFree(records);
		return;
	}
	size_t n = owner->count;
	const char **address = hostTemp(h, sizeof *address * (n + 1));
	for (size_t i = 0; i < n; i++) address[i] = owner->items[i]->type == OP_STR ? owner->items[i]->str : "";
	address[n] = NULL;
	op_value *args = op_list();
	op_push(args, valOf(records));
	op_value *out = NULL;
	char doing[64];
	snprintf(doing, sizeof doing, "irq %d", irq);
	int64_t at = monotonic();
	const ap_error *e = ap_call_host(h->os, address, n, args, &out);
	charge(h, address, n, monotonic() - at, e != NULL);
	hostFailed(h, e, doing);
	op_free(args);
	jsonFree(records);
}

/** the timers that are due, each its handler called; the next asked for as a wake */
static void timers(Host *h) {
	int64_t now = hostNow(h);
	for (int i = 0; i < h->ntimers;) {
		if (h->timerAt[i] > now) {
			hostWake(h, h->timerAt[i]);
			i++;
			continue;
		}
		Json *to = h->timerTo[i];
		h->timerAt[i] = h->timerAt[h->ntimers - 1];
		h->timerTo[i] = h->timerTo[--h->ntimers];
		size_t n;
		const char *const *address = hostPathOf(h, to, &n);
		// a timer cancelled, or its process stopped: its handler is gone, and so is the timer
		if (address && hostLook(ap_host(h->os), address, n)) {
			op_value *out = NULL;
			int64_t at = monotonic();
			const ap_error *e = ap_call_host(h->os, address, n, NULL, &out);
			charge(h, address, n, monotonic() - at, e != NULL);
			hostFailed(h, e, "timer");
		}
		jsonFree(to);
	}
}

/** each line's counts written to /hw/irq/<n> where they changed */
static void linesFlush(Host *h) {
	for (int i = 0; i < h->nheld; i++) {
		Held *line = &h->held[i];
		if (!line->dirty) continue;
		line->dirty = false;
		char n[32];
		snprintf(n, sizeof n, "%d", line->irq);
		size_t len;
		const char *const *address = hostPath(h, &len, "hw", "irq", n, NULL);
		if (!hostLook(ap_host(h->os), address, len)) continue;
		op_value *count = op_num((double)line->arrived), *dropped = op_num((double)line->dropped), *waiting = op_num((double)line->count);
		op_patch patches[3] = { valKey("count", count), valKey("dropped", dropped), valKey("waiting", waiting) };
		hostFailed(h, ap_write(ap_host(h->os), address, len, patches, 3, NULL, NULL), "irq counts");
		for (int k = 0; k < 3; k++) free((void *)patches[k].place.path[0].s), free((void *)patches[k].place.path);
		op_free(count), op_free(dropped), op_free(waiting);
	}
}

/** writes /dev/clock/second and wall each second, and minute as it turns; and what the host counts, once a second */
static void tick(Host *h) {
	time_t now = time(NULL);
	if ((int64_t)now == h->second) return;
	linesFlush(h);
	workFlush(h);
	planesSweep(h);
	bool minute = h->second / 60 != (int64_t)now / 60;
	h->second = (int64_t)now;
	struct tm tm = *localtime(&now);
	char wall[16];
	strftime(wall, sizeof wall, "%H:%M:%S", &tm);
	size_t n;
	const char *names[3] = { "second", "minute", "wall" };
	op_value *values[3] = { op_num((double)now), op_num((double)(now / 60)), op_str(wall) };
	for (int i = 0; i < 3; i++) {
		if (i == 1 && !minute) {
			op_free(values[i]);
			continue;
		}
		const char *const *address = hostPath(h, &n, "dev", "clock", names[i], NULL);
		if (hostLook(ap_host(h->os), address, n)) hostSnap(ap_host(h->os), address, n, values[i]);
		else {
			// the clock's nodes are the host's own, ids the same each boot: never documents, never stored
			char id[32];
			snprintf(id, sizeof id, "dev.clock.%s", names[i]);
			own(h, hostPath(h, &n, "dev", "clock", NULL), 2, names[i], id, values[i]);
		}
		op_free(values[i]);
	}
	ap_pulse(h->os);
}

void hostTurn(Host *h, const char *const *records, int count) {
	// lines claimed since the last turn get what waited for them, first
	for (int i = 0; i < h->nheld; i++) {
		Held *held = &h->held[i];
		if (!held->count || !ownerOf(h, held->irq)) continue;
		Json *list = jsonArray();
		for (int k = 0; k < held->count; k++) jsonPush(list, held->records[k]);
		held->count = 0;
		held->arrived -= list->array.count; // counted when they came
		deliver(h, held->irq, list);
		ap_pulse(h->os);
	}
	// this turn's, by line, in order
	int *irqs = calloc((size_t)count + 1, sizeof *irqs), lines = 0;
	Json **groups = calloc((size_t)count + 1, sizeof *groups);
	for (int i = 0; i < count; i++) {
		char *why = NULL;
		Json *r = jsonParse(records[i], strlen(records[i]), &why);
		int64_t irq;
		if (!r || !jsonIsWhole(jsonGet(r, "irq"), &irq)) continue;
		if (irq == 1) {
			hostSay(h, "power off (%s)", jsonText(jsonGet(r, "why")) ? jsonText(jsonGet(r, "why")) : "");
			h->running = false;
			continue;
		}
		int at = -1;
		for (int k = 0; k < lines; k++) if (irqs[k] == (int)irq) at = k;
		if (at < 0) {
			irqs[lines] = (int)irq;
			groups[lines] = jsonArray();
			at = lines++;
		}
		jsonPush(groups[at], r);
	}
	if (h->wake && hostNow(h) >= h->wake) h->wake = 0;
	for (int k = 0; k < lines; k++) {
		deliver(h, irqs[k], groups[k]);
		ap_pulse(h->os);
	}
	timers(h);
	reap(h);
	loaderTurn(h);
	ap_pulse(h->os);
	dylibTurn(h);
	// the network, around the card's turn: what came taken in, then what the transport asks sent
	netIn(h->net);
	int64_t sync = cardTurn(h->card);
	netTurn(h->net);
	int64_t net = netWait(h->net);
	if (net >= 0 && (sync < 0 || net < sync)) sync = net;
	if (sync >= 0) hostWake(h, hostNow(h) + sync * 1000);
	ap_sweep(h->os);
	free(irqs);
	free(groups);
	tick(h);
	ap_sweep(h->os);
	drvSweep();
	valSweep();
}

int64_t hostWait(Host *h) {
	int64_t now = hostNow(h);
	// the clock's next second
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	int64_t until = 1000000 - ts.tv_nsec / 1000;
	if (h->wake) {
		int64_t w = h->wake - now;
		if (w < until) until = w < 0 ? 0 : w;
	}
	return until;
}

bool hostRunning(Host *h) {
	return h->running;
}

void hostOff(Host *h) {
	// NEWOS_SHOW="dev/kbd/state dev/pointer/at": those values said at power off, for tests
	const char *show = getenv("NEWOS_SHOW");
	char *list = show ? strdup(show) : NULL, *rest = list;
	for (char *one; list && (one = strsep(&rest, " "));) {
		if (!*one) continue;
		Json *a = jsonArray();
		char *names = strdup(one), *more = names;
		for (char *name; (name = strsep(&more, "/"));) if (*name) jsonPush(a, jsonString(name));
		size_t n;
		char *text = valPrint(hostRead(ap_host(h->os), hostPathOf(h, a, &n), n));
		hostSay(h, "%s = %s", one, text);
		free(text);
		free(names);
	}
	free(list);
	execStop(h);
	dylibStop(h);
	driversStop();
	while (h->nmapped) unmapped(h, 0);
	cardStop(h->card);
	netStop(h->net);
	hostSay(h, "off: the card holds every change to a document");
}
