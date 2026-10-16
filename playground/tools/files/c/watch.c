// watch.c: the watcher. See watch.h; the rules, and the order of every step, are watch.ts's.
#ifdef __linux__
#define _GNU_SOURCE
#endif

#include "watch.h"

#include "../../../ermine/encoding/c/cbor.h"
#include "names.h"
#include "sys.h"

#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#ifdef __APPLE__
#include <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>
#endif
#ifdef __linux__
#include <dirent.h>
#include <poll.h>
#include <sys/inotify.h>
#endif

#define own layout_own
#define grab layout_grab
#define fmt(...) own(formatString(__VA_ARGS__))

struct fw {
	fw_options o;
	bool running;
	char *actor;
	// events, noted by another thread
	pthread_mutex_t lock;
	char **touched;
	size_t touched_length, touched_capacity;
	bool all, pending;
	double last;
	bool events;
#ifdef __APPLE__
	FSEventStreamRef stream;
	dispatch_queue_t queue;
#endif
#ifdef __linux__
	int fd;
	pthread_t thread;
	bool running;
	int *wds;
	char **wpaths;
	size_t wlength, wcapacity;
#endif
};

static double now_ms(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (double)t.tv_sec * 1000 + (double)t.tv_nsec / 1e6;
}

static const char *parent_of(const char *path) {
	const char *slash = strrchr(path, '/');
	return slash ? own(copyStringOfLength(path, (size_t)(slash - path))) : "";
}

static void tell(const fw *w, const char *path, const char *why) {
	if (w->o.list) w->o.list(w->o.context, path, why);
}

// events ---------------------------------------------------------------------------------------------------------------

// a path's folder from the store's, or NULL for one in .ermine that is not the root's file; *file: it is the root's file
static const char *inside(const fw *w, const char *path) {
	const char *folder = st_folder(w->o.store);
	size_t n = strlen(folder);
	if (strcmp(path, folder) != 0 && !(strncmp(path, folder, n) == 0 && path[n] == '/')) return NULL;
	const char *p = strcmp(path, folder) == 0 ? "" : path + n + 1;
	if (strcmp(p, ".ermine") == 0) return NULL;
	if (strncmp(p, ".ermine/", 8) == 0) {
		const char *rest = p + 8;
		if (!(strncmp(rest, "root.", 5) == 0 && !strchr(rest, '/'))) return NULL;
	}
	return p;
}

static void note(fw *w, const char *path, bool rescan) {
	pthread_mutex_lock(&w->lock);
	if (rescan) w->all = true, w->pending = true, w->last = now_ms();
	const char *p = path ? inside(w, path) : NULL;
	if (p) {
		w->pending = true, w->last = now_ms();
		if (strncmp(p, ".ermine/", 8) != 0 && !w->all) {
			const char *dir = parent_of(p);
			bool have = false;
			for (size_t i = 0; i < w->touched_length; i++)
				if (strcmp(w->touched[i], dir) == 0) have = true;
			if (!have) {
				if (w->touched_length == w->touched_capacity) {
					w->touched_capacity = w->touched_capacity ? w->touched_capacity * 2 : 16;
					w->touched = realloc(w->touched, w->touched_capacity * sizeof *w->touched);
					if (!w->touched) abort();
				}
				w->touched[w->touched_length++] = strdup(dir);
			}
		}
	}
	pthread_mutex_unlock(&w->lock);
}

#ifdef __APPLE__
static void on_events(ConstFSEventStreamRef stream, void *info, size_t count, void *paths, const FSEventStreamEventFlags flags[], const FSEventStreamEventId ids[]) {
	(void)stream, (void)ids;
	fw *w = info;
	char **list = paths;
	for (size_t i = 0; i < count; i++) {
		bool dropped = flags[i] & (kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagUserDropped | kFSEventStreamEventFlagKernelDropped);
		note(w, list[i], dropped);
	}
}

static void events_start(fw *w) {
	CFStringRef path = CFStringCreateWithCString(NULL, st_folder(w->o.store), kCFStringEncodingUTF8);
	CFArrayRef paths = CFArrayCreate(NULL, (const void **)&path, 1, &kCFTypeArrayCallBacks);
	FSEventStreamContext context = {0, w, NULL, NULL, NULL};
	w->stream = FSEventStreamCreate(NULL, on_events, &context, paths, kFSEventStreamEventIdSinceNow, 0.05, kFSEventStreamCreateFlagFileEvents);
	CFRelease(paths);
	CFRelease(path);
	w->queue = dispatch_queue_create("party.chee.ermine.watch", DISPATCH_QUEUE_SERIAL);
	FSEventStreamSetDispatchQueue(w->stream, w->queue);
	FSEventStreamStart(w->stream);
}

static void events_stop(fw *w) {
	if (!w->stream) return;
	FSEventStreamStop(w->stream);
	FSEventStreamInvalidate(w->stream);
	FSEventStreamRelease(w->stream);
	dispatch_release(w->queue);
	w->stream = NULL;
}
#endif

#ifdef __linux__
static void add_watch(fw *w, const char *abs) {
	int wd = inotify_add_watch(w->fd, abs, IN_CREATE | IN_DELETE | IN_MODIFY | IN_MOVED_FROM | IN_MOVED_TO | IN_ATTRIB | IN_CLOSE_WRITE);
	if (wd < 0) return;
	if (w->wlength == w->wcapacity) {
		w->wcapacity = w->wcapacity ? w->wcapacity * 2 : 64;
		w->wds = realloc(w->wds, w->wcapacity * sizeof *w->wds);
		w->wpaths = realloc(w->wpaths, w->wcapacity * sizeof *w->wpaths);
		if (!w->wds || !w->wpaths) abort();
	}
	w->wds[w->wlength] = wd;
	w->wpaths[w->wlength++] = strdup(abs);
	DIR *d = opendir(abs);
	if (!d) return;
	for (struct dirent *e; (e = readdir(d));) {
		if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
		char *child = formatString("%s/%s", abs, e->d_name);
		struct stat s;
		if (lstat(child, &s) == 0 && S_ISDIR(s.st_mode)) add_watch(w, child);
		free(child);
	}
	closedir(d);
}

static void *reader(void *arg) {
	fw *w = arg;
	char buffer[16384] __attribute__((aligned(8)));
	while (w->running) {
		struct pollfd p = {w->fd, POLLIN, 0};
		if (poll(&p, 1, 100) <= 0) continue;
		ssize_t n = read(w->fd, buffer, sizeof buffer);
		if (n <= 0) continue;
		for (char *at = buffer; at < buffer + n;) {
			struct inotify_event *e = (struct inotify_event *)at;
			at += sizeof *e + e->len;
			if (e->mask & IN_Q_OVERFLOW) {
				note(w, NULL, true);
				continue;
			}
			const char *dir = NULL;
			for (size_t i = 0; i < w->wlength; i++)
				if (w->wds[i] == e->wd) dir = w->wpaths[i];
			if (!dir) continue;
			char *path = e->len ? formatString("%s/%s", dir, e->name) : strdup(dir);
			if ((e->mask & IN_CREATE) && (e->mask & IN_ISDIR)) add_watch(w, path);
			note(w, path, false);
			free(path);
		}
	}
	return NULL;
}

static void events_start(fw *w) {
	w->fd = inotify_init1(IN_CLOEXEC);
	if (w->fd < 0) return;
	add_watch(w, st_folder(w->o.store));
	w->running = true;
	pthread_create(&w->thread, NULL, reader, w);
}

static void events_stop(fw *w) {
	if (!w->running) return;
	w->running = false;
	pthread_join(w->thread, NULL);
	close(w->fd);
	for (size_t i = 0; i < w->wlength; i++) free(w->wpaths[i]);
	free(w->wds), free(w->wpaths);
	w->wds = NULL, w->wpaths = NULL, w->wlength = w->wcapacity = 0;
}
#endif

#if !defined(__APPLE__) && !defined(__linux__)
static void events_start(fw *w) { (void)w; }
static void events_stop(fw *w) { (void)w; }
#endif

// the passes ------------------------------------------------------------------------------------------------------------

static const char *abs_(const fw *w, const char *path) {
	return path[0] ? fmt("%s/%s", st_folder(w->o.store), path) : st_folder(w->o.store);
}

// a new folder's contents, all the way down; an alias as a link
static fp_edit *expand(fw *w, const st_difference *ds, size_t count) {
	fp_edit *out = grab((count + 1) * sizeof *out);
	const char *folder = st_folder(w->o.store);
	size_t flen = strlen(folder);
	for (size_t i = 0; i < count; i++) {
		const st_difference *d = &ds[i];
		fp_edit *e = &out[i];
		*e = (fp_edit){d->path, d->was, d->now, false, NULL, 0};
		if (w->o.alias && d->now && d->now->kind == ST_FILE && !d->was) {
			char *to = w->o.alias(w->o.context, abs_(w, d->path));
			if (to) {
				const char *target;
				if (strcmp(to, folder) == 0) target = layout_relative(parent_of(d->path), "");
				else if (strncmp(to, folder, flen) == 0 && to[flen] == '/') target = layout_relative(parent_of(d->path), to + flen + 1);
				else target = own(copyString(to));
				st_entry *n = grab(sizeof *n);
				n->kind = ST_LINK;
				n->target = target;
				e->now = n;
				e->was = NULL;
				free(to);
			}
		}
		if (d->now && d->now->kind == ST_FOLDER && (!d->was || d->was->kind != LAID_FOLDER)) {
			const st_difference *found;
			size_t length;
			const char *path = d->path;
			if (st_differences(w->o.store, &path, 1, &found, &length) == ST_OK) {
				size_t plen = strlen(path);
				st_difference *more = grab((length + 1) * sizeof *more);
				size_t k = 0;
				for (size_t j = 0; j < length; j++)
					if (strncmp(found[j].path, path, plen) == 0 && found[j].path[plen] == '/') more[k++] = found[j];
				e->has_inside = true;
				e->inside = expand(w, more, k);
				e->inside_length = k;
			}
		}
	}
	return out;
}

// what edit answered, done on disk
static void after(fw *w, const fp_done *done) {
	st_store *store = w->o.store;
	for (size_t i = 0; i < done->marks_length; i++) {
		const char *p = abs_(w, done->marks[i].path);
		if (sys_set(p, SYS_ID, (const uint8_t *)done->marks[i].id, strlen(done->marks[i].id)) != 0) tell(w, done->marks[i].path, strerror(errno));
	}
	for (size_t i = 0; i < done->slots_length; i++) {
		Json *pair = jsonArray();
		jsonPush(pair, jsonString(done->slots[i].holder));
		jsonPush(pair, jsonString(done->slots[i].slot));
		size_t cap = strlen(done->slots[i].holder) + strlen(done->slots[i].slot) * 2 + 64, length = 0;
		unsigned char *bytes = malloc(cap);
		const char *why;
		if (bytes && cborEncode(pair, bytes, cap, &length, &why) && sys_set(abs_(w, done->slots[i].path), SYS_SLOT, bytes, length) != 0)
			tell(w, done->slots[i].path, strerror(errno));
		free(bytes);
		jsonFree(pair);
	}
	for (size_t i = 0; i < done->unside_length; i++)
		if (sys_unset(abs_(w, done->unside[i]), SYS_SIDE) != 0) tell(w, done->unside[i], strerror(errno));
	for (size_t i = 0; i < done->clear_length; i++) {
		const char *p = abs_(w, done->clear[i]);
		if (unlink(p) != 0 && errno != ENOENT) {
			if (errno == EISDIR || errno == EPERM) {
				if (rmdir(p) != 0 && errno != ENOENT) tell(w, done->clear[i], strerror(errno));
			} else tell(w, done->clear[i], strerror(errno));
		}
	}
	for (size_t i = 0; i < done->trash_length; i++) {
		struct stat s;
		if (lstat(abs_(w, done->trash[i].path), &s) != 0) continue;
		if (st_trash(store, done->trash[i].path, done->trash[i].why) != ST_OK) tell(w, done->trash[i].path, st_message(store));
	}
	if (done->mend_length) {
		// each path once, in the order given
		const char **paths = grab((done->mend_length + 1) * sizeof *paths);
		size_t n = 0;
		for (size_t i = 0; i < done->mend_length; i++) {
			bool dup = false;
			for (size_t j = 0; j < n; j++)
				if (strcmp(paths[j], done->mend[i]) == 0) dup = true;
			if (!dup) paths[n++] = done->mend[i];
		}
		if (st_mend(store, paths, n) != ST_OK) tell(w, "", st_message(store));
	}
}

void fw_pass(fw *w, const char *const *touched, size_t count, bool *called) {
	*called = false;
	if (!w->running) return;
	const st_difference *found;
	size_t length;
	if (st_differences(w->o.store, touched, count, &found, &length) != ST_OK) {
		tell(w, "", st_message(w->o.store));
		return;
	}
	// what is in a new folder comes once, as its inside
	fp_edit *ds = expand(w, found, length);
	const char **folders = grab((length + 1) * sizeof *folders);
	size_t nf = 0;
	for (size_t i = 0; i < length; i++)
		if (ds[i].has_inside) folders[nf++] = ds[i].path;
	fp_edit *edits = grab((length + 1) * sizeof *edits);
	size_t ne = 0;
	for (size_t i = 0; i < length; i++) {
		bool in = false;
		for (size_t k = 0; k < nf; k++) {
			size_t n = strlen(folders[k]);
			if (strncmp(ds[i].path, folders[k], n) == 0 && ds[i].path[n] == '/') in = true;
		}
		if (!in) edits[ne++] = ds[i];
	}
	if (!ne) return;
	const fp_done *done = fp_edit_in(w->o.program, edits, ne, w->actor);
	if (!done) {
		tell(w, "", fmt("edit failed: %s", fp_message(w->o.program)));
		return;
	}
	*called = true;
	after(w, done);
	if (w->o.save) w->o.save(w->o.context);
}

bool fw_poll(fw *w, bool *called) {
	*called = false;
	pthread_mutex_lock(&w->lock);
	bool due = w->pending && now_ms() - w->last >= (double)(w->o.quiet ? w->o.quiet : 100);
	char **touched = NULL;
	size_t count = 0;
	bool all = w->all;
	if (due) {
		if (!all) touched = w->touched, count = w->touched_length;
		else {
			for (size_t i = 0; i < w->touched_length; i++) free(w->touched[i]);
			free(w->touched);
		}
		w->touched = NULL, w->touched_length = w->touched_capacity = 0;
		w->all = false, w->pending = false;
	}
	pthread_mutex_unlock(&w->lock);
	if (!due) return false;
	fw_pass(w, all ? NULL : (const char *const *)touched, count, called);
	for (size_t i = 0; i < count; i++) free(touched[i]);
	free(touched);
	// what the pass was given back, and the store built for it, let go of: the store's too, not the layout's arena alone
	st_release(w->o.store);
	return true;
}

static void start(void *context) {
	fw *w = context;
	w->running = true;
	w->all = true;
	if (w->o.events) {
		events_start(w);
		w->pending = true, w->last = now_ms();
	}
}

static void stop(void *context) {
	fw *w = context;
	w->running = false;
	events_stop(w);
}

fw *fw_new(const fw_options *options) {
	fw *w = calloc(1, sizeof *w);
	if (!w) abort();
	w->o = *options;
	const char *user = options->actor ? options->actor : getenv("USER");
	w->actor = strdup(user ? user : "user");
	pthread_mutex_init(&w->lock, NULL);
	w->all = true;
	return w;
}

void fw_free(fw *w) {
	if (!w) return;
	events_stop(w);
	for (size_t i = 0; i < w->touched_length; i++) free(w->touched[i]);
	free(w->touched);
	pthread_mutex_destroy(&w->lock);
	free(w->actor);
	free(w);
}

fp_watch fw_watch(fw *w) {
	return (fp_watch){start, stop, w};
}
