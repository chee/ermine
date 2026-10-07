// host.c: host.h. The host holds the bare graph, so its own work (letting a
// killed process's ephemeral nodes go, watching addresses) is beneath every
// wrapper, as SCHEDULER's bookkeeping is; there are no wrappers yet.

#define _DARWIN_C_SOURCE // arc4random_uniform, getline

#include "host.h"

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static const Loader *const LOADERS[] = { &ptyLoader, &ermineLoader };

double hostNow(void) {
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	return (double)now.tv_sec + (double)now.tv_nsec / 1e9;
}

Json *hostSite(const char *file, int line, const char *function) {
	Json *site = jsonObject();
	jsonAdd(site, "file", jsonString(file));
	jsonAdd(site, "line", jsonInteger(line));
	jsonAdd(site, "function", jsonString(function));
	return site;
}

static const char *codeOf(ErmErr err) {
	return err.kind ? jsonText(jsonGet(err.why, "code")) : "";
}

static ErmErr invalid(const char *code, const char *text) {
	return ermDetail(ermInvalid(code), "text", jsonString(text));
}

static ErmIds idsOf(const ErmIds *ids, const char *more) {
	ErmIds out = { 0 };
	for (int i = 0; i < ids->count; i++) ERM_PUSH(out, ids->items[i]);
	if (more) ERM_PUSH(out, more);
	return out;
}

/** an address of names from the root, or from a place */
static ErmAddress addressOf(const ErmIds *names) {
	return (ErmAddress){ .names = *names };
}

Host *hostNew(const char *root) {
	Host *host = allocate(sizeof *host);
	host->graph = ermGraph(root);
	host->graph.vt->setTop(host->graph.self, host->graph);
	const char *user = getenv("USER");
	host->agent = jsonObject();
	jsonAdd(host->agent, "actor", jsonString(user ? user : "someone"));
	jsonAdd(host->agent, "code", jsonArray());
	host->agentText = jsonPrint(host->agent);
	ERM_PUSH(host->windows, "windows");
	host->log = -1;
	host->collector = collectorNew(host->graph, speakersHolding, NULL);
	return host;
}

ErmCtx hostCtx(Host *host) {
	return (ErmCtx){ .agent = host->agent };
}

Proc *hostFind(Host *host, const char *pid) {
	for (int i = 0; i < host->procs.count; i++) {
		if (strcmp(host->procs.items[i]->pid, pid) == 0) return host->procs.items[i];
	}
	return NULL;
}

ErmErr hostOp(Host *host, const ErmCtx *ctx, Json *cause, const ErmOp *op, ErmResult *out) {
	ErmStamp stamp = { cause, host->clock + 1 };
	*out = (ErmResult){ 0 };
	ErmErr err = host->graph.vt->op(host->graph.self, ctx, &stamp, op, out);
	if (!err.kind && ermOpIsChange(op->kind)) host->clock = ermGraphLast(host->graph);
	hostSettle(host);
	return err;
}

// killing (SCHEDULER Processes: Killing, Ephemeral nodes) ---------------------------

/** the host's watch of a process's address: a change after which it reaches nothing, or another node, kills it */
static void watched(void *data, const ErmChange *change, const ErmItems *reaches) {
	Proc *proc = data;
	if (!reaches || proc->doomed) return;
	if (reaches->count) {
		const ErmRoute *route = &reaches->items[0].route;
		if (route->count && strcmp(route->items[route->count - 1].node, proc->pid) == 0) return;
	}
	proc->doomed = true;
	proc->killAgent = change->agent;
	proc->killProcess = change->process;
	proc->killTime = change->time;
}

static void screenChanged(void *data, const ErmChange *change, const ErmItems *reaches) {
	(void)change;
	(void)reaches;
	((Host *)data)->dirty = true;
}

/**
 * Kills a process: its loader stops it, the host stops watching it, then
 * each ephemeral node made as it that is still here is unplaced from its one
 * slot, the most recently made first, as whoever killed it, with the cause
 * {"killed": pid, "by": t}; then the graph forgets it.
 */
static void killProc(Host *host, int index) {
	Proc *proc = host->procs.items[index];
	ErmInterface g = host->graph;
	proc->loader->kill(host, proc);
	g.vt->unsubscribe(g.self, NULL, proc->watch);
	g.vt->unsubscribe(g.self, NULL, proc->screenWatch);
	ErmIds made = idsOf(&proc->made, NULL);
	const ErmIds *spoken = proc->speaker ? speakerMade(proc->speaker) : NULL;
	for (int i = 0; spoken && i < spoken->count; i++) ERM_PUSH(made, spoken->items[i]);
	ErmCtx ctx = { .agent = proc->killAgent, .process = proc->killProcess };
	for (int i = made.count - 1; i >= 0; i--) {
		Json *cause = jsonObject();
		jsonAdd(cause, "killed", jsonString(proc->pid));
		jsonAdd(cause, "by", jsonNumber(proc->killTime));
		ErmStamp stamp = { cause, host->clock + 1 };
		ErmResult out = { 0 };
		if (!ermGraphRelease(g, &ctx, &stamp, made.items[i], &out).kind) host->clock = ermGraphLast(g);
		ermResultFree(&out);
		collectForget(host->collector, made.items[i]);
	}
	free(made.items);
	g.vt->forget(g.self, proc->pid);
	memmove(&host->procs.items[index], &host->procs.items[index + 1], (size_t)(host->procs.count - index - 1) * sizeof(Proc *));
	host->procs.count--;
	free(proc->agentText);
	free(proc);
	host->dirty = true;
}

void hostSettle(Host *host) {
	if (host->settling) return;
	host->settling = true;
	for (int i = 0; i < host->procs.count;) {
		if (host->procs.items[i]->doomed) {
			killProc(host, i);
			i = 0; // a kill's own changes may doom others
		} else {
			i++;
		}
	}
	host->settling = false;
}

ErmErr hostUnplace(Host *host, Proc *proc, Json *cause) {
	ErmIds parent = idsOf(&proc->address, NULL);
	parent.count--;
	ErmOp op = { .kind = ERM_OP_UNPLACE, .address = addressOf(&parent), .name = proc->pid, .id = proc->pid };
	ErmCtx ctx = hostCtx(host);
	ErmResult out;
	ErmErr err = hostOp(host, &ctx, cause, &op, &out);
	ermResultFree(&out);
	free(parent.items);
	return err;
}

void hostExited(Host *host, Proc *proc, Json *status) {
	if (proc->doomed) return;
	Json *cause = SITE;
	jsonAdd(cause, "exited", status ? status : jsonNull());
	ErmErr err = hostUnplace(host, proc, cause);
	// placed somewhere it can no longer be unplaced from (its address already moved): kill it all the same
	if (err.kind && hostFind(host, proc->pid) == proc) {
		proc->doomed = true;
		proc->killAgent = host->agent;
		proc->killTime = host->clock;
		hostSettle(host);
	}
}

void hostClosed(Host *host, Proc *proc) {
	if (proc->closed) return;
	proc->closed = hostNow();
	if (!proc->child) hostExited(host, proc, proc->status);
}

/** how a reaped child ended: its exit code, or {"signal": n} */
static Json *exitStatus(int status) {
	if (WIFEXITED(status)) return jsonInteger(WEXITSTATUS(status));
	Json *signal = jsonObject();
	jsonAdd(signal, "signal", jsonInteger(WIFSIGNALED(status) ? WTERMSIG(status) : 0));
	return signal;
}

// starting (SCHEDULER Processes, Programs; LOADERS Finding a loader) ------------------

/**
 * The scheduler's search: the first directory, from the place up to its
 * start, from which the whole path reaches a node that is here; a path whose
 * first part is "/" is not searched for. Untracked reads, as the caller.
 */
static Json *search(Host *host, const ErmCtx *ctx, const ErmAddress *path, Json **identity) {
	for (int up = 0; up == 0 || !path->fromStart; up++) {
		ErmOp op = { .kind = ERM_OP_READ, .address = *path };
		op.address.ups = up;
		ErmResult out = { 0 };
		if (host->graph.vt->op(host->graph.self, ctx, NULL, &op, &out).kind) return NULL; // above the start
		if (out.items.count && out.items.items[0].value) {
			ErmItem *item = &out.items.items[0];
			*identity = jsonObject();
			jsonAdd(*identity, "node", jsonString(item->route.count ? item->route.items[item->route.count - 1].node : ""));
			jsonAdd(*identity, "time", item->change ? jsonNumber(item->change->time) : jsonNull());
			Json *value = item->value;
			ermResultFree(&out);
			return value;
		}
		ermResultFree(&out);
	}
	return NULL;
}

static const char *pidOf(ErmTime time) {
	static const char consonants[] = "bcdfghjklmnpqrstvwxz", vowels[] = "aeiou";
	char letters[6];
	for (int i = 0; i < 5; i++) letters[i] = i % 2 ? vowels[arc4random_uniform(5)] : consonants[arc4random_uniform(20)];
	letters[5] = 0;
	return formatString("@%.0f-%s", time, letters);
}

/** a process's agent: the starter's actor, and its code with a step for the process (SCHEDULER What a process acts as) */
static Json *agentOf(Json *starter, const char *pid, Json *program) {
	Json *actor = jsonGet(starter, "actor"), *code = jsonGet(starter, "code");
	bool shaped = actor && jsonIsArray(code);
	Json *agent = jsonObject(), *steps = jsonArray();
	jsonAdd(agent, "actor", shaped ? actor : starter);
	for (int i = 0; shaped && i < code->array.count; i++) jsonPush(steps, code->array.items[i]);
	Json *step = jsonObject();
	jsonAdd(step, "process", jsonString(pid));
	jsonAdd(step, "program", program);
	jsonAdd(step, "external", jsonBoolean(true)); // it runs outside the host and has no runs (SCHEDULER What a process acts as)
	jsonPush(steps, step);
	jsonAdd(agent, "code", steps);
	return agent;
}

static Json *sizeValue(int rows, int cols) {
	Json *size = jsonObject();
	jsonAdd(size, "rows", jsonInteger(rows));
	jsonAdd(size, "cols", jsonInteger(cols));
	return size;
}

/** the process acting from the root: the host's own work as it, wherever it acts */
static ErmCtx ownCtx(Proc *proc) {
	return (ErmCtx){ .agent = proc->agent, .process = proc->pid };
}

/** makes one of its window's ephemeral nodes, as the process, under its own node */
static ErmErr makeOwn(Host *host, Proc *proc, const char *name, Json *value) {
	const char *id = formatString("%s/%s", proc->pid, name);
	ErmOp op = { .kind = ERM_OP_PLACE, .address = addressOf(&proc->address), .name = name, .id = id, .value = value, .ephemeral = true };
	ErmCtx ctx = ownCtx(proc);
	ErmResult out;
	ErmErr err = hostOp(host, &ctx, NULL, &op, &out);
	ermResultFree(&out);
	if (!err.kind) ERM_PUSH(proc->made, id);
	return err;
}

/** a program value's boolean field is true */
static bool flagged(Json *program, const char *name) {
	Json *flag = jsonGet(program, name);
	return flag && flag->type == JSON_BOOLEAN && flag->boolean;
}

ErmErr hostStart(Host *host, Json *agent, Json *cause, const ErmIds *at, Json *path, Json *value, bool scope, ErmResult *out, Proc **started) {
	ErmAddress programPath;
	if (!ermAddressFrom(path, &programPath) || programPath.ups || !programPath.names.count) return invalid("wrong-field", "program: a path of names");
	ErmCtx ctx = { .agent = agent, .place = { .names = *at } };
	Json *programId = NULL, *loaderId = NULL;
	Json *program = search(host, &ctx, &programPath, &programId);
	if (!program) return invalid("no-program", "no program at that path, searching up");
	const char *kind = jsonText(jsonGet(program, "kind"));
	if (!kind) return invalid("not-a-program", "a program is {\"kind\": k, ...}");
	ErmIds loaderNames = { 0 };
	ERM_PUSH(loaderNames, "loaders");
	ERM_PUSH(loaderNames, kind);
	ErmAddress loaderPath = { .names = loaderNames };
	Json *loaderNode = search(host, &ctx, &loaderPath, &loaderId);
	const char *name = jsonText(jsonGet(loaderNode, "loader"));
	const Loader *loader = NULL;
	for (size_t i = 0; name && i < sizeof LOADERS / sizeof *LOADERS; i++) {
		if (strcmp(LOADERS[i]->name, name) == 0) loader = LOADERS[i];
	}
	if (!loader) return invalid("no-loader", "no loader node at loaders/<kind>, or one naming a loader this host has not");
	const char *why = loader->check(program);
	if (why) return invalid("not-a-program", why);

	// the process node, under its pid; letters picked again while the graph has that id
	const char *pid = NULL;
	ErmErr err;
	for (int tries = 0; tries < 100; tries++) {
		pid = pidOf(host->clock + 1);
		ErmOp op = { .kind = ERM_OP_PLACE, .name = pid, .id = pid, .value = value ? value : jsonNull() };
		err = hostOp(host, &ctx, cause, &op, out);
		if (strcmp(codeOf(err), "exists") != 0) break;
	}
	if (err.kind) return err;

	Proc *proc = allocate(sizeof *proc);
	proc->pid = pid;
	proc->title = programPath.names.items[programPath.names.count - 1];
	proc->address = idsOf(at, pid);
	// with scope its "/" is its own node; without, it acts where it was placed, beneath the caller's "/" (the root here)
	proc->place = scope ? (ErmPlace){ proc->address, proc->address.count } : (ErmPlace){ idsOf(at, NULL), 0 };
	proc->program = programId;
	proc->loaderIdentity = loaderId;
	proc->agent = agentOf(agent, pid, programId);
	proc->agentText = jsonPrint(proc->agent);
	proc->loader = loader;
	proc->rows = 24;
	proc->cols = 80;
	proc->fd = proc->in = -1;
	ERM_PUSH(host->procs, proc);
	host->dirty = true;

	Json *screen = jsonObject();
	jsonAdd(screen, "rows", jsonInteger(proc->rows));
	jsonAdd(screen, "cols", jsonInteger(proc->cols));
	jsonAdd(screen, "lines", jsonArray());
	makeOwn(host, proc, "screen", screen);
	makeOwn(host, proc, "keys", jsonString(""));
	makeOwn(host, proc, "size", sizeValue(proc->rows, proc->cols));

	ErmCtx root = hostCtx(host);
	ErmAddress address = addressOf(&proc->address);
	host->graph.vt->subscribe(host->graph.self, &root, &address, watched, proc, &proc->watch);
	ErmIds screenAt = idsOf(&proc->address, "screen");
	ErmAddress screenAddress = addressOf(&screenAt);
	host->graph.vt->subscribe(host->graph.self, &root, &screenAddress, screenChanged, host, &proc->screenWatch);

	proc->push = flagged(program, "push");
	proc->relay = flagged(program, "relay");
	if (!loader->start(host, proc, program)) {
		hostExited(host, proc, jsonNull());
		proc = NULL;
	}
	if (started) *started = proc;
	return ermOk();
}

// windows -------------------------------------------------------------------------

ErmErr hostWriteOwn(Host *host, Proc *proc, const char *name, Json *patches) {
	ErmIds at = idsOf(&proc->address, name);
	ErmOp op = { .kind = ERM_OP_WRITE, .address = addressOf(&at), .patches = patches };
	ErmCtx ctx = ownCtx(proc);
	ErmResult out;
	Before before = collectBefore(host->collector, &ctx, &op.address);
	ErmErr err = hostOp(host, &ctx, NULL, &op, &out);
	ermResultFree(&out);
	if (!err.kind) collectAfter(host->collector, &ctx, &op.address, before, patches);
	free(at.items);
	return err;
}

/** the value the names reach from the root, read as the person, untracked; NULL for none */
static Json *readAt(Host *host, const ErmIds *names) {
	ErmOp op = { .kind = ERM_OP_READ, .address = addressOf(names) };
	ErmCtx ctx = hostCtx(host);
	ErmResult out = { 0 };
	if (host->graph.vt->op(host->graph.self, &ctx, NULL, &op, &out).kind || !out.items.count) return NULL;
	Json *value = out.items.items[0].value;
	ermResultFree(&out);
	return value;
}

Json *hostRead(Host *host, Proc *proc, const char *name) {
	ErmIds at = idsOf(&proc->address, name);
	Json *value = readAt(host, &at);
	free(at.items);
	return value;
}

static Json *snapshot(Json *value) {
	Json *patch = jsonObject(), *patches = jsonArray();
	jsonAdd(patch, "type", jsonString("snapshot"));
	jsonAdd(patch, "value", value);
	jsonPush(patches, patch);
	return patches;
}

/** a write to a window's node as the person: a change from outside any process, with its site */
static void writeAsPerson(Host *host, Proc *proc, const char *name, Json *value, Json *cause) {
	ErmIds at = idsOf(&proc->address, name);
	ErmOp op = { .kind = ERM_OP_WRITE, .address = addressOf(&at), .patches = snapshot(value) };
	ErmCtx ctx = hostCtx(host);
	ErmResult out;
	hostOp(host, &ctx, cause, &op, &out);
	ermResultFree(&out);
	free(at.items);
}

void hostResize(Host *host, Proc *proc, int rows, int cols) {
	if (rows < 1) rows = 1;
	if (cols < 1) cols = 1;
	if (rows == proc->rows && cols == proc->cols) return;
	proc->rows = rows;
	proc->cols = cols;
	writeAsPerson(host, proc, "size", sizeValue(rows, cols), SITE);
	if (hostFind(host, proc->pid) == proc) proc->loader->resized(host, proc);
}

void hostKey(Host *host, Proc *proc, const char *key) {
	writeAsPerson(host, proc, "keys", jsonString(key), SITE);
}

void hostWriteKeys(Host *host, Proc *proc, Json *keys, Json *cause) {
	writeAsPerson(host, proc, "keys", keys, cause);
}

void hostKeys(Host *host, Proc *proc, const char *bytes, size_t length) {
	proc->loader->keys(host, proc, bytes, length);
}

// windows by name ---------------------------------------------------------------------

int hostWindows(Host *host, const char **names, int max) {
	ErmOp op = { .kind = ERM_OP_DIRECTORY, .address = addressOf(&host->windows) };
	ErmCtx ctx = hostCtx(host);
	ErmResult out = { 0 };
	if (host->graph.vt->op(host->graph.self, &ctx, NULL, &op, &out).kind) return 0;
	int n = 0;
	for (int i = 0; i < out.listing.count && n < max; i++) {
		ErmEntry *entry = &out.listing.items[i];
		bool here = false;
		for (int j = 0; j < entry->items.count; j++) here = here || (entry->items.items[j].id && !entry->items.items[j].pending);
		if (here) names[n++] = entry->name; // the graph's own: it outlives the listing
	}
	ermResultFree(&out);
	return n;
}

/** a window's node's names from the root: windows, name, node */
static ErmIds windowAt(Host *host, const char *name, const char *node) {
	ErmIds at = idsOf(&host->windows, name);
	if (node) ERM_PUSH(at, node);
	return at;
}

Json *hostWindowRead(Host *host, const char *name, const char *node) {
	Proc *proc = hostFind(host, name);
	if (proc) return hostRead(host, proc, node);
	ErmIds at = windowAt(host, name, node);
	Json *value = readAt(host, &at);
	free(at.items);
	return value;
}

/** a write of a value to a window's node, as the person, with its site */
static void writeWindow(Host *host, const char *name, const char *node, Json *value, Json *cause) {
	ErmIds at = windowAt(host, name, node);
	ErmOp op = { .kind = ERM_OP_WRITE, .address = addressOf(&at), .patches = snapshot(value) };
	ErmCtx ctx = hostCtx(host);
	ErmResult out;
	hostOp(host, &ctx, cause, &op, &out);
	ermResultFree(&out);
	free(at.items);
}

void hostWindowKeys(Host *host, const char *name, const char *bytes, size_t length) {
	Proc *proc = hostFind(host, name);
	if (proc) return hostKeys(host, proc, bytes, length);
	while (length) {
		char key[16];
		size_t n = keyName(bytes, length, key);
		writeWindow(host, name, "keys", jsonString(key), SITE);
		bytes += n;
		length -= n;
	}
}

void hostWindowResize(Host *host, const char *name, int rows, int cols) {
	Proc *proc = hostFind(host, name);
	if (proc) return hostResize(host, proc, rows, cols);
	if (rows < 1) rows = 1;
	if (cols < 1) cols = 1;
	Json *size = sizeValue(rows, cols), *now = hostWindowRead(host, name, "size");
	if (now && !jsonEqual(now, size)) writeWindow(host, name, "size", size, SITE);
}

// the loop's parts ------------------------------------------------------------------

int hostPollFds(Host *host, struct pollfd *fds, Proc **owners, int max) {
	int n = 0;
	for (int i = 0; i < host->procs.count && n + 2 <= max; i++) {
		Proc *proc = host->procs.items[i];
		if (proc->fd >= 0) {
			fds[n] = (struct pollfd){ .fd = proc->fd, .events = POLLIN };
			owners[n++] = proc;
		}
		if (proc->in >= 0 && proc->wantsOut) {
			fds[n] = (struct pollfd){ .fd = proc->in, .events = POLLOUT };
			owners[n++] = proc;
		}
	}
	return n;
}

void hostReady(Host *host, Proc *proc, int fd, short revents) {
	bool alive = false;
	for (int i = 0; i < host->procs.count; i++) alive = alive || host->procs.items[i] == proc;
	if (!alive || (fd != proc->fd && fd != proc->in)) return;
	proc->loader->ready(host, proc, fd, revents);
	hostSettle(host);
}

int hostTick(Host *host) {
	int status;
	pid_t child;
	while ((child = waitpid(-1, &status, WNOHANG)) > 0) {
		for (int i = 0; i < host->procs.count; i++) {
			Proc *proc = host->procs.items[i];
			if (proc->child != child) continue;
			proc->child = 0;
			proc->status = exitStatus(status);
			hostExited(host, proc, proc->status);
			break;
		}
	}
	int wait = -1;
	double now = hostNow();
	// output closed but never reaped: it is taken as gone a second later
	for (int i = 0; i < host->procs.count; i++) {
		Proc *proc = host->procs.items[i];
		if (!proc->closed) continue;
		if (now - proc->closed >= 1) {
			proc->closed = 0;
			hostExited(host, proc, jsonNull());
			i = -1;
			now = hostNow();
		} else {
			wait = 50;
		}
	}
	for (int i = 0; i < host->procs.count; i++) {
		Proc *proc = host->procs.items[i];
		int ms = proc->loader->tick(host, proc, now);
		if (ms >= 0 && (wait < 0 || ms < wait)) wait = ms;
	}
	return wait;
}

// booting (CORE Every reason is a change; SCHEDULER Processes) ----------------------

/** a start request's "scope": true */
static bool scoped(Json *request) {
	Json *scope = jsonGet(request, "scope");
	return scope && scope->type == JSON_BOOLEAN && scope->boolean;
}

bool hostBoot(Host *host, const char *path, char **why) {
	FILE *file = fopen(path, "r");
	if (!file) {
		*why = formatString("%s: %s", path, strerror(errno));
		return false;
	}
	Speaker *boot = speakerNew(host->graph, &host->clock, (Binding){ .agent = host->agentText });
	char *line = NULL;
	size_t capacity = 0;
	ssize_t length;
	bool ok = true;
	for (int number = 1; ok && (length = getline(&line, &capacity, file)) != -1; number++) {
		while (length && (line[length - 1] == '\n' || line[length - 1] == ' ')) length--;
		if (!length || line[0] == '#') continue;
		Json *site = jsonObject();
		jsonAdd(site, "file", jsonString(path));
		jsonAdd(site, "line", jsonInteger(number));
		Json *request = jsonParse(line, (size_t)length, NULL);
		const char *cmd = jsonText(jsonGet(request, "cmd"));
		Json *answer;
		if (cmd && strcmp(cmd, "start") == 0) {
			ErmIds at = { 0 };
			Json *agent = jsonGet(request, "agent");
			Json *cause = jsonGet(request, "cause");
			ErmResult out = { 0 };
			ErmErr err = ermNamesFrom(jsonGet(request, "address"), &at)
				? hostStart(host, agent ? agent : host->agent, cause ? cause : site, &at, jsonGet(request, "program"), jsonGet(request, "value"), scoped(request), &out, NULL)
				: invalid("wrong-field", "address: a list of names from the root");
			answer = jsonObject();
			jsonAdd(answer, err.kind ? "error" : "ok", err.kind ? ermErrToJson(err) : ermChangeAnswer(&out));
		} else if (request) {
			answer = speakerRequest(boot, request, site);
			hostSettle(host);
		} else {
			answer = jsonObject();
			jsonAdd(answer, "error", jsonString("not one JSON object"));
		}
		if (!jsonGet(answer, "ok")) {
			char *text = jsonPrint(answer);
			*why = formatString("%s:%d: %s", path, number, text);
			free(text);
			ok = false;
		}
	}
	free(line);
	fclose(file);
	speakerStop(boot);
	return ok;
}

// the watchdog ---------------------------------------------------------------------

void hostTurn(Host *host, double seconds) {
	double now = hostNow();
	if (seconds >= host->lag || now - host->lagAt > 2) {
		host->lag = seconds;
		host->lagAt = now;
	}
}

double hostLag(Host *host) {
	return hostNow() - host->lagAt > 2 ? 0 : host->lag;
}

Proc *hostBehind(Host *host) {
	Proc *most = NULL;
	for (int i = 0; i < host->procs.count; i++) {
		Proc *proc = host->procs.items[i];
		if (proc->backlog >= BEHIND && (!most || proc->backlog > most->backlog)) most = proc;
	}
	return most;
}

int hostWatch(Host *host, char *out, size_t size) {
	int n = 0;
	out[0] = 0;
	double lag = hostLag(host);
	if (lag >= 0.1) n += snprintf(out + n, size - (size_t)n, "lag %.0fms", lag * 1000);
	Proc *behind = hostBehind(host);
	if (behind && (size_t)n < size) {
		n += snprintf(out + n, size - (size_t)n, "%s%s %s behind %zu kB", n ? "  " : "", behind->pid, behind->title, behind->backlog / 1024);
		if (behind->coalesced && (size_t)n < size) n += snprintf(out + n, size - (size_t)n, ", %lld coalesced", (long long)behind->coalesced);
	}
	return (size_t)n < size ? n : (int)size - 1;
}
