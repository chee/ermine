// protocol.h: PROTOCOL.tex's lines spoken to the host's graph by one speaker:
// a program the ermine loader runs, or the boot image. The answers are the
// graph stack's, from c/main.c's own code, with three differences that come
// from the host, not the harness: the session is the host's (reset, reload,
// batch, start and fire are unsupported), every change is stamped by the
// host's clock (a request's time is ignored), and a bound speaker acts as its
// process at its place, whatever its request says (agent, process, place and
// chroot are the host's; a request may name a place below the speaker's,
// and is then chrooted at the speaker's place, as a link's owner chroots a
// mounter's requests at the place it serves). A speaker that relays keeps
// the actor and peer of the agent a request gives, under its own code.

#ifndef TERM_PROTOCOL_H
#define TERM_PROTOCOL_H

#include "../ermine.h"
#include "collect.h"

typedef struct Speaker Speaker;

/** who a bound speaker acts as; a speaker that is not bound (the boot image) gives its own, the agent defaulting to `agent` */
typedef struct Binding {
	bool bound;
	const char *agent; // the agent's JSON text
	const char *process;
	ErmPlace place;
	/**
	 * it acts for others (a program whose value says "relay": true, as share
	 * does for its mounters): a request whose agent is an object with an
	 * "actor" keeps that actor, and its "peer" if it has one, and gets the
	 * bound agent's code, so the speaker's process is the last step
	 */
	bool relay;
	/**
	 * when set, each event of its subscriptions is handed here as it happens,
	 * as the line {"sub": n, "event": e}, and events gives nothing; `whole`
	 * says the event is a write of one snapshot to the node it reaches, which
	 * makes an earlier such event of the same sub not yet sent needless
	 */
	void (*push)(void *data, const char *line, int64_t sub, bool whole);
	void *pushData;
	/** when set, its writes to ephemeral nodes are collected, and what its requests were made of freed (collect.h) */
	Collector *collector;
} Binding;

/** a speaker of the graph `graph` (the bare one ermGraph made), stamping changes from *clock + 1, which it moves on */
Speaker *speakerNew(ErmInterface graph, ErmTime *clock, Binding binding);
/** one request line, answered as a line (a fresh C string, no newline) */
char *speakerLine(Speaker *speaker, const char *line, size_t length);
/** one request as a value, answered as a value; a change with no cause gets `cause` */
Json *speakerRequest(Speaker *speaker, Json *request, Json *cause);
/** the ephemeral nodes its requests made, in the order they were made */
const ErmIds *speakerMade(const Speaker *speaker);
/** ends every subscription it made; it answers nothing more */
void speakerStop(Speaker *speaker);
/** whether any speaker that polls holds events of the node not yet taken (they share its changes and values); `data` is unused */
bool speakersHolding(void *data, const char *node);

#endif
