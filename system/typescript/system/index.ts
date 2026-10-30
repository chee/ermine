// The functions programs import from @ermine/system. Each one finds the context it acts as (the
// open scope's process, or the host's) and does its work as that context, in the file of its job.
//
// Paths: a bare name is inside the process's own node, ./ is its folder, ../ is above it and / is
// the root. Nodes are given as a path or a handle. Every write and every settled promise asks for
// a pulse. Writes are patches, and each records the frame it was made under.
//
// Files in this folder:
//   shapes      the types a program is given, SendError, System
//   base        what ermine.ts builds and every function works from
//   setting     a context's base and its own state
//   scopes      the open scope: owner, marks, actor, teardown, runAs
//   addressing  nodes given as paths or handles, and a change's view
//   asking      the policy questions: read, refusal, placing a name
//   tree        names in folders
//   made        what an owner's runs made, found again by its next run
//   status      getStatus
//   the rest    nodes, reading, patching, explaining, names, computing, actions and process each
//               hold the functions of their job
//
// Removing or unplacing a node stops the memos, effects and actions made at it. Rename stops
// nothing.

// The files of this folder (ermine_test checks the list against the folder).
export const NAMES: readonly string[] = [
	"index",
	"shapes",
	"base",
	"setting",
	"scopes",
	"addressing",
	"asking",
	"tree",
	"nodes",
	"reading",
	"patching",
	"explaining",
	"names",
	"made",
	"computing",
	"actions",
	"process",
	"status",
]
