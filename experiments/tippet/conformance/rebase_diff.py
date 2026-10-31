#!/usr/bin/env python3
# Rebase, differentially: the same seeded writes and passes sent to several tippet harnesses (each a
# command speaking the line protocol, typescript/tippet_harness.ts), each made with its own
# rebase; every value and versions answer, after every step, must be the same in all of them.
#   python3 experiments/tippet/conformance/rebase_diff.py SEEDS 'ts:0=deno run -A --quiet experiments/tippet/typescript/tippet_harness.ts' 'c:2=experiments/tippet/c/tippet-harness' …
# each harness 'name:rebase=command'; run from the repository's root. a few dozen seeds.
import json, subprocess, sys


def rng(seed):
    x = (seed * 2654435761) & 0xFFFFFFFF or 1

    def r(n):
        nonlocal x
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        return x % n

    return r


class Harness:
    def __init__(self, spec):
        head, self.cmd = spec.split("=", 1)
        self.name, rebase = head.split(":")
        self.rebase = int(rebase)
        self.p = subprocess.Popen(self.cmd, shell=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    def ask(self, r):
        if r["op"] == "device":
            r = {**r, "rebase": self.rebase}
        self.p.stdin.write(json.dumps(r) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise SystemExit(f"{self.name}: no answer to {r}")
        return json.loads(line)

    def close(self):
        self.p.stdin.close()
        self.p.wait()


def run(seed, specs):
    hs = [Harness(s) for s in specs]
    r = rng(seed)
    names = ["a", "b", "c", "d"]
    lengths = {n: 0 for n in names}

    def all_(req, compare=True):
        answers = [h.ask(dict(req)) for h in hs]
        if compare and any(a != answers[0] for a in answers[1:]):
            got = "\n".join(f"  {h.name}: {json.dumps(a)[:300]}" for h, a in zip(hs, answers))
            raise SystemExit(f"seed {seed}: {json.dumps(req)[:200]}\n{got}")
        return answers[0]

    for i, n in enumerate(names):
        all_({"op": "device", "name": n, "seed": f"{i + 1:02x}" * 32})
    for n in names[:3]:
        all_({"op": "write", "device": n, "node": "doc", "patches": [{"path": [], "value": {"t": ""}}]})
        all_({"op": "write", "device": n, "node": "map", "patches": [{"path": [], "value": {}}]})
        all_({"op": "write", "device": n, "node": "list", "patches": [{"path": [], "value": {"arr": [{"t": ""}]}}]})
    for step in range(70):
        pick = r(12)
        if pick == 11:
            # a text in an array, or an element into the array (positions under it name others then)
            w = names[r(3)]
            v = all_({"op": "value", "device": w, "node": "list"}).get("value") or {}
            arr = v.get("arr") if isinstance(v, dict) else None
            if not isinstance(arr, list):
                continue
            if r(2) and arr and isinstance(arr[0], dict):
                i = r(len(arr))
                t = arr[i].get("t", "") if isinstance(arr[i], dict) else None
                if not isinstance(t, str):
                    continue
                at = r(len(t) + 1)
                all_({"op": "write", "device": w, "node": "list", "patches": [{"path": ["arr", i, "t"], "range": [at, at], "value": "mn"[r(2)]}]}, compare=False)
            else:
                at = r(len(arr) + 1)
                all_({"op": "write", "device": w, "node": "list", "patches": [{"path": ["arr"], "range": [at, at], "value": [{"t": "q"}]}]}, compare=False)
        elif pick < 7:
            # a write on one of the three writers' own view (its value, asked)
            w = names[r(3)]
            v = all_({"op": "value", "device": w, "node": "doc"}).get("value") or {"t": ""}
            t = v.get("t", "") if isinstance(v, dict) else ""
            if pick < 4 and isinstance(t, str):
                frm = r(len(t) + 1)
                to = frm + r(min(3, len(t) - frm) + 1)
                p = {"path": ["t"], "range": [frm, to], "value": "abcxyz"[r(6)] * r(3)}
                ans = all_({"op": "write", "device": w, "node": "doc", "patches": [p]}, compare=False)
            elif pick < 6:
                ans = all_({"op": "write", "device": w, "node": "map", "patches": [{"path": [f"k{r(4)}"], "value": r(100)}]}, compare=False)
            else:
                ans = all_({"op": "write", "device": w, "node": "map", "patches": [{"path": [], "value": {"k0": r(100)}}]}, compare=False)
        else:
            # one of a device's runs passed to another: the next it lacks
            src, dst, of = names[r(4)], names[r(4)], names[r(3)]
            if src == dst or of == dst:
                continue
            have = all_({"op": "count", "device": dst, "of": of})["count"]
            held = all_({"op": "count", "device": src, "of": of})["count"]
            if held > have:
                all_({"op": "pass", "from": src, "to": dst, "of": of, "at": have + 1})
        for n in names:
            for node in ("doc", "map", "list"):
                all_({"op": "value", "device": n, "node": node})
                all_({"op": "versions", "device": n, "node": node})
    for h in hs:
        h.close()


if __name__ == "__main__":
    seeds, specs = int(sys.argv[1]), sys.argv[2:]
    for seed in range(1, seeds + 1):
        run(seed, specs)
    print(f"{seeds} seeds: {', '.join(s.split('=')[0] for s in specs)} agree")
