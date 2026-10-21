// away (typescript/away.ts) in C: other dens' rows over presence (presence.h) and asks over the
// channel (channel.h). same rules, held to by playground/dens/conformance/away. the away trie is
// processes.h's generic trie on the part "away".
//
//   pr_processes rows;  dn_away_init(&rows, root);       // a contributor, after processes' own
//   dn_link *l = dn_connect(d, channel, &(dn_link_setup){.topic = "M", .under = mnt, .nunder = 2});
//   unsigned n = dn_remote(l, "card", ask);              // { op: start, runner, program, at }
//   const op_value *got = dn_answer(l, n);               // { id, at } | {} | a refusal | NULL
//   dn_close(d, NULL);  ...  dn_link_free(l);  dn_free(d);
//
// each den's row: a presence row at the anchor "dens:<topic>", under its channel's name (= its
// den's id): its dn_nodes (hide_processes: none), set whole as they change (an effect) and at each
// beat, lapsing at until (a host's sweep), cleared at its stop. each other row, while it lives,
// mirrored here: the away trie gets the den's node id at under + /system/dens/<who> and each
// process's id at under + its at (a leaf there already, not a name, or in a local process's way:
// at or under its leaf, or on a level of the process trie: passed over); each node named that is
// the row's own (its den's id, a process's, or one under them: "<id>/...") is written as given
// (attributes; children, each name to an id it may write; never a value; status "pending" |
// { failed } as status.h's pending | an error). no row writes an id that is this den's (its node,
// a process it runs, or under them), nor one with entries here that this link did not write for
// that who (nor is its leaf put in); an entry only when it changed (pr_same). a row gone (cleared,
// swept): its leaves and entries out.
// asks: CBOR on "<anchor>/ask/<to>": { n, op, ..., who: { actor, reader? } }; the asked den: who
// + device (the sender's name), dn_ask with the link's scope open; the answer on
// "<anchor>/answer/<from>": { n, answer } (refused a places code: { error: code }). an answer kept
// only from the den its ask was sent to, the first. a message that does not decode, or is no ask
// or answer: dropped.
// dn_connect, a scope open: a scope [["dens", "away"], ["topic", topic]] under it, the link's: its
// effects, its writes (rows, mirrors, asks answered). topic NULL: the places' root. publish
// default: whether topic is the root. ttl 0: 10 s. its stop: its row cleared (when it published,
// its scope alive), mirrors out, listeners off, its scope torn down; twice: nothing. the den's
// close stops it (a scope [["dens", "link"]] under the den's owner, torn down at its stop); its
// scope torn down from above: the same, its row left to lapse (presence writes need its scope).
// the scheduler's values are op_values (its drop op_free's them), as dens.c's are.
// memory: what a link keeps is its own until dn_link_free (strings copied, values held), its
// world's presence too (pres_free there). a value with no encoding (a function hf holds, a
// stand-in of no kind): not sent. out of memory aborts.
// open: patches; timeouts; boxed processes; /system/den of another den
#ifndef DENS_AWAY_H
#define DENS_AWAY_H

#include "dens.h"
#include "../../../ermine/processes/c/processes.h"
#include "../../together/presence/c/presence.h"

#define DN_AWAY "away"
// the anchor and topic: "dens:" and the topic
#define DN_ANCHOR "dens:"

// the walk of the away trie at root: pr_trie_init(rows, DN_AWAY, root, "away")
void dn_away_init(pr_processes *rows, tb_key root);

typedef struct dn_link dn_link;
typedef enum { DN_PUBLISH_DEFAULT = 0, DN_PUBLISH_YES = 1, DN_PUBLISH_NO = -1 } dn_publish;
typedef struct {
	// NULL: the den's places' root
	const char *topic;
	const char *const *under;
	size_t nunder;
	// default: whether topic is the root
	dn_publish publish;
	// 1: processes left out of the row
	int hide_processes;
	// ms; 0: 10000
	int64_t ttl;
	// NULL: the wall clock
	pres_clock now;
	void *now_ctx;
} dn_link_setup;

// with a scope open. NULL: the channel's name is not the den's id, no topic, or no scope open.
// goes at the den's close. a macro: the site of the link's writes, and of its asks answered
// (dn_ask_at), is the caller's (copied; NULL: none)
dn_link *dn_connect_at(dn *d, chn_channel *channel, const dn_link_setup *setup, const ch_site *site);
#define dn_connect(...) dn_connect_at(__VA_ARGS__, CH_HERE)
void dn_announce(dn_link *l);
// the row set again (whole), until = now + ttl
void dn_beat(dn_link *l);
// stopped: none
pres_swept dn_sweep(dn_link *l);
// ask: away.ts' Remote, a map (borrowed). who: pl_change_base of the scope open's actor and
// reader. n, from 1; 0: stopped, or the ask has no encoding (nothing sent)
unsigned dn_remote(dn_link *l, const char *to, const op_value *ask);
// tracked (sc_track); NULL: none yet. borrowed until dn_link_free
const op_value *dn_answer(dn_link *l, unsigned n);
// away.ts' carry: a node of the den's at the address, as a program { id, hash?, type?, api?,
// code? } (type: its ermine.type, api: its ermine.program.api, each a string); code 1: with its
// code. new; NULL: no node there, or no value
op_value *dn_carry(dn_link *l, const char *const *at, size_t nat, int code);
// the presence world it writes in, and its anchor (away.ts' world, anchor): the link's
pres_world *dn_link_world(dn_link *l);
const char *dn_link_anchor(const dn_link *l);
// its row cleared, mirrors out, listeners off (idempotent; also at the den's close)
void dn_disconnect(dn_link *l);
// after dn_disconnect (or the den's close, or its scope torn down from above), before dn_free
void dn_link_free(dn_link *l);

#endif
