// speak.c: the ermine loader. A program {"kind": "ermine", "argv": [...]} runs
// with pipes for stdin and stdout and speaks PROTOCOL's lines: one request
// per line on its stdout, one answer per line on its stdin, answered by
// protocol.c as its process, at its place: started with scope, its
// window's node, chrooted there, so the only nodes it can name are its
// window's own (screen, keys, size, and what it makes there); started
// without, the node it was placed into (/windows), so it can name every
// window. Its stderr goes to the host's log. Each key typed into its window
// is written to its keys node (keyName). With "push": true in its program's
// value, its subscriptions' events are written to it as they happen, as
// lines {"sub": n, "event": e} between its answers. While it is behind
// (more than COALESCE bytes it has not read), a pushed event that is a write
// of one snapshot replaces the same sub's such event still waiting whole, so
// a busy screen never queues more than one event a sub (NOTES.md, Memory).

#define _DARWIN_C_SOURCE

#include "host.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/** bytes waiting for it past which a newer whole event replaces an older one of the same sub */
#define COALESCE (32 * 1024)

/** a pushed event that is a write of one snapshot, still waiting whole in `out`, from `start` */
typedef struct Waiting {
	int64_t sub;
	size_t start, length;
} Waiting;

typedef struct Talk {
	Speaker *speaker;
	ERM_LIST(Waiting) waiting;
	char *in;         // what it wrote that is not yet a whole line
	size_t inLength, inCapacity;
	char *out;        // answers not yet written to it
	size_t outLength, outCapacity;
} Talk;

static void append(char **buffer, size_t *length, size_t *capacity, const char *bytes, size_t n) {
	if (*length + n + 1 > *capacity) {
		*capacity = (*length + n + 1) * 2;
		*buffer = realloc(*buffer, *capacity);
		if (!*buffer) abort();
	}
	memcpy(*buffer + *length, bytes, n);
	*length += n;
}

static const char *ermineCheck(Json *program) {
	Json *argv = jsonGet(program, "argv");
	if (!jsonIsArray(argv) || !argv->array.count) return "an ermine program is {\"kind\": \"ermine\", \"argv\": [string, ...]}";
	for (int i = 0; i < argv->array.count; i++) {
		if (!jsonText(argv->array.items[i])) return "argv holds only strings";
	}
	return NULL;
}

/** an event pushed to it: a line it gets unasked, between its answers (a program whose value says "push": true) */
static void pushLine(void *data, const char *line, int64_t sub, bool whole) {
	Proc *proc = data;
	Talk *talk = proc->state;
	if (!talk) return;
	if (whole && talk->outLength >= COALESCE) {
		for (int i = 0; i < talk->waiting.count; i++) {
			Waiting old = talk->waiting.items[i];
			if (old.sub != sub) continue;
			memmove(talk->out + old.start, talk->out + old.start + old.length, talk->outLength - old.start - old.length);
			talk->outLength -= old.length;
			for (int j = i + 1; j < talk->waiting.count; j++) talk->waiting.items[j].start -= old.length;
			memmove(&talk->waiting.items[i], &talk->waiting.items[i + 1], (size_t)(talk->waiting.count - i - 1) * sizeof old);
			talk->waiting.count--;
			proc->coalesced++;
			break;
		}
	}
	size_t start = talk->outLength, length = strlen(line);
	append(&talk->out, &talk->outLength, &talk->outCapacity, line, length);
	append(&talk->out, &talk->outLength, &talk->outCapacity, "\n", 1);
	if (whole) ERM_PUSH(talk->waiting, ((Waiting){ sub, start, length + 1 }));
	proc->backlog = talk->outLength;
	proc->wantsOut = true;
}

static bool ermineStart(Host *host, Proc *proc, Json *program) {
	Json *argv = jsonGet(program, "argv");
	int toChild[2], fromChild[2];
	if (pipe(toChild) < 0) return false;
	if (pipe(fromChild) < 0) {
		close(toChild[0]);
		close(toChild[1]);
		return false;
	}
	char **args = allocate(((size_t)argv->array.count + 1) * sizeof *args);
	for (int i = 0; i < argv->array.count; i++) args[i] = (char *)jsonText(argv->array.items[i]);
	pid_t child = fork();
	if (child == 0) {
		dup2(toChild[0], 0);
		dup2(fromChild[1], 1);
		if (host->log >= 0) dup2(host->log, 2);
		for (int fd = 3; fd < 256; fd++) close(fd);
		setenv("ERMINE_PID", proc->pid, 1);
		signal(SIGPIPE, SIG_DFL);
		setpgid(0, 0);
		execvp(args[0], args);
		_exit(127);
	}
	free(args);
	close(toChild[0]);
	close(fromChild[1]);
	if (child < 0) {
		close(toChild[1]);
		close(fromChild[0]);
		return false;
	}
	fcntl(toChild[1], F_SETFL, fcntl(toChild[1], F_GETFL) | O_NONBLOCK);
	fcntl(fromChild[0], F_SETFL, fcntl(fromChild[0], F_GETFL) | O_NONBLOCK);
	Talk *talk = allocate(sizeof *talk);
	talk->speaker = speakerNew(host->graph, &host->clock,
		(Binding){ .bound = true, .agent = proc->agentText, .process = proc->pid, .place = proc->place, .relay = proc->relay, .push = proc->push ? pushLine : NULL, .pushData = proc, .collector = host->collector });
	proc->state = talk;
	proc->speaker = talk->speaker;
	proc->child = child;
	proc->fd = fromChild[0];
	proc->in = toChild[1];
	return true;
}

static void ermineKill(Host *host, Proc *proc) {
	(void)host;
	Talk *talk = proc->state;
	speakerStop(talk->speaker);
	if (proc->child) {
		kill(-proc->child, SIGHUP);
		kill(proc->child, SIGTERM);
	}
	if (proc->fd >= 0) close(proc->fd);
	if (proc->in >= 0) close(proc->in);
	proc->fd = proc->in = -1;
	free(talk->in);
	free(talk->out);
	free(talk->waiting.items);
	free(talk);
	proc->state = NULL;
	// the speaker stays: killProc reads what it made after this; like every value here, it is never freed
}

/** writes what answers it can; the rest waits for POLLOUT */
static void flushOut(Proc *proc) {
	Talk *talk = proc->state;
	while (talk->outLength) {
		ssize_t n = write(proc->in, talk->out, talk->outLength);
		if (n <= 0) break; // EAGAIN, or it closed its stdin: it will be seen exiting
		memmove(talk->out, talk->out + n, talk->outLength - (size_t)n);
		talk->outLength -= (size_t)n;
		// what has gone, even in part, can no longer be replaced
		int kept = 0;
		for (int i = 0; i < talk->waiting.count; i++) {
			Waiting w = talk->waiting.items[i];
			if (w.start < (size_t)n) continue;
			w.start -= (size_t)n;
			talk->waiting.items[kept++] = w;
		}
		talk->waiting.count = kept;
	}
	proc->backlog = talk->outLength;
	proc->wantsOut = talk->outLength > 0;
}

static void ermineReady(Host *host, Proc *proc, int fd, short revents) {
	Talk *talk = proc->state;
	if (fd == proc->in) {
		flushOut(proc);
		return;
	}
	(void)revents;
	char buffer[65536];
	ssize_t n = read(proc->fd, buffer, sizeof buffer);
	if (n < 0 && (errno == EAGAIN || errno == EINTR)) return;
	if (n <= 0) {
		close(proc->fd);
		proc->fd = -1;
		hostClosed(host, proc);
		return;
	}
	append(&talk->in, &talk->inLength, &talk->inCapacity, buffer, (size_t)n);
	size_t start = 0;
	for (size_t i = 0; i < talk->inLength; i++) {
		if (talk->in[i] != '\n') continue;
		char *answer = speakerLine(talk->speaker, talk->in + start, i - start);
		append(&talk->out, &talk->outLength, &talk->outCapacity, answer, strlen(answer));
		append(&talk->out, &talk->outLength, &talk->outCapacity, "\n", 1);
		free(answer);
		start = i + 1;
	}
	memmove(talk->in, talk->in + start, talk->inLength - start);
	talk->inLength -= start;
	flushOut(proc);
}

/**
 * The name of the key at the front of `bytes`, and how many bytes it took: a
 * character as itself; "enter", "tab", "backspace", "escape", "up", "down",
 * "left", "right", "home", "end", "pageup", "pagedown", "delete", "insert";
 * "C-a" for a control character, "M-x" for escape then a character. An
 * escape sequence it does not know is "unknown".
 */
size_t keyName(const char *bytes, size_t length, char name[16]) {
	unsigned char b = (unsigned char)bytes[0];
	if (b == 0x1b) {
		if (length == 1) return strcpy(name, "escape"), 1;
		if (bytes[1] == '[' || bytes[1] == 'O') {
			size_t end = 2;
			while (end < length && !((unsigned char)bytes[end] >= 0x40 && (unsigned char)bytes[end] <= 0x7e)) end++;
			if (end == length) return strcpy(name, "unknown"), length;
			static const char *const finals[][2] = { { "A", "up" }, { "B", "down" }, { "C", "right" }, { "D", "left" }, { "H", "home" }, { "F", "end" },
				{ "1~", "home" }, { "4~", "end" }, { "5~", "pageup" }, { "6~", "pagedown" }, { "3~", "delete" }, { "2~", "insert" } };
			strcpy(name, "unknown");
			for (size_t i = 0; i < sizeof finals / sizeof *finals; i++) {
				size_t n = strlen(finals[i][0]);
				if (end + 1 - 2 == n && memcmp(bytes + 2, finals[i][0], n) == 0) strcpy(name, finals[i][1]);
			}
			return end + 1;
		}
		size_t inner = keyName(bytes + 1, length - 1, name + 2);
		if (strlen(name + 2) > 1) return strcpy(name, "escape"), 1; // escape, then a named key: two keys
		name[0] = 'M';
		name[1] = '-';
		return inner + 1;
	}
	if (b == '\r' || b == '\n') return strcpy(name, "enter"), 1;
	if (b == '\t') return strcpy(name, "tab"), 1;
	if (b == 0x7f || b == 0x08) return strcpy(name, "backspace"), 1;
	if (b < 0x20) {
		name[0] = 'C';
		name[1] = '-';
		name[2] = (char)(b == 0 ? '@' : b + 'a' - 1);
		name[3] = 0;
		if (b > 0x1a) name[2] = (char)(b + '@');
		return 1;
	}
	size_t n = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
	if (n > length) n = length;
	memcpy(name, bytes, n);
	name[n] = 0;
	return n;
}

static void ermineKeys(Host *host, Proc *proc, const char *bytes, size_t length) {
	const char *pid = proc->pid;
	while (length && hostFind(host, pid) == proc) {
		char name[16];
		size_t n = keyName(bytes, length, name);
		hostKey(host, proc, name);
		bytes += n;
		length -= n;
	}
}

static void ermineResized(Host *host, Proc *proc) {
	(void)host;
	(void)proc; // the host wrote its size node; the program reads it, or subscribes to it
}

static int ermineTick(Host *host, Proc *proc, double now) {
	(void)host;
	(void)now;
	if (proc->wantsOut) flushOut(proc);
	return -1;
}

const Loader ermineLoader = { "ermine", ermineCheck, ermineStart, ermineKill, ermineReady, ermineKeys, ermineResized, ermineTick };
