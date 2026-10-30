#!/usr/bin/env python3
# Tippet, cross-fuzzed: one seeded scenario sent to several harnesses (commands speaking the line
# protocol, typescript/tippet_harness.ts and c/tippet_harness.c); every answer must be the same in
# all of them, and each harness's end state is checked on its own. Oracles, each reported by name:
#   cross       an answer (value, versions, count, refusal, queue) differs between harnesses
#   converge    everyone holds every step, devices show different values for a node
#   lost        a typed character no removal or put covered is missing or there twice
#   misplaced   such a character is there once, in another array item's text
#   stuck       a peer refuses a run (passes from honest devices; a new peer, from one device)
#   interleave  two devices' concurrent runs at one place come out mixed (soft: counted by mode)
#   restart     a disk device's count after reset differs from before (or differs between harnesses)
#   crash       a harness died, hung, or the sanitizers spoke (run tippet-harness-check too)
#   cost        typing a character costs more as the text gets longer (--cost)
# a failure prints a shrunk reproduction: seed, oracle, the abstract ops, and the protocol lines
# sent (a conformance scenario's steps). a "+forget" oracle failed with a forgetting device in it.
#   python3 experiments/tippet/conformance/fuzz.py SEEDS [--kinds=free,list,race,link,disk,jump]
#     [--first=N] [--out=DIR] [--noshrink] [--cost] 'ts:0=deno run -A --quiet experiments/tippet/typescript/tippet_harness.ts'
#     'c:2=experiments/tippet/c/tippet-harness' 'k:256=experiments/tippet/c/tippet-harness-check' …
# each harness 'name:rebase=command'; run from the repository's root. a few dozen seeds a kind;
# jump (a paste past 2^20 characters) is slow, so it runs few. --out DIR: each repro's protocol
# lines as DIR/<kind>-<seed>-<oracle>.jsonl, whole.
import json, os, queue, random, re, subprocess, sys, tempfile, threading, time

SAN = re.compile(r"AddressSanitizer|UndefinedBehaviorSanitizer|LeakSanitizer|runtime error:")
# tagged characters: CJK and Hangul, BMP, so a character is one UTF-16 unit and one code point
POOL = [chr(c) for c in range(0x4E00, 0x9FA0)] + [chr(c) for c in range(0xAC00, 0xD7A4)]
NODES = ["doc", "map", "list"]
NAMES = ["a", "b", "c", "d", "e"]
READERS = [("r0", 0), ("r2", 2), ("r256", 256)]
HUGE = 1_050_000


class Crash(Exception):
    pass


class Harness:
    def __init__(self, spec):
        head, self.cmd = spec.split("=", 1)
        self.name, rebase = head.split(":")
        self.rebase = int(rebase)
        self.err = tempfile.TemporaryFile()
        self.p = subprocess.Popen(self.cmd, shell=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=self.err, text=True, bufsize=1)
        self.q = queue.Queue()
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        for line in self.p.stdout:
            self.q.put(line)
        self.q.put(None)

    def tail(self):
        self.err.seek(0)
        return self.err.read().decode("utf8", "replace")[-400:]

    def ask(self, r, timeout=240):
        if r["op"] == "device" and "rebase" not in r:
            r = {**r, "rebase": self.rebase}
        try:
            self.p.stdin.write(json.dumps(r) + "\n")
            self.p.stdin.flush()
        except (BrokenPipeError, ValueError):
            raise Crash(f"{self.name}: died on {json.dumps(r)[:120]}: {self.tail()}")
        try:
            line = self.q.get(timeout=timeout)
        except queue.Empty:
            self.p.kill()
            raise Crash(f"{self.name}: no answer in {timeout}s to {json.dumps(r)[:120]}")
        if line is None:
            raise Crash(f"{self.name}: died on {json.dumps(r)[:120]}: {self.tail()}")
        return json.loads(line)

    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.p.kill()
        text = self.tail()
        self.err.seek(0)
        whole = self.err.read().decode("utf8", "replace")
        return whole if SAN.search(whole) else None


def canon(a):
    return {"error": True} if isinstance(a, dict) and "error" in a else a


def short(x, n=300):
    s = json.dumps(x, ensure_ascii=False)
    return s if len(s) <= n else s[: n // 2] + f"…({len(s)} chars)…" + s[-n // 4 :]


# ---------------------------------------------------------------- scenarios

def gen(seed, kind):
    r = random.Random(seed * 7919 + len(kind))
    n = r.choice([3, 3, 4, 5])
    devs = [{"name": NAMES[i], "rebase": r.choice([None, None, 0, 2, 256]), "forgets": False} for i in range(n)]
    if kind != "jump" and r.random() < 0.3:
        devs[r.randrange(1, n)]["forgets"] = True
    names = [d["name"] for d in devs]
    ops = []

    def two():
        a = r.choice(names)
        return a, r.choice([x for x in names if x != a])

    def burst(d=None, **kw):
        o = {"o": "burst", "d": d or r.choice(names), "t": "doc" if r.random() < 0.7 else "item",
             "mode": r.choice(["fwd", "fwd", "back", "mid", "pre"]), "at": "end" if r.random() < 0.4 else round(r.random(), 3),
             "u2": round(r.random(), 3), "len": r.choice([1, 2, 3, 5, 8, 12, 20, 30])}
        o["mode"], mid = (("fwd", True) if o["mode"] == "mid" else (o["mode"], False))
        if mid:
            o["at"] = round(r.random(), 3)
        o.update(kw)
        return o

    def listop():
        k = r.choice(["insert", "insert", "removerange", "removeat", "move"])
        return {"o": "list", "d": r.choice(names), "k": k, "u": round(r.random(), 3), "u2": round(r.random(), 3), "n": r.choice([1, 2])}

    def mix():
        x = r.random()
        if x < 0.30:
            return burst()
        if x < 0.40:
            return {"o": "delete", "d": r.choice(names), "t": r.choice(["doc", "item"]), "u": round(r.random(), 3), "u2": round(r.random(), 3), "len": r.choice([1, 2, 5, 12])}
        if x < 0.44:
            return {"o": "paste", "d": r.choice(names), "t": r.choice(["doc", "doc", "item"]), "u": round(r.random(), 3), "u2": round(r.random(), 3), "len": r.choice([100, 400, 1000, 3000])}
        if x < 0.54:
            return listop()
        if x < 0.61:
            return {"o": "map", "d": r.choice(names), "k": r.randrange(4), "v": r.randrange(100), "whole": r.random() < 0.3}
        if x < 0.63:
            return {"o": "put", "d": r.choice(names), "node": r.choice(["doc", "list"]), "t": "reset"}
        if x < 0.82:
            a, b = two()
            return {"o": "pass", "a": a, "b": b, "of": r.choice(names), "u": round(r.random(), 3), "dup": r.random() < 0.2}
        return {"o": "batch", "a": two()[0], "b": two()[1]}

    scn = {"seed": seed, "kind": kind, "devs": devs, "init": "", "ops": ops, "link": kind == "link", "disk": kind == "disk"}
    if kind in ("free", "link", "disk"):
        ops += [mix() for _ in range(r.randrange(20, 45))]
        if kind == "link":
            for _ in range(r.randrange(8, 20)):
                a, b = two()
                ops.insert(r.randrange(len(ops) + 1), {"o": r.choice(["deliver", "deliver", "drop"]), "a": a, "b": b, "u": round(r.random(), 3), "all": r.random() < 0.4})
        if kind == "disk":
            for _ in range(r.randrange(8, 16)):
                ops.insert(r.randrange(len(ops) + 1), {"o": r.choice(["dtype", "dtype", "dtype", "ddel", "dsync", "drestart"]),
                                                     "mode": r.choice(["fwd", "back", "pre"]), "u": round(r.random(), 3), "len": r.choice([1, 3, 6, 12]), "sync": r.random() < 0.7})
            if r.random() < 0.5:
                ops.append({"o": "dtear", "file": r.choice(["log", "open"]), "bytes": r.choice([1, 3, 20, 60])})
            for _ in range(r.randrange(1, 4)):
                a, b = two()
                ops.insert(r.randrange(len(ops) + 1), {"o": "pass", "a": "k", "b": b, "of": "k", "u": 0.5, "dup": False})
    elif kind == "list":
        ops += [listop() if r.random() < 0.35 else burst(t="item") if r.random() < 0.7 else mix() for _ in range(r.randrange(25, 50))]
        ops = scn["ops"] = [o for o in ops]
        for i in range(len(ops)):
            if r.random() < 0.3:
                a, b = two()
                ops.insert(i, {"o": "pass", "a": a, "b": b, "of": r.choice(names), "u": round(r.random(), 3), "dup": False})
    elif kind == "race":
        scn["init"] = "the quick brown fox"
        for _ in range(r.randrange(1, 3)):
            m = r.choice(["fwd", "back", "pre"])
            at = r.choice(["end", round(r.random(), 3)])
            a, b = two()
            ln = r.choice([4, 6, 8])
            ops += [burst(a, t="doc", mode=m, at=at, len=ln), burst(b, t="doc", mode=m, at=at, len=ln)]
            if len(names) > 3 and r.random() < 0.5:
                ops.append(burst(r.choice([x for x in names if x not in (a, b)]), t="doc", mode=m, at=at, len=ln))
            ops.append({"o": "batch", "a": a, "b": b})
            for x in names:
                ops.append({"o": "batch", "a": a, "b": x})
            for x in names:
                ops.append({"o": "batch", "a": b, "b": x})
    elif kind == "jump":
        scn["devs"] = devs = [{"name": x, "rebase": None, "forgets": False} for x in ["a", "b", "c"]]
        ops += [{"o": "paste", "d": "a", "t": "doc", "u": 0.5, "u2": 0.0, "len": HUGE},
                {"o": "batch", "a": "a", "b": "b"}, burst("b", t="doc"), burst("b", t="doc"),
                {"o": "batch", "a": "b", "b": "c"}, burst("c", t="doc")]
        scn["rsrc"] = ["b", "b", "c"]
    names = [d["name"] for d in scn["devs"]]
    scn.setdefault("rsrc", [r.choice(names) for _ in READERS])
    scn["rord"] = [r.sample(names, len(names)) for _ in READERS]
    if kind == "jump":
        scn["rord"] = [["b", "a", "c"], ["b", "a", "c"], ["c", "a", "b"]]
    return scn


# ---------------------------------------------------------------- one run

class Sim:
    def __init__(self, scn, specs):
        self.scn, self.hs = scn, [Harness(s) for s in specs]
        self.steps, self.fails, self.notes = [], [], []
        self.origin, self.covered, self.puts = {}, set(), set()
        self.tags, self.bursts, self.counter, self.itemno = 0, [], 0, 1
        self.devs = [d["name"] for d in scn["devs"]]
        self.alld = self.devs + [n for n, _ in READERS] + (["k"] if scn["disk"] else [])
        self.nodes = NODES + (["dk"] if scn["disk"] else [])
        self.cross = None
        self.big = any(o.get("len", 0) > 20000 for o in scn["ops"])
        self.stuck, self.torn, self.ktext = set(), False, ""
        self.forget = any(d["forgets"] for d in scn["devs"])

    def fail(self, oracle, harness, msg, key=""):
        self.fails.append({"oracle": oracle + ("+forget" if self.forget and oracle in ("converge", "lost", "misplaced", "stuck") else ""),
                           "harness": harness, "msg": msg, "step": len(self.steps), "key": key})

    def ask(self, req, cmp=True, keep=None):
        ans = [h.ask(dict(req)) for h in self.hs]
        if keep if keep is not None else req["op"] in ("device", "disk", "write", "pass", "take", "link", "deliver", "drop", "reset", "tear", "sync"):
            self.steps.append(req)
        if cmp and self.cross is None:
            c = [canon(a) for a in ans]
            for i in range(1, len(c)):
                if c[i] != c[0]:
                    self.cross = (req, self.hs[0].name, ans[0], self.hs[i].name, ans[i])
                    self.fail("cross", f"{self.hs[0].name}/{self.hs[i].name}",
                              f"{short(req, 160)}\n      {self.hs[0].name}: {short(ans[0])}\n      {self.hs[i].name}: {short(ans[i])}")
                    break
        return ans

    def write(self, d, node, patches, cmp=True):
        return self.ask({"op": "write", "device": d, "node": node, "patches": patches}, cmp)

    def value(self, d, node):
        return self.ask({"op": "value", "device": d, "node": node})[0].get("value")

    def count(self, d, of):
        return self.ask({"op": "count", "device": d, "of": of})[0].get("count", 0)

    def tag(self, owner):
        if self.counter < len(POOL):
            ch = POOL[self.counter]
            self.counter += 1
            self.origin[ch] = (owner, len(self.steps))
            return ch
        return "x"

    def tagged(self, owner, n):
        return "".join(self.tag(owner) for _ in range(n))

    # -- looking: values and versions after an op, as rebase_diff does
    def look(self, devs, nodes, versions=True):
        for d in devs:
            if d == "k":
                continue
            for n in nodes:
                self.ask({"op": "value", "device": d, "node": n}, keep=False)
                if versions and not self.big:
                    self.ask({"op": "versions", "device": d, "node": n}, keep=False)

    # -- ops
    def target(self, o, d):
        """the text a burst, delete or paste edits: (path, owner, text) in d's view, or None"""
        if o["t"] == "doc":
            v = self.value(d, "doc")
            t = v.get("t") if isinstance(v, dict) else None
            return (["t"], "doc", t, "doc") if isinstance(t, str) else None
        v = self.value(d, "list")
        arr = v.get("arr") if isinstance(v, dict) else None
        if not isinstance(arr, list) or not arr:
            return None
        i = min(int(o["u2"] * len(arr)), len(arr) - 1)
        it = arr[i]
        if not isinstance(it, dict) or not isinstance(it.get("t"), str):
            return None
        return (["arr", i, "t"], ("list", it.get("id")), it["t"], "list")

    def run_op(self, o):
        k, scn = o["o"], self.scn
        if k in ("burst", "paste", "delete"):
            d = o["d"]
            tg = self.target(o, d)
            if not tg:
                return
            path, owner, txt, node = tg
            if owner == "doc":
                owner = ("doc", None)
            L = len(txt)
            if k == "burst":
                at = L if o["at"] == "end" else int(o["at"] * (L + 1))
                mode = o["mode"]
                mine = ""
                for i in range(o["len"]):
                    ch = self.tag(owner)
                    mine += ch
                    p = 0 if mode == "pre" else at if mode == "back" else at + i
                    self.write(d, node, [{"path": path, "range": [p, p], "value": ch}])
                self.bursts.append({"d": d, "mode": mode, "tags": mine, "step": len(self.steps), "node": node})
            elif k == "paste":
                at = int(o["u"] * (L + 1))
                s = ("x" * o["len"]) if o["len"] > 20000 else self.tagged(owner, o["len"])
                self.write(d, node, [{"path": path, "range": [at, at], "value": s}])
            else:
                f = int(o["u"] * (L + 1))
                t = min(L, f + o["len"])
                for ch in txt[f:t]:
                    self.covered.add(ch)
                self.write(d, node, [{"path": path, "range": [f, t], "value": ""}])
            self.look([d], [node])
        elif k == "list":
            d = o["d"]
            v = self.value(d, "list")
            arr = v.get("arr") if isinstance(v, dict) else None
            if not isinstance(arr, list):
                return
            n = len(arr)
            ids = lambda xs: [x.get("id") for x in xs if isinstance(x, dict)]
            if o["k"] == "insert" or n == 0:
                at = int(o["u"] * (n + 1))
                iid = f"i{self.itemno}"
                self.itemno += 1
                item = {"id": iid, "t": self.tagged(("list", iid), o["n"] - 1)}
                self.write(d, "list", [{"path": ["arr"], "range": [at, at], "value": [item]}])
            elif o["k"] == "removerange":
                i = min(int(o["u"] * n), n - 1)
                j = min(n, i + o["n"])
                self.covered_items(ids(arr[i:j]))
                self.write(d, "list", [{"path": ["arr"], "range": [i, j], "value": []}])
            elif o["k"] == "removeat":
                i = min(int(o["u"] * n), n - 1)
                self.covered_items(ids(arr[i:i + 1]))
                self.write(d, "list", [{"path": ["arr", i]}])
            else:
                i = min(int(o["u"] * n), n - 1)
                j = min(int(o["u2"] * n), n - 1)
                self.covered_items(ids(arr[i:i + 1]))
                self.write(d, "list", [{"path": ["arr"], "range": [j, j], "move": {"path": ["arr", i]}}])
            self.look([d], ["list"])
        elif k == "map":
            d = o["d"]
            p = {"path": [], "value": {"k0": o["v"]}} if o["whole"] else {"path": [f"k{o['k']}"], "value": o["v"]}
            self.write(d, "map", [p])
            self.look([d], ["map"])
        elif k == "put":
            d = o["d"]
            if o["node"] == "doc":
                self.puts.add("doc")
                self.write(d, "doc", [{"path": [], "value": {"t": "reset"}}])
            else:
                self.puts.add("list")
                iid = f"i{self.itemno}"
                self.itemno += 1
                self.write(d, "list", [{"path": [], "value": {"arr": [{"id": iid, "t": ""}]}}])
            self.look([d], [o["node"]])
        elif k == "pass":
            self.passrun(o["a"], o["b"], o["of"], o["u"] if o.get("dup") else None)
        elif k == "batch":
            a, b = o["a"], o["b"]
            if a == b:
                return
            for of in self.alld:
                self.pull(a, b, of)
            self.look([b], self.nodes)
        elif k in ("deliver", "drop"):
            a, b = o["a"], o["b"]
            if a == b or not self.scn["link"]:
                return
            q = self.ask({"op": "queued", "from": a, "to": b}, keep=False)[0].get("queued", [])
            if not q:
                return
            req = {"op": k, "from": a, "to": b}
            if not o.get("all"):
                req["count"] = 1 + int(o["u"] * len(q))
            self.ask(req)
            self.look([b], self.nodes)
        elif k in ("dtype", "ddel"):
            if self.torn:
                return
            L = len(self.ktext)
            if k == "dtype":
                at = L if o["mode"] == "fwd" else int(o["u"] * (L + 1)) if o["mode"] == "back" else 0
                for i in range(o["len"]):
                    ch = self.tag(("dk", None))
                    p = at + i if o["mode"] == "fwd" else at
                    self.write("k", "dk", [{"path": ["t"], "range": [p, p], "value": ch}])
                    self.ktext = self.ktext[:p] + ch + self.ktext[p:]
            else:
                f = int(o["u"] * (L + 1))
                t = min(L, f + o["len"])
                for ch in self.ktext[f:t]:
                    self.covered.add(ch)
                self.write("k", "dk", [{"path": ["t"], "range": [f, t], "value": ""}])
                self.ktext = self.ktext[:f] + self.ktext[t:]
        elif k == "dsync":
            self.ask({"op": "sync", "device": "k"})
        elif k == "drestart":
            if o.get("sync", True):
                self.ask({"op": "sync", "device": "k"})
            self.restart(unsynced=not o.get("sync", True))
            self.torn = self.torn or not o.get("sync", True)
        elif k == "dtear":
            self.ask({"op": "sync", "device": "k"})
            self.ask({"op": "tear", "device": "k", "file": o["file"], "bytes": o["bytes"]})
            self.torn = True
            self.restart(tear=True)

    def restart(self, tear=False, unsynced=False):
        before = self.count("k", "k")
        ans = self.ask({"op": "reset", "device": "k"})
        self.ask({"op": "files", "device": "k"}, keep=False)
        for h, a in zip(self.hs, ans):
            c = a.get("count")
            if c is None or (not tear and not unsynced and c != before) or c > before:
                self.fail("restart", h.name, f"count {before} before reset, {short(a)} after" + (" (a tear)" if tear else " (unsynced)" if unsynced else ""))

    def covered_items(self, ids):
        for i in ids:
            self.covered.add(("item", i))

    def passrun(self, a, b, of, dup=None):
        if a == b or b == of:
            return
        held, have = self.count(a, of), self.count(b, of)
        if dup is not None and have > 0:
            at = 1 + int(dup * have)
        elif held > have:
            at = have + 1
        else:
            return
        ans = self.ask({"op": "pass", "from": a, "to": b, "of": of, "at": at})
        for h, x in zip(self.hs, ans):
            if "refused" in x and dup is None:
                self.stuck.add(b)
                self.fail("stuck", h.name, f"{b} refuses {a}'s run of {of} from step {at}: {short(x)}", key=f"{b}<-{of}")
        self.look([b], self.nodes)

    def pull(self, a, b, of):
        for _ in range(100000):
            held, have = self.count(a, of), self.count(b, of)
            if held <= have or b == of:
                return True
            ans = self.ask({"op": "pass", "from": a, "to": b, "of": of, "at": have + 1})
            ref = [h.name for h, x in zip(self.hs, ans) if "refused" in x]
            if ref or any("error" in x for x in ans):
                for n in ref:
                    self.fail("stuck", n, f"{b} refuses {a}'s run of {of} from step {have + 1}: {short(ans[0])}", key=f"{b}<-{of}")
                self.stuck.add(b)
                return False
            if self.count(b, of) <= have:
                return False
        return False

    # -- the end
    def finish(self):
        scn = self.scn
        if scn["link"]:
            for _ in range(30):
                busy = False
                for a in self.devs:
                    for b in self.devs:
                        if a != b:
                            q = self.ask({"op": "queued", "from": a, "to": b}, keep=False)[0].get("queued", [])
                            if q:
                                busy = True
                                self.ask({"op": "deliver", "from": a, "to": b})
                if not busy:
                    break
        # writers hear each other, in a fixed order, until nobody lacks a step
        for _ in range(4):
            moved = False
            for a in self.devs + (["k"] if scn["disk"] else []):
                for b in self.devs:
                    for of in self.alld:
                        if a != b and b != of and self.count(a, of) > self.count(b, of):
                            moved = True
                            self.pull(a, b, of)
            if not moved:
                break
        # a new peer hears one device (what a link does: a refusal there ends that device's runs)
        for (rn, _), src, order in zip(READERS, scn["rsrc"], scn["rord"]):
            first = None
            for of in order:
                if self.count(src, of) > self.count(rn, of) and not self.pull(src, rn, of):
                    first = first or of
            if first:
                ok = all(self.pull(src, rn, of) for of in order)
                if ok:
                    why = next((f["msg"] for f in self.fails if f["oracle"].startswith("stuck") and f["key"].startswith(f"{rn}<-")), "")
                    self.stuck.discard(rn)
                    self.fails = [f for f in self.fails if not (f["oracle"].startswith("stuck") and f["key"].startswith(f"{rn}<-"))]
                    self.fail("stuck", "*", f"new peer {rn}, taking from {src} only, is refused {first}'s run at first (a link sends that device no more); it takes it after the others [{why[:200]}]", key=f"{rn}<-{first}")
        self.look(self.devs + [n for n, _ in READERS], self.nodes)
        self.checks()

    def checks(self):
        full = [d for d in self.devs + [n for n, _ in READERS] if d not in self.stuck]
        counts = {}
        for d in full:
            counts[d] = {of: self.count(d, of) for of in self.alld}
        complete = all(counts[d] == counts[full[0]] for d in full)
        vals = {}
        for n in self.nodes:
            for d in full:
                vals[(d, n)] = [h_a for h_a in self.ask({"op": "value", "device": d, "node": n}, keep=False)]
        for i, h in enumerate(self.hs):
            if complete:
                for n in self.nodes:
                    groups = {}
                    for d in full:
                        groups.setdefault(json.dumps(canon(vals[(d, n)][i]), sort_keys=True), []).append(d)
                    if len(groups) > 1:
                        parts = "; ".join(f"{'+'.join(g)}: {short(json.loads(k), 90)}" for k, g in groups.items())
                        self.fail("converge", h.name, f"node {n} differs after every step arrived: {parts}", key=n)
            if not complete:
                continue
            self.lost(i, h.name, full, vals)
        self.interleave(full, vals)

    def lost(self, i, hname, full, vals):
        for n, owners in (("doc", ("doc", None)), ("list", "item"), ("dk", ("dk", None))):
            if n not in self.nodes or n in self.puts:
                continue
            seen = {}
            for d in full:
                v = vals[(d, n)][i].get("value")
                seen[d] = v
            texts = {}
            for d, v in seen.items():
                bag = {}
                walk(v, bag, None)
                texts[d] = bag
            for ch, (owner, step) in self.origin.items():
                if (owner[0] == "doc") != (n == "doc") or (owner[0] == "dk") != (n == "dk") or (owner[0] == "list") != (n == "list"):
                    continue
                if ch in self.covered or (owner[0] == "list" and ("item", owner[1]) in self.covered):
                    continue
                bad, wrong = [], []
                for d, bag in texts.items():
                    at = bag.get(ch, [])
                    if len(at) != 1:
                        bad.append(f"{d}:{len(at)}x")
                    elif owner[0] == "list" and at[0] != owner[1]:
                        wrong.append(f"{d}:in {at[0]}")
                if bad:
                    self.fail("lost", hname, f"{ch!r} (U+{ord(ch):04X}) typed at step {step} into {owner}, not covered by any removal, shows {', '.join(bad)} in {n}", key=f"{n}")
                    return
                if wrong:
                    self.fail("misplaced", hname, f"{ch!r} (U+{ord(ch):04X}) typed at step {step} into item {owner[1]}, shows {', '.join(wrong)}", key=f"{n}")
                    return

    def interleave(self, full, vals):
        if self.scn["kind"] != "race" or "doc" in self.puts:
            return
        for i, h in enumerate(self.hs):
            v = vals[("a", "doc")][i].get("value") if ("a", "doc") in vals else None
            t = v.get("t") if isinstance(v, dict) else None
            if not isinstance(t, str):
                continue
            groups = {}
            for b in self.bursts:
                groups.setdefault((b["mode"], b["step"] // 1000), []).append(b)
            for b in self.bursts:
                at = [t.find(c) for c in b["tags"]]
                if any(x < 0 for x in at) or len(b["tags"]) < 3:
                    continue
                span = max(at) - min(at) + 1
                if i == 0:
                    self.notes.append(("interleave", h.name, b["mode"], span != len(b["tags"])))
                if span != len(b["tags"]):
                    self.fail("interleave", h.name, f"{b['d']}'s {b['mode']} run of {len(b['tags'])} comes out in {span} places: {t[max(0, min(at) - 2):max(at) + 3]!r}", key=b["mode"])

    def close(self):
        for h in self.hs:
            try:
                s = h.close()
            except Exception:
                s = None
            if s:
                self.fail("crash", h.name, "sanitizer: " + next((l for l in s.splitlines() if SAN.search(l)), s[:200]))

    def run(self):
        scn = self.scn
        try:
            for i, d in enumerate(scn["devs"]):
                req = {"op": "device", "name": d["name"], "seed": f"{i + 1:02x}" * 32}
                if d["rebase"] is not None:
                    req["rebase"] = d["rebase"]
                if d["forgets"]:
                    req["forgets"] = True
                self.ask(req)
            for i, (n, rb) in enumerate(READERS):
                self.ask({"op": "device", "name": n, "seed": f"{0x20 + i:02x}" * 32, "rebase": rb})
            if scn["disk"]:
                self.ask({"op": "disk", "name": "k", "seed": "30" * 32})
            if scn["link"]:
                for x in self.devs:
                    for y in self.devs:
                        if x < y:
                            self.ask({"op": "link", "a": x, "b": y})
            self.write("a", "doc", [{"path": [], "value": {"t": scn["init"]}}])
            self.write("a", "map", [{"path": [], "value": {}}])
            self.write("a", "list", [{"path": [], "value": {"arr": [{"id": "i0", "t": ""}]}}])
            if scn["disk"]:
                self.write("k", "dk", [{"path": [], "value": {"t": ""}}])
                for x in self.devs:
                    self.pull("k", x, "k")
            for x in self.devs[1:]:
                self.pull("a", x, "a")
            if scn["link"]:
                for _ in range(2):
                    for x in self.devs:
                        for y in self.devs:
                            if x != y:
                                self.ask({"op": "deliver", "from": x, "to": y})
            for step, o in enumerate(scn["ops"]):
                self.run_op(o)
                if step % 8 == 7 and not self.big:
                    self.look(self.devs, self.nodes)
            self.finish()
        except Crash as e:
            self.fail("crash", str(e).split(":")[0], str(e))
        finally:
            self.close()
        return self


def walk(v, bag, item):
    """every character of every string in v: where (the id of the array item it is in)"""
    if isinstance(v, str):
        for ch in v:
            bag.setdefault(ch, []).append(item)
    elif isinstance(v, list):
        for x in v:
            walk(x, bag, item)
    elif isinstance(v, dict):
        for k, x in v.items():
            if k == "id":
                continue
            walk(x, bag, v.get("id", item) if "id" in v else item)


# ---------------------------------------------------------------- shrinking

def pick(specs, f, fails):
    """the harnesses to shrink on: for cross, the two that differ; else the quickest that failed too"""
    if f["oracle"].startswith("cross"):
        names = f["harness"].split("/")
        return [s for s in specs if s.split(":")[0] in names]
    base = f["oracle"].split("+")[0]
    also = {g["harness"] for g in fails if g["oracle"].split("+")[0] == base}
    mine = [s for s in specs if s.split(":")[0] in also] or specs[:1]
    return sorted(mine, key=lambda s: "deno" in s)[:1]


def shrink(scn, specs, oracle, budget=60):
    base = oracle.split("+")[0]
    tries = [0]
    t0 = time.time()

    def bad(s):
        if tries[0] >= budget or time.time() - t0 > 100:
            return False
        tries[0] += 1
        sim = Sim(s, specs).run()
        return any(f["oracle"].split("+")[0] == base for f in sim.fails)

    cur = json.loads(json.dumps(scn))
    # a forgetting device out, rebases to the harness's
    for i in range(len(cur["devs"])):
        if cur["devs"][i]["forgets"]:
            t = json.loads(json.dumps(cur))
            t["devs"][i]["forgets"] = False
            if bad(t):
                cur = t
    ops, n = cur["ops"], 2
    while len(ops) >= 2 and n <= len(ops):
        size = max(1, len(ops) // n)
        done = False
        for i in range(0, len(ops), size):
            t = dict(cur, ops=ops[:i] + ops[i + size:])
            if bad(t):
                cur, ops, n, done = t, t["ops"], max(n - 1, 2), True
                break
        if not done:
            if size == 1:
                break
            n = min(len(ops), n * 2)
    for i in range(len(cur["ops"])):
        o = cur["ops"][i]
        while o.get("len", 0) > 1:
            t = json.loads(json.dumps(cur))
            t["ops"][i]["len"] = max(1, o["len"] // 2) if o["len"] > 3 else o["len"] - 1
            if not bad(t):
                break
            cur = t
            o = cur["ops"][i]
    return cur


def trim(x):
    if isinstance(x, str) and len(x) > 40:
        return x[:12] + f"…({len(x)} chars)"
    if isinstance(x, list):
        return [trim(y) for y in x]
    if isinstance(x, dict):
        return {k: trim(v) for k, v in x.items()}
    return x


def sig(s):
    """what a shrunk scenario is made of, not its numbers: two repros with one signature are one finding"""
    return tuple(sorted({o["o"] + ":" + str(o.get("k", o.get("mode", o.get("t", "")))) + ":" + str(o.get("t", "")) for o in s["ops"]})) + (any(d["forgets"] for d in s["devs"]),)


def report(scn, specs, f, out, fails, seen):
    use = pick(specs, f, fails)
    s = shrink(scn, use, f["oracle"]) if "--noshrink" not in sys.argv else scn
    if sig(s) in seen.setdefault(f["oracle"].split("+")[0], set()):
        return False
    seen[f["oracle"].split("+")[0]].add(sig(s))
    sim = Sim(s, use).run()
    fs = [g for g in sim.fails if g["oracle"].split("+")[0] == f["oracle"].split("+")[0]]
    g = fs[0] if fs else f
    print(f"\n[{g['oracle']}] seed {scn['seed']} kind {scn['kind']} on {g['harness']}: {g['msg']}")
    print(f"  ops ({len(s['ops'])}, devices {', '.join(d['name'] + ('/' + str(d['rebase']) if d['rebase'] is not None else '') + ('/forgets' if d['forgets'] else '') for d in s['devs'])}):")
    for o in s["ops"]:
        print("    " + json.dumps(o, ensure_ascii=False))
    print(f"  protocol lines ({len(sim.steps)}, failing near line {g['step']}):")
    for r in sim.steps[:60]:
        print("    " + json.dumps(trim(r), ensure_ascii=False))
    if len(sim.steps) > 60:
        print(f"    … {len(sim.steps) - 60} more")
    if out:
        os.makedirs(out, exist_ok=True)
        path = f"{out}/{scn['kind']}-{scn['seed']}-{g['oracle']}.jsonl"
        with open(path, "w") as fh:
            for r in sim.steps:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"  whole: {path}")
    return True


# ---------------------------------------------------------------- cost

def cost(specs):
    print("cost: ms to type one character at the end of a text pasted to length L (mean of 100)")
    for sp in specs:
        h = Harness(sp)
        try:
            row = []
            for i, L in enumerate((0, 20000, 100000, 400000)):
                h.ask({"op": "device", "name": f"x{i}", "seed": f"{0x40 + i:02x}" * 32})
                h.ask({"op": "write", "device": f"x{i}", "node": "doc", "patches": [{"path": [], "value": {"t": ""}}]})
                if L:
                    h.ask({"op": "write", "device": f"x{i}", "node": "doc", "patches": [{"path": ["t"], "range": [0, 0], "value": "".join(POOL[(j // 7) % len(POOL)] for j in range(L))}]})
                t0 = time.time()
                for j in range(100):
                    h.ask({"op": "write", "device": f"x{i}", "node": "doc", "patches": [{"path": ["t"], "range": [L + j, L + j], "value": "y"}]})
                row.append((L, (time.time() - t0) * 10))
            print(f"  {h.name} length: " + ", ".join(f"L={L}: {ms:.2f}" for L, ms in row) + f"  (x{row[-1][1] / row[0][1]:.1f})" + ("  [cost] grows with length" if row[-1][1] / row[0][1] > 2 or row[-1][1] - row[0][1] > 1 else ""))
        finally:
            h.close()
    print("cost: ms to type one character, in batches of 250, as one device types characters (first batch ... last batch)")
    for sp in specs:
        for mode in ("fwd", "pre", "mid", "rand"):
            h = Harness(sp)
            try:
                h.ask({"op": "device", "name": "x", "seed": "0a" * 32})
                h.ask({"op": "write", "device": "x", "node": "doc", "patches": [{"path": [], "value": {"t": "q" * 500}}]})
                batches = []
                for batch in range(int(os.environ.get('BATCHES', 8))):
                    t0 = time.time()
                    for i in range(250):
                        n = batch * 250 + i
                        at = {"fwd": 500 + n, "pre": 0, "mid": 250 + n, "rand": (n * 7919) % (500 + n)}[mode]
                        h.ask({"op": "write", "device": "x", "node": "doc", "patches": [{"path": ["t"], "range": [at, at], "value": "y"}]})
                    batches.append((time.time() - t0) * 1000 / 250)
                ratio = batches[-1] / batches[0]
                print(f"  {h.name} {mode}: " + ", ".join(f"{b:.2f}" for b in batches) + f"  (x{ratio:.1f})" + ("  [cost] grows with length" if ratio > 1.5 else ""))
            finally:
                h.close()


# ---------------------------------------------------------------- main

def main():
    args = sys.argv[1:]
    opt = {a.split("=")[0]: (a.split("=", 1)[1] if "=" in a else True) for a in args if a.startswith("--")}
    pos = [a for a in args if not a.startswith("--")]
    seeds, specs = int(pos[0]), pos[1:]
    if "--cost" in opt:
        return cost(specs)
    kinds = opt.get("--kinds", "free,list,race,link,disk,jump").split(",")
    first, out = int(opt.get("--first", 1)), opt.get("--out")
    found, mixed, shown, seen, t0 = {}, {}, {}, {}, time.time()
    for kind in kinds:
        for seed in range(first, first + (min(seeds, 2) if kind == "jump" else seeds)):
            scn = gen(seed, kind)
            sim = Sim(scn, specs).run()
            for _, _, mode, was in sim.notes:
                m = mixed.setdefault(mode, [0, 0])
                m[0] += was
                m[1] += 1
            for f in sim.fails:
                base = f["oracle"].split("+")[0]
                found[(kind, f["oracle"], f["harness"])] = found.get((kind, f["oracle"], f["harness"]), 0) + 1
                tag = (kind, f["oracle"], f["key"] if base == "interleave" else "")
                if shown.get(tag, 0) < int(opt.get("--shrinks", 3)) and (base != "interleave" or tag not in shown):
                    shown[tag] = shown.get(tag, 0) + 1
                    report(scn, specs, f, out, sim.fails, seen)
    print(f"\nsummary ({time.time() - t0:.0f}s, {seeds} seeds a kind: {', '.join(kinds)}; harnesses {', '.join(s.split('=')[0] for s in specs)})")
    for (k, o, h), c in sorted(found.items()):
        print(f"  {o:14} {k:5} on {h}: {c} failing checks")
    for mode, v in sorted(mixed.items()):
        print(f"  interleave {mode:5}: {v[0]} of {v[1]} concurrent runs mixed")
    if not found:
        print("  every oracle held")


if __name__ == "__main__":
    main()
