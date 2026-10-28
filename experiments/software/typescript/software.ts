// software: run a program through a loader. a program is a node: its value is the code. a loader is
// an action (@ermine/system's createAction), placed by whoever has it; called with (program, at) it
// starts a process at `at` whose setup reads the program and runs what the loader made of it.
// the process is started inside the loader's action, so it belongs to the scope that placed the
// loader: kill the loader, and what it ran goes [chee 10-27: "whatever naturally emerges is right"]
//
//   createLoader("loaders/js", (code, program) => () => eval(code))    // placed by the host or a process
//   run("/loaders/js", "/apps/clock.js", "/work/clock")                // { process, stop, status } | { refused: "taken", at }
//
// finding a loader (matching a program's needs to a loader's provides) is not software's: it is
// handed the loader. the two names are the placeholders for whoever places a program or a loader
// to write its facts under
import { createAction, createEffect, executeAction, PENDING, read, start } from "@ermine/system"
import type { Node } from "@ermine/system"

// on a program's node, written by whoever placed it: what it needs to run
export const NEEDS = "love.ermine.software.needs"
// on a loader's node, written by whoever placed it: what it provides
export const PROVIDES = "love.ermine.software.provides"

type Path = string | readonly string[]
// a program: the node (a path or a handle) whose value is its code
export type Program = Path | Node
// the setup a loader made of the code: runs once, as the process
export type Setup = () => unknown
// what start gives back, or the path taken
export type Run = ReturnType<typeof start>

// a loader at `name`: a program's value, and its node, in; the setup out, run once as the process.
// the action reads the program and asks load for the setup: load throwing refuses (the caller gets
// the error, the call's record says failed, nothing is started); the read is one of the call's
// reads. code not there yet is pending and not special. the system leaves a setup that threw PENDING
// as it is (setup runs once), so the started function waits itself: an effect reads the program
// (pending till it is placed) and its act asks load and runs the setup, once. an act makes no memos,
// effects or actions, so a program that waited for its code can write and read but not make
// computes, its return is not the process's value, and a load that throws fails that effect
export function createLoader(
	name: Path,
	load: (value: unknown, program: Node) => Setup,
): Node {
	return createAction(name, (program: Program, at: Path): Run => {
		let setup: Setup
		try {
			setup = load(read(program), program as Node)
		} catch (e) {
			if (e !== PENDING) throw e
			return start(() => {
				let ran = false
				createEffect("code", () => read(program), (value) => {
					if (ran) return
					ran = true
					load(value, program as Node)()
				})
			}, at)
		}
		return start(setup, at)
	})
}

// the loader at `loader` run on `program` at `at`: its action called
export function run(loader: Path | Node, program: Program, at: Path): Run {
	return executeAction(loader, program, at) as Run
}
