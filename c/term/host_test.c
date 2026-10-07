// host_test.c: `make check`, run from c/term. The host with no screen: boot,
// start (search, loaders, pids, the window's nodes), kill (by unplacing, by
// shadowing in a union, by exiting), a program on a pty, and
// examples/counter.sh speaking lines over pipes.

#define _DARWIN_C_SOURCE

#include "host.h"

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static int failures = 0;
#define CHECK(c) \
	do { \
		if (!(c)) { \
			failures++; \
			fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); \
		} \
	} while (0)

static const char *BOOT[] = {
	"# a test boot image",
	"{\"cmd\": \"place\", \"address\": [], \"name\": \"loaders\", \"id\": \"loaders\", \"value\": null}",
	"{\"cmd\": \"place\", \"address\": [\"loaders\"], \"name\": \"pty\", \"id\": \"loader-pty\", \"value\": {\"loader\": \"pty\"}}",
	"{\"cmd\": \"place\", \"address\": [\"loaders\"], \"name\": \"ermine\", \"id\": \"loader-ermine\", \"value\": {\"loader\": \"ermine\"}}",
	"{\"cmd\": \"place\", \"address\": [\"loaders\"], \"name\": \"odd\", \"id\": \"loader-odd\", \"value\": {\"loader\": \"no such\"}}",
	"{\"cmd\": \"place\", \"address\": [], \"name\": \"programs\", \"id\": \"programs\", \"value\": null}",
	"{\"cmd\": \"place\", \"address\": [\"programs\"], \"name\": \"sleeper\", \"id\": \"sleeper\", \"value\": {\"kind\": \"pty\", \"argv\": [\"/bin/sh\", \"-c\", \"sleep 30\"]}}",
	"{\"cmd\": \"place\", \"address\": [\"programs\"], \"name\": \"hello\", \"id\": \"hello\", \"value\": {\"kind\": \"pty\", \"argv\": [\"/bin/sh\", \"-c\", \"printf 'hi\\\\033[1mB\\\\033[0m'; sleep 30\"]}}",
	"{\"cmd\": \"place\", \"address\": [\"programs\"], \"name\": \"exits\", \"id\": \"exits\", \"value\": {\"kind\": \"pty\", \"argv\": [\"/bin/sh\", \"-c\", \"exit 3\"]}}",
	"{\"cmd\": \"place\", \"address\": [\"programs\"], \"name\": \"cat\", \"id\": \"cat\", \"value\": {\"kind\": \"pty\", \"argv\": [\"/bin/cat\"]}}",
	"{\"cmd\": \"place\", \"address\": [\"programs\"], \"name\": \"raw\", \"id\": \"raw\", \"value\": {\"kind\": \"pty\", \"argv\": [\"/bin/sh\", \"-c\", \"stty raw -echo; echo ready; dd bs=1 count=1 2>/dev/null | od -An -tx1; sleep 30\"]}}",
	"{\"cmd\": \"place\", \"address\": [\"programs\"], \"name\": \"counter\", \"id\": \"counter\", \"value\": {\"kind\": \"ermine\", \"argv\": [\"/bin/sh\", \"examples/counter.sh\"]}}",
	"{\"cmd\": \"place\", \"address\": [\"programs\"], \"name\": \"clock\", \"id\": \"clock\", \"value\": {\"kind\": \"ermine\", \"argv\": [\"/bin/sh\", \"examples/clock.sh\"]}}",
	"{\"cmd\": \"place\", \"address\": [\"programs\"], \"name\": \"flood\", \"id\": \"flood\", \"value\": {\"kind\": \"pty\", \"argv\": [\"/bin/sh\", \"-c\", \"sleep 1; i=0; while [ $i -lt 150 ]; do i=$((i+1)); seq -f \\\"$i %g the quick brown fox jumps over the lazy dog, again and again\\\" 1 30; sleep 0.01; done; echo flood-done; sleep 30\"]}}",
	"{\"cmd\": \"place\", \"address\": [\"programs\"], \"name\": \"deaf\", \"id\": \"deaf\", \"value\": {\"kind\": \"ermine\", \"push\": true, \"argv\": [\"/bin/sh\", \"-c\", \"printf '{\\\"seq\\\":1,\\\"cmd\\\":\\\"subscribe\\\",\\\"address\\\":[\\\"%s\\\",\\\"screen\\\"]}\\\\n' \\\"$DEAF_AT\\\"; sleep 30\"]}}",
	"{\"cmd\": \"place\", \"address\": [\"programs\"], \"name\": \"bad\", \"id\": \"bad\", \"value\": {\"kind\": \"pty\"}}",
	"{\"cmd\": \"place\", \"address\": [\"programs\"], \"name\": \"strange\", \"id\": \"strange\", \"value\": {\"kind\": \"nowhere\", \"argv\": [\"x\"]}}",
	"{\"cmd\": \"place\", \"address\": [\"programs\"], \"name\": \"odd\", \"id\": \"odd\", \"value\": {\"kind\": \"odd\", \"argv\": [\"x\"]}}",
	"{\"cmd\": \"place\", \"address\": [], \"name\": \"windows\", \"id\": \"windows\", \"value\": null}",
	"",
	"{\"cmd\": \"start\", \"address\": [\"windows\"], \"program\": [\"programs\", \"sleeper\"], \"scope\": true}",
};

static Host *host;

static const char *codeOf(ErmErr err) {
	return err.kind ? jsonText(jsonGet(err.why, "code")) : "";
}

static Json *path(const char *json) {
	return jsonParse(json, strlen(json), NULL);
}

static ErmErr start(const char *program, Proc **proc, ErmResult *out) {
	char text[128];
	snprintf(text, sizeof text, "[\"programs\", \"%s\"]", program);
	ErmResult scratch;
	return hostStart(host, host->agent, SITE, &host->windows, path(text), NULL, true, out ? out : &scratch, proc);
}

/** the items reading an address from the root gives */
static ErmItems readAt(const char *json) {
	ErmOp op = { .kind = ERM_OP_READ };
	ermAddressFrom(path(json), &op.address);
	ErmCtx ctx = hostCtx(host);
	ErmResult out = { 0 };
	host->graph.vt->op(host->graph.self, &ctx, NULL, &op, &out);
	return out.items;
}

/** runs the host's loop until `done` says so, or the seconds are up */
static bool pump(double seconds, bool (*done)(void *), void *data) {
	double until = hostNow() + seconds;
	while (hostNow() < until) {
		hostTick(host);
		if (done(data)) return true;
		struct pollfd fds[64];
		Proc *owners[64];
		int n = hostPollFds(host, fds, owners, 64);
		if (poll(fds, (nfds_t)n, 20) <= 0) continue;
		for (int i = 0; i < n; i++) {
			if (fds[i].revents) hostReady(host, owners[i], fds[i].fd, fds[i].revents);
		}
	}
	return done(data);
}

static bool gone(void *pid) {
	return !hostFind(host, pid);
}

static bool never(void *data) {
	(void)data;
	return false;
}

/** whether the screen of the process `pid` shows `text` somewhere */
static const char *wanted;
static bool shows(void *pid) {
	Proc *proc = hostFind(host, pid);
	Json *lines = proc ? jsonGet(hostRead(host, proc, "screen"), "lines") : NULL;
	for (int i = 0; jsonIsArray(lines) && i < lines->array.count; i++) {
		const char *line = jsonText(lines->array.items[i]);
		if (line && strstr(line, wanted)) return true;
	}
	return false;
}

static bool waitFor(const char *pid, const char *text) {
	wanted = text;
	return pump(5, shows, (void *)pid);
}

/** a subscription's changes, kept */
static ERM_LIST(const ErmChange *) seen;
static void see(void *data, const ErmChange *change, const ErmItems *reaches) {
	(void)data;
	(void)reaches;
	ERM_PUSH(seen, change);
}

static void testKeyNames(void) {
	struct {
		const char *bytes, *name;
		size_t took;
	} cases[] = {
		{ "a", "a", 1 }, { "\r", "enter", 1 }, { "\t", "tab", 1 }, { "\x7f", "backspace", 1 }, { "\x01", "C-a", 1 },
		{ "\033", "escape", 1 }, { "\033[A", "up", 3 }, { "\033OB", "down", 3 }, { "\033[5~", "pageup", 4 },
		{ "\033[3~x", "delete", 4 }, { "\033x", "M-x", 2 }, { "\xc3\xa9!", "\xc3\xa9", 2 }, { "\033[99z", "unknown", 5 },
	};
	for (size_t i = 0; i < sizeof cases / sizeof *cases; i++) {
		char name[16];
		size_t took = keyName(cases[i].bytes, strlen(cases[i].bytes), name);
		CHECK(strcmp(name, cases[i].name) == 0 && took == cases[i].took);
	}
}

static void testProtocol(void) {
	// a speaker bound at /windows, chrooted there: it names nothing above
	ErmIds place = { 0 };
	ERM_PUSH(place, "windows");
	Speaker *speaker = speakerNew(host->graph, &host->clock, (Binding){ .bound = true, .agent = "\"someone\"", .process = "@1-test", .place = { place, 1 } });
	const char *up = "{\"seq\": 1, \"cmd\": \"read\", \"address\": [\"..\"]}";
	char *answer = speakerLine(speaker, up, strlen(up));
	CHECK(strstr(answer, "\"code\":\"above-root\"") && strstr(answer, "\"seq\":1") && strstr(answer, "\"op\":\"read\""));
	free(answer);
	const char *lookup = "{\"seq\": 2, \"cmd\": \"lookup\", \"name\": \"programs\"}";
	answer = speakerLine(speaker, lookup, strlen(lookup));
	CHECK(strcmp(answer, "{\"seq\":2,\"ok\":{\"items\":[]}}") == 0);
	free(answer);
	answer = speakerLine(speaker, "{\"seq\": 3, \"cmd\": \"reset\"}", strlen("{\"seq\": 3, \"cmd\": \"reset\"}"));
	CHECK(strcmp(answer, "{\"seq\":3,\"unsupported\":\"reset\"}") == 0);
	free(answer);
	answer = speakerLine(speaker, "{\"seq\": 4, ", 11);
	CHECK(strstr(answer, "\"code\":\"not-a-request\"") && strstr(answer, "\"seq\":4"));
	free(answer);
	// what it may write: its own changes carry its process and the host's time, whatever it says
	ErmTime before = host->clock;
	const char *write = "{\"seq\": 5, \"cmd\": \"place\", \"agent\": \"liar\", \"place\": [], \"time\": 1, \"address\": [], \"name\": \"note\", \"id\": \"note-1\", \"value\": 1, \"ephemeral\": true}";
	answer = speakerLine(speaker, write, strlen(write));
	CHECK(strstr(answer, "\"process\":\"@1-test\"") && strstr(answer, "\"agent\":\"someone\"") && strstr(answer, "\"node\":\"windows\""));
	CHECK(host->clock == before + 1);
	CHECK(speakerMade(speaker)->count == 1 && strcmp(speakerMade(speaker)->items[0], "note-1") == 0);
	free(answer);
	// subscriptions are numbered as its own
	const char *subscribe = "{\"seq\": 6, \"cmd\": \"subscribe\", \"address\": [\"note\"]}";
	answer = speakerLine(speaker, subscribe, strlen(subscribe));
	CHECK(strcmp(answer, "{\"seq\":6,\"ok\":{\"sub\":1}}") == 0);
	free(answer);
	const char *patch = "{\"seq\": 7, \"cmd\": \"write\", \"address\": [\"note\"], \"patches\": [{\"type\": \"snapshot\", \"value\": 2}]}";
	free(speakerLine(speaker, patch, strlen(patch)));
	answer = speakerLine(speaker, "{\"seq\": 8, \"cmd\": \"events\", \"sub\": 1}", strlen("{\"seq\": 8, \"cmd\": \"events\", \"sub\": 1}"));
	CHECK(strstr(answer, "\"ok\":[{\"change\":{\"node\":\"note-1\"") != NULL);
	free(answer);
	speakerStop(speaker);
	ErmCtx ctx = hostCtx(host);
	ErmStamp stamp = { SITE, host->clock + 1 };
	ErmResult out = { 0 };
	CHECK(!ermGraphRelease(host->graph, &ctx, &stamp, "note-1", &out).kind);
	host->clock = ermGraphLast(host->graph);
}

/** lines pushed to a speaker, kept */
static ERM_LIST(char *) pushed;
static void keepPushed(void *data, const char *line, int64_t sub, bool whole) {
	(void)data;
	(void)sub;
	(void)whole;
	ERM_PUSH(pushed, strdup(line));
}

static void testPushAndBelow(void) {
	// a speaker at /windows, not chrooted, as a program started without scope: it names every window, and above
	ErmIds place = { 0 };
	ERM_PUSH(place, "windows");
	Speaker *speaker = speakerNew(host->graph, &host->clock, (Binding){ .bound = true, .agent = "\"someone\"", .process = "@2-test", .place = { place, 0 }, .push = keepPushed });
	const char *up = "{\"seq\": 1, \"cmd\": \"read\", \"address\": [\"..\", \"programs\", \"sleeper\"]}";
	char *answer = speakerLine(speaker, up, strlen(up));
	CHECK(strstr(answer, "\"ok\":{\"items\":[{\"value\":{\"kind\":\"pty\"") != NULL);
	free(answer);
	// a request naming a place below its own is chrooted at its own: ".." is above-root
	const char *below = "{\"seq\": 2, \"cmd\": \"read\", \"place\": [], \"address\": [\"..\"]}";
	answer = speakerLine(speaker, below, strlen(below));
	CHECK(strstr(answer, "\"code\":\"above-root\"") != NULL);
	free(answer);
	const char *bad = "{\"seq\": 3, \"cmd\": \"read\", \"place\": [], \"chroot\": 2, \"address\": []}";
	answer = speakerLine(speaker, bad, strlen(bad));
	CHECK(strstr(answer, "\"code\":\"wrong-field\"") && strstr(answer, "\"field\":\"chroot\""));
	free(answer);
	// its events are pushed as they happen, {"sub": n, "event": e}, and events gives nothing
	const char *subscribe = "{\"seq\": 4, \"cmd\": \"subscribe\", \"place\": [], \"address\": []}";
	answer = speakerLine(speaker, subscribe, strlen(subscribe));
	CHECK(strcmp(answer, "{\"seq\":4,\"ok\":{\"sub\":1}}") == 0);
	free(answer);
	const char *placing = "{\"seq\": 5, \"cmd\": \"place\", \"address\": [], \"name\": \"pushed\", \"id\": \"pushed-1\", \"value\": 1, \"ephemeral\": true}";
	free(speakerLine(speaker, placing, strlen(placing)));
	CHECK(pushed.count == 1 && strncmp(pushed.items[0], "{\"sub\":1,\"event\":{\"change\":{\"node\":\"windows\"", 43) == 0);
	answer = speakerLine(speaker, "{\"seq\": 6, \"cmd\": \"events\", \"sub\": 1}", strlen("{\"seq\": 6, \"cmd\": \"events\", \"sub\": 1}"));
	CHECK(strcmp(answer, "{\"seq\":6,\"ok\":[]}") == 0);
	free(answer);
	speakerStop(speaker);
	ErmCtx ctx = hostCtx(host);
	ErmStamp stamp = { SITE, host->clock + 1 };
	ErmResult out = { 0 };
	CHECK(!ermGraphRelease(host->graph, &ctx, &stamp, "pushed-1", &out).kind);
	host->clock = ermGraphLast(host->graph);
	CHECK(pushed.count == 1); // stopped: nothing more
}

/** a speaker that relays (share): a request's actor and peer are kept, under its own code */
static void testRelay(void) {
	ErmIds place = { 0 };
	ERM_PUSH(place, "windows");
	const char *own = "{\"actor\": \"me\", \"code\": [{\"process\": \"@3-test\", \"external\": true}]}";
	Speaker *speaker = speakerNew(host->graph, &host->clock, (Binding){ .bound = true, .relay = true, .agent = own, .process = "@3-test", .place = { place, 0 } });
	const char *forOther = "{\"seq\": 1, \"cmd\": \"place\", \"agent\": {\"actor\": {\"actor\": \"bob\", \"code\": []}, \"peer\": \"k1\", \"code\": [\"forged\"]}, \"place\": [], \"address\": [], \"name\": \"relayed\", \"id\": \"relayed-1\", \"value\": 1, \"ephemeral\": true}";
	char *answer = speakerLine(speaker, forOther, strlen(forOther));
	CHECK(strstr(answer, "\"agent\":{\"actor\":{\"actor\":\"bob\",\"code\":[]},\"peer\":\"k1\",\"code\":[{\"process\":\"@3-test\",\"external\":true}]}") != NULL);
	CHECK(strstr(answer, "\"process\":\"@3-test\"") && !strstr(answer, "forged"));
	free(answer);
	// no agent, or one with no actor: its own
	const char *plain = "{\"seq\": 2, \"cmd\": \"write\", \"agent\": \"bob\", \"address\": [\"relayed\"], \"patches\": [{\"type\": \"snapshot\", \"value\": 2}]}";
	answer = speakerLine(speaker, plain, strlen(plain));
	CHECK(strstr(answer, "\"agent\":{\"actor\":\"me\",\"code\":[{\"process\":\"@3-test\",\"external\":true}]}") != NULL);
	free(answer);
	speakerStop(speaker);
	// a speaker that does not relay puts its own agent in its place
	Speaker *bound = speakerNew(host->graph, &host->clock, (Binding){ .bound = true, .agent = own, .process = "@3-test", .place = { place, 0 } });
	const char *again = "{\"seq\": 3, \"cmd\": \"write\", \"agent\": {\"actor\": \"bob\", \"peer\": \"k1\"}, \"address\": [\"relayed\"], \"patches\": [{\"type\": \"snapshot\", \"value\": 3}]}";
	answer = speakerLine(bound, again, strlen(again));
	CHECK(strstr(answer, "\"agent\":{\"actor\":\"me\",") && !strstr(answer, "k1"));
	free(answer);
	speakerStop(bound);
	ErmCtx ctx = hostCtx(host);
	ErmStamp stamp = { SITE, host->clock + 1 };
	ErmResult out = { 0 };
	CHECK(!ermGraphRelease(host->graph, &ctx, &stamp, "relayed-1", &out).kind);
	host->clock = ermGraphLast(host->graph);
}

/** a window that is no process: a node under /windows with screen, keys and size, as programs/mount keeps */
static void testPlainWindow(void) {
	ErmCtx ctx = hostCtx(host);
	ErmResult out = { 0 };
	const char *places[][3] = { { "[\"windows\"]", "plain", "plain" }, { "[\"windows\", \"plain\"]", "keys", "plain/keys" }, { "[\"windows\", \"plain\"]", "size", "plain/size" } };
	for (int i = 0; i < 3; i++) {
		ErmOp op = { .kind = ERM_OP_PLACE, .name = places[i][1], .id = places[i][2], .value = i == 2 ? path("{\"rows\": 1, \"cols\": 1}") : jsonString("") };
		ermAddressFrom(path(places[i][0]), &op.address);
		CHECK(!hostOp(host, &ctx, SITE, &op, &out).kind);
	}
	const char *names[16];
	int n = hostWindows(host, names, 16);
	bool listed = false;
	for (int i = 0; i < n; i++) listed = listed || strcmp(names[i], "plain") == 0;
	CHECK(listed);
	// keys typed into it are written to its keys node, as the person, a change each
	ErmAddress keys = { 0 };
	ermAddressFrom(path("[\"windows\", \"plain\", \"keys\"]"), &keys);
	int64_t sub;
	seen.count = 0;
	host->graph.vt->subscribe(host->graph.self, &ctx, &keys, see, NULL, &sub);
	hostWindowKeys(host, "plain", "+\033[A", 4);
	CHECK(seen.count == 2 && jsonEqual(hostWindowRead(host, "plain", "keys"), jsonString("up")));
	CHECK(seen.count == 2 && jsonEqual(seen.items[0]->agent, host->agent) && !seen.items[0]->process && jsonGet(seen.items[0]->cause, "line"));
	host->graph.vt->unsubscribe(host->graph.self, &ctx, sub);
	seen.count = 0;
	hostWindowResize(host, "plain", 5, 6);
	CHECK(jsonEqual(hostWindowRead(host, "plain", "size"), path("{\"rows\": 5, \"cols\": 6}")));
	ErmOp op = { .kind = ERM_OP_UNPLACE, .name = "plain", .id = "plain" };
	ermAddressFrom(path("[\"windows\"]"), &op.address);
	CHECK(!hostOp(host, &ctx, SITE, &op, &out).kind);
}

static void testStart(void) {
	// the boot image started a sleeper: its pid is @t-cvcvc, t its start's time
	CHECK(host->procs.count == 1);
	Proc *proc = host->procs.items[0];
	char letters[6];
	double t;
	CHECK(sscanf(proc->pid, "@%lf-%5[a-z]", &t, letters) == 2 && strlen(letters) == 5);
	CHECK(strchr("aeiou", letters[1]) && strchr("aeiou", letters[3]) && !strchr("aeiou", letters[0]) && !strchr("aeiou", letters[2]) && !strchr("aeiou", letters[4]));
	CHECK(proc->child > 0 && proc->loader == &ptyLoader);
	CHECK(strcmp(jsonText(jsonGet(proc->program, "node")), "sleeper") == 0);
	CHECK(strcmp(jsonText(jsonGet(proc->loaderIdentity, "node")), "loader-pty") == 0);
	// its agent: the person's actor, a step for it, external (it has no runs)
	Json *step = jsonGet(proc->agent, "code")->array.items[0];
	CHECK(strcmp(jsonText(jsonGet(step, "process")), proc->pid) == 0);
	CHECK(jsonEqual(jsonGet(step, "external"), path("true")));
	// started with scope: its "/" is its own node
	CHECK(proc->place.names.count == 2 && proc->place.chroot == 2);

	// a start answers its placement, at the time in its pid
	ErmResult out = { 0 };
	Proc *second = NULL;
	ErmErr err = start("sleeper", &second, &out);
	CHECK(!err.kind && second);
	CHECK(out.change && out.change->kind == ERM_PLACE && strcmp(out.change->id, second->pid) == 0);
	char time[32];
	snprintf(time, sizeof time, "@%.0f-", out.change->time);
	CHECK(strncmp(second->pid, time, strlen(time)) == 0);
	// its node, under /windows, with its window's nodes, ephemeral, made as it
	char at[128];
	snprintf(at, sizeof at, "[\"windows\", \"%s\", \"size\"]", second->pid);
	ErmItems items = readAt(at);
	CHECK(items.count == 1 && items.items[0].ephemeral && jsonEqual(items.items[0].value, path("{\"rows\": 24, \"cols\": 80}")));
	CHECK(items.count == 1 && items.items[0].change && strcmp(items.items[0].change->process, second->pid) == 0);

	// what start finds invalid
	CHECK(strcmp(codeOf(start("nothing", NULL, NULL)), "no-program") == 0);
	CHECK(strcmp(codeOf(start("bad", NULL, NULL)), "not-a-program") == 0);
	CHECK(strcmp(codeOf(start("strange", NULL, NULL)), "no-loader") == 0);
	CHECK(strcmp(codeOf(start("odd", NULL, NULL)), "no-loader") == 0);
	CHECK(host->procs.count == 2);

	// a nearer program shadows a farther one: /windows/programs/sleeper wins from /windows
	ErmCtx ctx = hostCtx(host);
	ErmOp op = { .kind = ERM_OP_PLACE, .name = "programs", .id = "near-programs", .value = jsonNull() };
	ermAddressFrom(path("[\"windows\"]"), &op.address);
	CHECK(!hostOp(host, &ctx, SITE, &op, &out).kind);
	op = (ErmOp){ .kind = ERM_OP_PLACE, .name = "sleeper", .id = "near-sleeper", .value = path("{\"kind\": \"pty\", \"argv\": [\"/bin/sh\", \"-c\", \"sleep 31\"]}") };
	ermAddressFrom(path("[\"windows\", \"programs\"]"), &op.address);
	CHECK(!hostOp(host, &ctx, SITE, &op, &out).kind);
	Proc *near = NULL;
	CHECK(!start("sleeper", &near, NULL).kind && near);
	CHECK(near && strcmp(jsonText(jsonGet(near->program, "node")), "near-sleeper") == 0);
	op = (ErmOp){ .kind = ERM_OP_UNPLACE, .name = "programs", .id = "near-programs" };
	ermAddressFrom(path("[\"windows\"]"), &op.address);
	CHECK(!hostOp(host, &ctx, SITE, &op, &out).kind);
	CHECK(host->procs.count == 3); // a program going changes nothing for a process that runs it

	// without scope it acts at the node it was placed into, with the caller's "/"
	Proc *wide = NULL;
	CHECK(!hostStart(host, host->agent, SITE, &host->windows, path("[\"programs\", \"sleeper\"]"), NULL, false, &out, &wide).kind && wide);
	CHECK(wide && wide->place.names.count == 1 && strcmp(wide->place.names.items[0], "windows") == 0 && wide->place.chroot == 0);
	// its window's nodes are still its own, made as it
	char wideAt[128];
	snprintf(wideAt, sizeof wideAt, "[\"windows\", \"%s\", \"keys\"]", wide->pid);
	items = readAt(wideAt);
	CHECK(items.count == 1 && items.items[0].change && strcmp(items.items[0].change->process, wide->pid) == 0);
	hostUnplace(host, wide, SITE);
	CHECK(host->procs.count == 3);
}

static void testKill(void) {
	// mount a process node at /peek too, to watch what its killing does to it
	Proc *proc = host->procs.items[1];
	const char *pid = proc->pid;
	pid_t child = proc->child;
	ErmCtx ctx = hostCtx(host);
	ErmResult out = { 0 };
	ErmOp op = { .kind = ERM_OP_PLACE, .name = "peek", .id = pid };
	CHECK(!hostOp(host, &ctx, SITE, &op, &out).kind);
	ErmAddress peek = { 0 };
	ermAddressFrom(path("[\"peek\"]"), &peek);
	int64_t sub;
	host->graph.vt->subscribe(host->graph.self, &ctx, &peek, see, NULL, &sub);
	char screenId[64];
	snprintf(screenId, sizeof screenId, "%s/screen", pid);

	// unplacing its node kills it: SIGHUP to its child, its ephemeral nodes let go, newest first
	ErmErr err = hostUnplace(host, proc, SITE);
	CHECK(!err.kind);
	CHECK(!hostFind(host, pid));
	ErmTime killing = host->clock - 3;
	int status = 0;
	CHECK(waitpid(child, &status, 0) == child && WIFSIGNALED(status) && WTERMSIG(status) == SIGHUP);
	CHECK(seen.count == 3);
	const char *order[] = { "size", "keys", "screen" };
	for (int i = 0; i < seen.count && i < 3; i++) {
		const ErmChange *c = seen.items[i];
		CHECK(c->kind == ERM_UNPLACE && strcmp(c->name, order[i]) == 0 && c->ephemeral && c->time == killing + 1 + i);
		CHECK(strcmp(jsonText(jsonGet(c->cause, "killed")), pid) == 0 && jsonGet(c->cause, "by")->number == killing);
		CHECK(c->process == NULL && jsonEqual(c->agent, host->agent));
	}
	CHECK(readAt("[\"peek\", \"screen\"]").count == 0);
	ErmStamp stamp = { SITE, host->clock + 1 };
	CHECK(strcmp(codeOf(ermGraphRelease(host->graph, &ctx, &stamp, screenId, &out)), "nothing-there") == 0);
	host->graph.vt->unsubscribe(host->graph.self, &ctx, sub);

	// a node placed in front of it in the union kills it too; the node stays placed
	proc = host->procs.items[0];
	pid = proc->pid;
	op = (ErmOp){ .kind = ERM_OP_PLACE, .name = pid, .id = "in-front", .hasPosition = true, .position = 0, .value = jsonNull() };
	ermAddressFrom(path("[\"windows\"]"), &op.address);
	CHECK(!hostOp(host, &ctx, SITE, &op, &out).kind);
	CHECK(!hostFind(host, pid));
	op.kind = ERM_OP_UNPLACE;
	op.value = NULL;
	op.hasPosition = false;
	CHECK(!hostOp(host, &ctx, SITE, &op, &out).kind); // and taking it away again starts nothing
	CHECK(host->procs.count == 1);

	// a program that exits has its node unplaced, as the person, the cause its site and {"exited": status}; so it is killed
	ErmAddress windows = { 0 };
	ermAddressFrom(path("[\"windows\"]"), &windows);
	host->graph.vt->subscribe(host->graph.self, &ctx, &windows, see, NULL, &sub);
	seen.count = 0;
	Proc *exits = NULL;
	CHECK(!start("exits", &exits, NULL).kind && exits);
	const char *exitsPid = exits->pid;
	CHECK(pump(5, gone, (void *)exitsPid));
	char at[128];
	snprintf(at, sizeof at, "[\"windows\", \"%s\"]", exitsPid);
	CHECK(readAt(at).count == 0);
	const ErmChange *exited = NULL;
	for (int i = 0; i < seen.count; i++) {
		if (seen.items[i]->kind == ERM_UNPLACE && strcmp(seen.items[i]->id, exitsPid) == 0) exited = seen.items[i];
	}
	CHECK(exited && jsonEqual(jsonGet(exited->cause, "exited"), path("3")) && jsonGet(exited->cause, "file") && jsonGet(exited->cause, "line"));
	CHECK(exited && jsonEqual(exited->agent, host->agent) && !exited->process);
	host->graph.vt->unsubscribe(host->graph.self, &ctx, sub);
}

static void testPty(void) {
	Proc *proc = NULL;
	CHECK(!start("hello", &proc, NULL).kind && proc);
	const char *pid = proc->pid;
	CHECK(waitFor(pid, "hiB"));
	Json *screen = hostRead(host, proc, "screen");
	Json *runs = jsonGet(screen, "styles")->array.items[0];
	CHECK(jsonEqual(runs, path("[[2, {\"bold\": true}], [3, {}]]")));
	CHECK(jsonEqual(jsonGet(screen, "cursor"), path("{\"row\": 0, \"col\": 3, \"visible\": true}")));
	// a resize writes its size node and the screen follows
	hostResize(host, proc, 10, 40);
	CHECK(jsonEqual(hostRead(host, proc, "size"), path("{\"rows\": 10, \"cols\": 40}")));
	wanted = "hiB";
	pump(0.2, never, NULL);
	CHECK(jsonGet(hostRead(host, proc, "screen"), "rows")->number == 10);
	hostUnplace(host, proc, SITE);

	// keys go to the pty: cat echoes them, the terminal echoes them
	CHECK(!start("cat", &proc, NULL).kind && proc);
	pid = proc->pid;
	hostKeys(host, proc, "ermine\r", 7);
	CHECK(waitFor(pid, "ermine"));
	Json *lines = jsonGet(hostRead(host, proc, "screen"), "lines");
	CHECK(lines->array.count == 24 && strcmp(jsonText(lines->array.items[0]), "ermine") == 0 && strcmp(jsonText(lines->array.items[1]), "ermine") == 0);
	hostUnplace(host, proc, SITE);
}

static void testKeyBytes(void) {
	struct {
		const char *name, *bytes;
		bool app;
	} cases[] = {
		{ "a", "a", false }, { "\xc3\xa9", "\xc3\xa9", false }, { "enter", "\r", false }, { "tab", "\t", false }, { "backspace", "\x7f", false },
		{ "escape", "\033", false }, { "up", "\033[A", false }, { "up", "\033OA", true }, { "end", "\033OF", true }, { "pagedown", "\033[6~", false },
		{ "delete", "\033[3~", false }, { "C-a", "\x01", false }, { "C-c", "\x03", false }, { "C-z", "\x1a", false }, { "C-_", "\x1f", false },
		{ "M-x", "\033x", false }, { "M-up", "\033\033[A", false }, { "unknown", "", false },
	};
	for (size_t i = 0; i < sizeof cases / sizeof *cases; i++) {
		char out[16];
		int n = keyBytes(cases[i].name, cases[i].app, out);
		CHECK(n == (int)strlen(cases[i].bytes) && memcmp(out, cases[i].bytes, (size_t)n) == 0);
	}
	// no key's name: typed as it is
	const char *raw[] = { "hello", "C-", "M-", "\033[24~", "" };
	for (size_t i = 0; i < sizeof raw / sizeof *raw; i++) {
		char out[16];
		CHECK(keyBytes(raw[i], false, out) == -1);
	}
}

/** the screen's first line of the process `pid` is exactly `wanted` */
static bool firstLine(void *pid) {
	Proc *proc = hostFind(host, pid);
	Json *lines = proc ? jsonGet(hostRead(host, proc, "screen"), "lines") : NULL;
	return jsonIsArray(lines) && lines->array.count && jsonText(lines->array.items[0]) && strcmp(jsonText(lines->array.items[0]), wanted) == 0;
}

/** the file `wanted` names holds `length` bytes */
static size_t sinkLength;
static bool sinkFull(void *data) {
	(void)data;
	FILE *file = fopen(wanted, "r");
	if (!file) return false;
	fseek(file, 0, SEEK_END);
	long length = ftell(file);
	fclose(file);
	return length >= (long)sinkLength;
}

/** a pty's keys come from its keys node only: typed here, as the person; written there by another agent; a paste; C-c */
static void testPtyKeys(void) {
	Proc *proc = NULL;
	CHECK(!start("cat", &proc, NULL).kind && proc);
	const char *pid = proc->pid;
	char at[128];
	snprintf(at, sizeof at, "[\"windows\", \"%s\", \"keys\"]", pid);
	ErmCtx root = hostCtx(host);
	ErmAddress keysAt = { 0 };
	ermAddressFrom(path(at), &keysAt);
	int64_t sub;
	seen.count = 0;
	host->graph.vt->subscribe(host->graph.self, &root, &keysAt, see, NULL, &sub);
	// typed here: one change, as the person, with pty.c's site, the keys' names; shown once (the tty's echo), not twice
	hostKeys(host, proc, "abc", 3);
	CHECK(seen.count == 1 && jsonEqual(hostRead(host, proc, "keys"), path("[\"a\", \"b\", \"c\"]")));
	CHECK(seen.count == 1 && jsonEqual(seen.items[0]->agent, host->agent) && !seen.items[0]->process);
	CHECK(seen.count == 1 && strstr(jsonText(jsonGet(seen.items[0]->cause, "file")), "pty.c") && strcmp(jsonText(jsonGet(seen.items[0]->cause, "function")), "ptyKeys") == 0);
	wanted = "abc";
	CHECK(pump(5, firstLine, (void *)pid));
	// the same key twice is two changes, and two keys
	hostKeys(host, proc, "z", 1);
	hostKeys(host, proc, "z", 1);
	CHECK(seen.count == 3 && jsonEqual(hostRead(host, proc, "keys"), path("\"z\"")));
	wanted = "abczz";
	CHECK(pump(5, firstLine, (void *)pid));
	// C-h is not backspace's 0x7f: written as its byte, so the pty gets what was typed (the tty echoes it as ^H, not erasing)
	hostKeys(host, proc, "\b\033[A", 4);
	CHECK(jsonEqual(hostRead(host, proc, "keys"), path("[\"\\b\", \"up\"]")));
	wanted = "abczz^H^[[A";
	CHECK(pump(5, firstLine, (void *)pid));
	hostKeys(host, proc, "\x15", 1); // C-u: the tty drops the line
	CHECK(jsonEqual(hostRead(host, proc, "keys"), path("\"C-u\"")));
	wanted = "";
	CHECK(pump(5, firstLine, (void *)pid));
	// written to the keys node by another agent (a mounter, through share): typed into the pty, once
	Json *bob = path("{\"actor\": {\"actor\": \"bob\", \"code\": []}, \"peer\": \"k1\", \"code\": [{\"process\": \"@9-share\", \"external\": true}]}");
	ErmCtx other = { .agent = bob, .process = "@9-share" };
	ErmResult out;
	ErmOp op = { .kind = ERM_OP_WRITE, .address = keysAt, .patches = path("[{\"type\": \"snapshot\", \"value\": \"x\"}]") };
	CHECK(!hostOp(host, &other, SITE, &op, &out).kind);
	op.patches = path("[{\"type\": \"snapshot\", \"value\": [\"y\", \"enter\"]}]");
	CHECK(!hostOp(host, &other, SITE, &op, &out).kind);
	CHECK(waitFor(pid, "xy"));
	pump(0.2, never, NULL);
	Json *lines = jsonGet(hostRead(host, proc, "screen"), "lines");
	int xy = 0;
	for (int i = 0; i < lines->array.count; i++) xy += strcmp(jsonText(lines->array.items[i]), "xy") == 0;
	CHECK(xy == 2); // the tty's echo, then cat's
	ErmItems items = readAt(at);
	CHECK(items.count == 1 && items.items[0].change && jsonEqual(items.items[0].change->agent, bob));
	host->graph.vt->unsubscribe(host->graph.self, &root, sub);
	hostUnplace(host, proc, SITE);

	// a paste: one read of many keys is one change, a list, and every byte reaches the program
	char sink[] = "/tmp/ermine-term-sink-XXXXXX";
	close(mkstemp(sink));
	ErmOp place = { .kind = ERM_OP_PLACE, .name = "sink", .id = "sink", .value = jsonObject() };
	ermAddressFrom(path("[\"programs\"]"), &place.address);
	Json *argv = jsonArray();
	jsonPush(argv, jsonString("/bin/sh"));
	jsonPush(argv, jsonString("-c"));
	jsonPush(argv, jsonString(formatString("stty -echo; echo ready; cat > %s", sink)));
	jsonAdd(place.value, "kind", jsonString("pty"));
	jsonAdd(place.value, "argv", argv);
	CHECK(!hostOp(host, &root, SITE, &place, &out).kind);
	CHECK(!start("sink", &proc, NULL).kind && proc);
	pid = proc->pid;
	CHECK(waitFor(pid, "ready"));
	enum { LINES = 300, WIDTH = 70 }; // 21300 bytes
	char paste[LINES * (WIDTH + 1) + 1], expect[sizeof paste];
	for (int l = 0, k = 0; l < LINES; l++) {
		for (int c = 0; c < WIDTH; c++, k++) paste[k] = expect[k] = (char)('!' + (l * 7 + c) % 94);
		paste[k] = '\r';
		expect[k++] = '\n';
	}
	paste[sizeof paste - 1] = expect[sizeof expect - 1] = 0;
	snprintf(at, sizeof at, "[\"windows\", \"%s\", \"keys\"]", pid);
	ermAddressFrom(path(at), &keysAt);
	seen.count = 0;
	host->graph.vt->subscribe(host->graph.self, &root, &keysAt, see, NULL, &sub);
	hostKeys(host, proc, paste, strlen(paste));
	CHECK(seen.count == 1);
	Json *keys = hostRead(host, proc, "keys");
	CHECK(jsonIsArray(keys) && keys->array.count == LINES * (WIDTH + 1));
	wanted = sink;
	sinkLength = strlen(expect);
	CHECK(pump(5, sinkFull, NULL));
	FILE *file = fopen(sink, "r");
	char got[sizeof expect] = { 0 };
	size_t n = file ? fread(got, 1, sizeof got - 1, file) : 0;
	if (file) fclose(file);
	CHECK(n == strlen(expect) && strcmp(got, expect) == 0);
	unlink(sink);
	host->graph.vt->unsubscribe(host->graph.self, &root, sub);
	hostUnplace(host, proc, SITE);

	// C-c, as a name written there, reaches the pty as 0x03 (raw: no signal)
	CHECK(!start("raw", &proc, NULL).kind && proc);
	pid = proc->pid;
	CHECK(waitFor(pid, "ready"));
	snprintf(at, sizeof at, "[\"windows\", \"%s\", \"keys\"]", pid);
	ermAddressFrom(path(at), &op.address);
	op.patches = path("[{\"type\": \"snapshot\", \"value\": \"C-c\"}]");
	CHECK(!hostOp(host, &other, SITE, &op, &out).kind);
	CHECK(waitFor(pid, "03"));
	hostUnplace(host, proc, SITE);
	// and C-c typed here too
	CHECK(!start("raw", &proc, NULL).kind && proc);
	pid = proc->pid;
	CHECK(waitFor(pid, "ready"));
	hostKeys(host, proc, "\x03", 1);
	CHECK(jsonEqual(hostRead(host, proc, "keys"), path("\"C-c\"")));
	CHECK(waitFor(pid, "03"));
	hostUnplace(host, proc, SITE);
}

static void testErmine(void) {
	Proc *proc = NULL;
	CHECK(!start("counter", &proc, NULL).kind && proc);
	const char *pid = proc->pid;
	CHECK(proc->loader == &ermineLoader);
	CHECK(waitFor(pid, "count: 0"));
	hostKey(host, proc, "+");
	hostKey(host, proc, "up");
	CHECK(waitFor(pid, "count: 2"));
	CHECK(waitFor(pid, "last key: up"));
	// its screen's change was made by it, as its process
	char at[128];
	snprintf(at, sizeof at, "[\"windows\", \"%s\", \"screen\"]", pid);
	ErmItems items = readAt(at);
	CHECK(items.count == 1 && items.items[0].change && strcmp(items.items[0].change->process, pid) == 0);
	// a resize reaches it through its subscription to size
	hostResize(host, proc, 7, 30);
	wanted = "count: 2";
	for (double until = hostNow() + 5; hostNow() < until;) {
		pump(0.05, never, NULL);
		if (jsonGet(hostRead(host, proc, "screen"), "rows")->number == 7) break;
	}
	CHECK(jsonGet(hostRead(host, proc, "screen"), "rows")->number == 7);
	// q: it exits, and its window goes
	hostKey(host, proc, "q");
	CHECK(pump(5, gone, (void *)pid));

	// the clock draws the time, a line of its screen in bold
	CHECK(!start("clock", &proc, NULL).kind && proc);
	pid = proc->pid;
	CHECK(waitFor(pid, ":"));
	Json *styles = jsonGet(hostRead(host, proc, "screen"), "styles");
	CHECK(jsonIsArray(styles) && styles->array.count == 24);
	CHECK(jsonIsArray(styles) && strstr(jsonPrint(styles->array.items[12]), "\"bold\":true"));
	hostUnplace(host, proc, SITE);
	CHECK(!hostFind(host, pid));
}

static void testMemory(void) {
	// a pty that floods (150 screens of text, 10 ms apart): its frames are
	// written as one snapshot each, sharing the rows that did not change, and
	// what earlier frames left is freed
	Proc *flood = NULL;
	CHECK(!start("flood", &flood, NULL).kind && flood);
	const char *pid = flood->pid;
	// a program that subscribes to its screen, with push, and never reads what it is sent
	setenv("DEAF_AT", pid, 1);
	Proc *deaf = NULL;
	ErmResult out;
	CHECK(!hostStart(host, host->agent, SITE, &host->windows, path("[\"programs\", \"deaf\"]"), NULL, false, &out, &deaf).kind && deaf);
	pump(0.5, never, NULL); // it subscribes; the flood starts a second after it started
	size_t before = collectFreed(host->collector);
	CHECK(waitFor(pid, "flood-done"));
	CHECK(waitFor(pid, "150 30 the quick"));
	CHECK(collectFreed(host->collector) > before + 1000);
	// the screen is whole: 24 rows, the last lines of the flood among them
	Json *screen = hostRead(host, flood, "screen");
	Json *lines = jsonGet(screen, "lines");
	CHECK(jsonIsArray(lines) && lines->array.count == 24);
	CHECK(jsonIsArray(jsonGet(screen, "styles")) && jsonGet(screen, "styles")->array.count == 24);
	// what waits for the deaf program stays bounded: newer screens replaced older ones
	CHECK(deaf->coalesced > 0);
	CHECK(deaf->backlog < 256 * 1024);
	char watch[160];
	hostWatch(host, watch, sizeof watch);
	CHECK(deaf->backlog < BEHIND || strstr(watch, "behind") != NULL);
	hostUnplace(host, deaf, SITE);
	hostUnplace(host, flood, SITE);
	// the watchdog says when a turn of the loop was slow
	hostTurn(host, 0.25);
	hostWatch(host, watch, sizeof watch);
	CHECK(strstr(watch, "lag 250ms") != NULL);
}

int main(void) {
	signal(SIGPIPE, SIG_IGN);
	char file[] = "/tmp/ermine-term-boot-XXXXXX";
	int fd = mkstemp(file);
	FILE *boot = fdopen(fd, "w");
	for (size_t i = 0; i < sizeof BOOT / sizeof *BOOT; i++) fprintf(boot, "%s\n", BOOT[i]);
	fclose(boot);
	host = hostNew("root");
	char *why = NULL;
	bool booted = hostBoot(host, file, &why);
	unlink(file);
	CHECK(booted);
	if (!booted) {
		fprintf(stderr, "boot: %s\n", why);
		return 1;
	}
	testKeyNames();
	testProtocol();
	testPushAndBelow();
	testRelay();
	testPlainWindow();
	testStart();
	testKill();
	testPty();
	testKeyBytes();
	testPtyKeys();
	testErmine();
	testMemory();
	// quitting: unplacing /windows kills what is left
	ErmCtx ctx = hostCtx(host);
	ErmOp op = { .kind = ERM_OP_UNPLACE, .name = "windows", .id = "windows" };
	ErmResult out;
	CHECK(!hostOp(host, &ctx, SITE, &op, &out).kind);
	CHECK(host->procs.count == 0);
	while (waitpid(-1, NULL, 0) > 0) {}
	if (failures) {
		fprintf(stderr, "host: %d failed\n", failures);
		return 1;
	}
	printf("host: all passed\n");
	return 0;
}
