# patchwork on dens

an example: patchwork's tool contract (`(handle, element) => cleanup`) running on an ermine den, as
the patchwork sketch (ermine-plans, `ermine/processes/patchwork-sketch-2026-10-18.md`) lays it out
in its "order, if built" steps 1 to 3, with the shape of step 4 (a frame view whose children are
views). it boots nothing of patchwork's own: the tools here are written to patchwork's contract from
scratch, and nothing is copied from patchwork-system or patchwork-pkg-base.

## what it shows

- **a runner for a second api of one form.** the page den (`boot.ts`) offers two runners that both
  take javascript source: `runners/javascript` (`api: ermine.api`, ermine/api's run) and
  `runners/patchwork-tool` (`api: patchwork.tool`, `runner.ts`). a program says which it is written
  against in `ermine.program.api`, and start's wrong-form check does the rest
- **descriptors as attributes, no discovery pass.** a tool module's `plugins` export is copied,
  without `load`, onto its program node's `patchwork.plugins` attribute once, when it is installed
  (`examples.ts`). after that, finding a tool reads attributes only
- **the fallback lookup as a library** (`lookup.ts`): patchwork's `getFallbackTool` (exact datatype,
  then `"*"`, then by id, unlisted passed over; a tool-id wins), outside the den. a node's
  `ermine.type` `patchwork.<id>` is datatype `<id>`
- **`<patchwork-view>` as start.** `startView` makes a box (a folder) holding `./doc`, `./surface`
  and the providers' names, picks the tool, and starts it at `<box>/view` with args
  `["/doc", toolId]`. the process's handle stop is the tool's cleanup
- **nested views as child processes.** a `<patchwork-view doc-url>` a tool puts in its element is
  connected (a custom element in a page, `definePatchworkView`; the fake DOM in the test): its
  parent offers that element as a surface (`<parent>/surfaces/view-<n>`), makes the child's box at
  `<parent>/views/<n>` from its own (the same `./selected`, `./storage`, `./modules`), and starts
  the child. disconnected, or the parent stopped: the child is stopped and the surface withdrawn
- **providers as the box.** a view's element answers patchwork's events from its box, so the nearest
  box answers, as the nearest provider did:
  - `patchwork:subscribe { type: "patchwork:selected-doc" }`: `./selected`'s value, and again at
    each write to it. `patchwork:open-document { url }` writes `./selected`
  - `patchwork:subscribe { type: "patchwork:tool-storage", toolId }`: the url of
    `./storage/<toolId>`, made at the first ask
- **the DocHandle shim** (`handle.ts`), over the process api: `doc()`, `change(fn)` (op's produce: a
  draft whose mutations are patches, written with `api.edit`), `on`/`off("change")` (told as each
  write lands, from anyone), `url` (`ermine:<id>`), `heads()`; `element.repo.find(url)`
- **three tools and a datatype** (`tools/`), plain javascript with no imports: `json` (any doc as
  JSON), `counter` (a datatype and its tool; clicks across every counter in its tool storage),
  `stack` (patchwork's folder shape, each doc in a nested view, its name a button that opens it, the
  selected one pressed)

```
/system/dens/tab                         the page den, at /system/den too
  runners/javascript                     { takes: javascript source, api: ermine.api }
  runners/patchwork-tool                 { takes: javascript source, api: patchwork.tool }
  surfaces/root                          { kind: dom }   the page's element
/apps/patchwork/modules/basics/          program nodes: { ermine.type, ermine.program.api, patchwork.plugins }
  json.js counter.js stack.js
/apps/patchwork/frame                    the frame's box
  doc → /docs/folder   surface → surfaces/root   modules  selected  storage
  view                                   process: stack on the folder (seen inside the box)
    surfaces/view-0, view-1              what it offers: the elements it made
    views/0                              a child's box: doc → the counter, surface → view-0, ...
      view                               process: counter
    views/1
      view                               process: json
```

## running it

```
deno test --allow-read playground/patchwork-dens
```

the test (`typescript/patchwork_test.ts`) runs the den over a fake DOM (`fake_dom.ts`)..

## shimmed, and real

real: the den, its runners and surface offers, start and stop, processes and their rows, boxes, the
process api the shim is written on, patches on nodes, the scheduler's pulses.

shimmed: automerge-repo's DocHandle and Repo (a node is no automerge doc), patchwork's providers
(answered by the view's element from its box, not by provider components), `<patchwork-view>` (a
thin custom element calling `connected` and `disconnected`).

## what it does not do

- no automerge: no mount of an automerge document (the dens doc's "mounting an automerge document";
  for a mounted doc the mount's real DocHandle could be handed over and the shim skipped)
- no service worker den: tool code is imported from a `data:` url of the program node's value, not
  served by id and hash
- no isolation iframe: tools run in the page realm, as patchwork's do without isolation
- no threepane, no account, no hash location, no drafts, no build step (the tools are bundleless)
- not every DocHandle: no `delete`, ephemeral messages, history, `heads()` is a content hash. change
  payload patches are ermine's (`{ path, value?, range? }`), not automerge's. no `repo.create`. urls
  are ids, so `find` is not held to the box
- pkg-base's tools do not run unchanged: they import solid-js, automerge and patchwork's packages
  through an import map this page does not have
- a `<patchwork-view>` whose attributes change is not restarted
