// files url folder (FILES.tex, A folder that is not a store), in C: a device host that lays a shared document out in a
// folder, as a mirror (st_open_mirror) with the document's node as its root. The files program runs on it (program.h,
// watch.h), on the files graph (graph.h), so an edit made in the folder is a change to the document, which sync
// (playground/together/c/sync.h) commits as any other; a change from another device arrives, and the next batch lays it out.
//
// Kept: every document's id (an ermine id: ermine/ids) a children entry reached from the root names is followed; an ephemeral node (the program's
// listing) has an id of its own and never leaves the device. A document that has not arrived is not laid out: the folder
// waits for the root's first entry, from the device's storage or the network.
//
// The device: home/.ermine/device/key, its secret key as 64 hex digits (made on the first run), and
// home/.ermine/device/sync/, Subduction's storage as store_files.c keeps it. It joins a Subduction server over a
// WebSocket, wss://galaxy.observer unless given another; ids minted for a server not on this machine end in 16 zero bytes
// (until Keyhive).
//
// One thread: a loop that waits on the server's socket, and passes the time for sync, the watcher (whose events come on
// a thread of its own, watch.h) and the batch laid out once the graph has had no change for 20 ms. SIGINT stops it: a
// last pass and batch, what is left sent. The WebSocket is opened on a thread of its own, so a server that cannot be
// reached never stalls the loop: edits are taken in and stored, and go out once it is reached. Tries again 1 s after a
// failure, doubling to 30 s, from 1 s again once joined; offline and joined are each said once.
#ifndef HOST_H
#define HOST_H

#include <stdbool.h>

#define FH_SERVER "wss://galaxy.observer"

typedef struct {
	// the document's ermine id, or "new" for a new one: its id is printed on stdout
	const char *doc;
	const char *folder;
	// where ~ is: the device is in home/.ermine/device; NULL: $HOME
	const char *home;
	// the server joined; NULL: FH_SERVER; "": none
	const char *server;
	// ms with no change before a batch is laid out; 0: 20
	unsigned quiet;
	// also every node an ermine id inside a value names (a key or a string, at any depth), followed and laid out as a
	// slot of the node whose value names it, named by the first 8 hex digits of the id after its code. Only the layout has those slots
	bool named;
} fh_options;

// runs the host until SIGINT: 0 once it stopped cleanly, else 1, with why on stderr
int fh_run(const fh_options *options);

#endif
