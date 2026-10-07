// Throughput and latency of Subduction ephemeral messages, against a direct
// WebSocket and a direct TCP connection (results: plans/throughput.org).
//
//   deno run -A deno/bench_ephemeral.ts <test> [options]
//
// tests:
//   ping                 round trips: --n samples (50)
//   flow                 paced one-way streams: for each of --sizes (bytes),
//                        --rates (messages/s) in turn for --secs (5), each
//                        size's ramp stopping at the first loss or stall
//   burst                --count messages of --size bytes, --gap ms apart
//                        (0: all in one go); every arrival's time
//   word                 two peers derive the topic from --word and talk
// options:
//   --via sub|ws|tcp     Subduction through --url (and --service), or a
//                        direct WebSocket or TCP connection on 127.0.0.1
//   --procs 1|2          both peers in this process, or the receiver in a
//                        second process this one starts
//   --budget MB          payload bytes this run may publish (6)
//   --late s             how long to wait for messages still missing (35)
//   --json               print each result as one JSON line too
//   --poke ms            (burst) that long after the burst, the receiver
//                        sends the sender one small message
//   --nudge ms           (burst) that long after the burst, the sender sends
//                        one more small message
//   --detail             (burst) every arrival, and the receiver's frames
//
// A message is a 16-byte header, kind (u8), run (u8), 2 spare, seq (u32),
// the send time (f64, ms since the epoch, from performance), then filler.
// Both peers are on this machine, so one-way times use one clock.

// deno-lint-ignore-file no-explicit-any

const DATA = 1, PING = 2, PONG = 3, POKE = 4;
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- options

const argv = [...Deno.args];
const test = argv.shift() ?? "ping";
const opt: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1";
    opt[k] = v;
  }
}
const via = opt.via ?? "sub";
const url = opt.url ?? "wss://galaxy.observer";
const service = opt.service;
const procs = Number(opt.procs ?? 1);
const budget = Number(opt.budget ?? 6) * 1e6;
const late = Number(opt.late ?? 35) * 1000;
const json = "json" in opt;
let published = 0; // payload bytes this process sent

// --- every WebSocket is tapped: its frames' arrival times, its buffered bytes

type Tap = WebSocket & { frames: [number, number][] };
const sockets: Tap[] = [];
const Base = globalThis.WebSocket;
class Tapped extends Base {
  frames: [number, number][] = [];
  constructor(u: string | URL, p?: string | string[]) {
    super(u, p);
    sockets.push(this as unknown as Tap);
    this.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as ArrayBuffer | string;
      this.frames.push([now(), typeof d === "string" ? d.length : d.byteLength]);
    });
  }
}
(globalThis as any).WebSocket = Tapped;

// --- endpoints: send bytes to the other peer, receive theirs

type Endpoint = {
  send(b: Uint8Array): void | Promise<void>;
  receive(h: (b: Uint8Array) => void): void;
  buffered(): number;
  frames(): [number, number][];
  close(): Promise<void>;
  topic?: string;
};

async function sha256(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));

async function subduction(topic: Uint8Array): Promise<Endpoint> {
  // deno-lint-ignore no-import-prefix
  const S: any = await import("npm:@automerge/subduction@0.23.0");
  const signer = S.MemorySigner.generate();
  let handler = (_: Uint8Array) => {};
  const node = new S.Subduction({
    signer,
    storage: new S.MemoryStorage(),
    onEphemeral: (t: { toBytes(): Uint8Array }, _sender: unknown, payload: Uint8Array) => {
      const b = t.toBytes();
      if (b.length === 32 && b.every((x, i) => x === topic[i])) handler(payload);
    },
  });
  const before = sockets.length;
  await node.connectDiscover(new URL(url), service);
  const mine = sockets.slice(before);
  await node.subscribeEphemeral([S.Topic.fromBytes(topic)]);
  return {
    topic: hex(topic),
    send: (p) => node.publishEphemeral(S.Topic.fromBytes(topic), p),
    receive: (h) => (handler = h),
    buffered: () => mine.reduce((a, w) => a + w.bufferedAmount, 0),
    frames: () => mine.flatMap((w) => w.frames),
    close: async () => {
      try {
        await node.disconnectAll();
      } catch { /* gone */ }
    },
  };
}

function wsEndpoint(ws: WebSocket): Endpoint {
  ws.binaryType = "arraybuffer";
  let handler = (_: Uint8Array) => {};
  ws.addEventListener("message", (e) => handler(new Uint8Array(e.data as ArrayBuffer)));
  return {
    send: (b) => ws.send(b),
    receive: (h) => (handler = h),
    buffered: () => ws.bufferedAmount,
    frames: () => (ws as Tap).frames ?? [],
    close: () => Promise.resolve(ws.close()),
  };
}

// the server side of a direct WebSocket: ready once the other peer connects
function wsServe(port: number): Promise<{ ep: Promise<Endpoint>; close(): Promise<void> }> {
  let got!: (e: Endpoint) => void;
  const ep = new Promise<Endpoint>((r) => (got = r));
  const server = Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const frames: [number, number][] = [];
    socket.addEventListener("message", (e) => frames.push([now(), (e.data as ArrayBuffer).byteLength]));
    socket.addEventListener("open", () => {
      const e = wsEndpoint(socket);
      got({ ...e, frames: () => frames });
    });
    return response;
  });
  return Promise.resolve({ ep, close: () => server.shutdown() });
}

async function wsConnect(port: number): Promise<Endpoint> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  return wsEndpoint(ws);
}

function tcpEndpoint(conn: Deno.Conn): Endpoint {
  let handler = (_: Uint8Array) => {};
  let queue = Promise.resolve();
  let buffered = 0;
  const frames: [number, number][] = [];
  (async () => {
    let buf = new Uint8Array(0);
    const chunk = new Uint8Array(1 << 16);
    while (true) {
      let n: number | null;
      try {
        n = await conn.read(chunk);
      } catch {
        return;
      }
      if (n === null) return;
      const next = new Uint8Array(buf.length + n);
      next.set(buf);
      next.set(chunk.subarray(0, n), buf.length);
      buf = next;
      while (buf.length >= 4) {
        const len = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
        if (buf.length < 4 + len) break;
        const msg = buf.slice(4, 4 + len);
        buf = buf.slice(4 + len);
        frames.push([now(), len]);
        handler(msg);
      }
    }
  })();
  return {
    send: (b) => {
      const f = new Uint8Array(4 + b.length);
      new DataView(f.buffer).setUint32(0, b.length);
      f.set(b, 4);
      buffered += f.length;
      queue = queue.then(async () => {
        let off = 0;
        while (off < f.length) off += await conn.write(f.subarray(off));
        buffered -= f.length;
      });
    },
    receive: (h) => (handler = h),
    buffered: () => buffered,
    frames: () => frames,
    close: () => {
      try {
        conn.close();
      } catch { /* gone */ }
      return Promise.resolve();
    },
  };
}

// --- the receiving peer: echoes pings, keeps each run's arrivals

type Arrival = { seq: number; sent: number; got: number; size: number };
function receiver(ep: Endpoint) {
  const runs = new Map<number, Arrival[]>();
  ep.receive((b) => {
    const got = now();
    if (b.length < 16) return;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const kind = dv.getUint8(0), run = dv.getUint8(1), seq = dv.getUint32(4);
    if (kind === PING) {
      const r = b.slice(0, 16);
      r[0] = PONG;
      Promise.resolve(ep.send(r)).catch(() => {});
      return;
    }
    if (kind !== DATA) return;
    if (!runs.has(run)) runs.set(run, []);
    runs.get(run)!.push({ seq, sent: dv.getFloat64(8), got, size: b.length });
  });
  return (cmd: any): any => {
    const a = runs.get(cmd.run) ?? [];
    if (cmd.op === "progress") return { n: a.length, last: a.length ? a[a.length - 1].got : 0 };
    if (cmd.op === "report") {
      const out: any = { arrivals: a };
      if (cmd.since) out.frames = ep.frames().filter(([t]) => t >= cmd.since);
      return out;
    }
    if (cmd.op === "topic") return { topic: ep.topic };
    if (cmd.op === "poke") {
      // a small message the other way, so the sender's socket has something to read
      Promise.resolve(ep.send(message(POKE, 0, 0, 16))).catch(() => {});
      return { poked: now() };
    }
    return { error: "unknown " + cmd.op };
  };
}

// --- the peer as a second process: one JSON command a line in, one answer out

type Ctl = { cmd(c: any): Promise<any>; close(): Promise<void> };

async function peerProcess() {
  const ep = await peerEndpoint();
  const handle = receiver(ep);
  console.log(JSON.stringify({ ready: true, topic: ep.topic }));
  const lines = Deno.stdin.readable.pipeThrough(new TextDecoderStream());
  let rest = "";
  for await (const chunk of lines) {
    rest += chunk;
    let i;
    while ((i = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, i);
      rest = rest.slice(i + 1);
      const c = JSON.parse(line);
      if (c.op === "quit") {
        await ep.close();
        Deno.exit(0);
      }
      console.log(JSON.stringify(handle(c)));
    }
  }
  Deno.exit(0);
}

// the receiving peer's endpoint, in whichever process it runs
let tcpListener: Deno.Listener | undefined;
let wsServer: { ep: Promise<Endpoint>; close(): Promise<void> } | undefined;
async function peerEndpoint(): Promise<Endpoint> {
  if (via === "sub") {
    const t = opt.word ? await sha256("ermine channel:" + opt.word) : unhex(opt.topic);
    return await subduction(t);
  }
  const port = Number(opt.port);
  if (via === "ws") {
    wsServer = await wsServe(port);
    if (procs === 2) console.log(JSON.stringify({ listening: true }));
    return await wsServer.ep;
  }
  tcpListener = Deno.listen({ port, hostname: "127.0.0.1" });
  if (procs === 2) console.log(JSON.stringify({ listening: true }));
  const conn = (await tcpListener.accept()) as Deno.TcpConn;
  conn.setNoDelay(true);
  return tcpEndpoint(conn);
}

async function senderEndpoint(topic: Uint8Array, port: number): Promise<Endpoint> {
  if (via === "sub") return await subduction(topic);
  if (via === "ws") return await wsConnect(port);
  const conn = await Deno.connect({ port, hostname: "127.0.0.1", transport: "tcp" });
  conn.setNoDelay(true);
  return tcpEndpoint(conn);
}

// starts the peer, in this process or another, and this side's endpoint
async function pair(): Promise<{ ep: Endpoint; peer: Ctl; topics: string[] }> {
  const topic = opt.word
    ? await sha256("ermine channel:" + opt.word)
    : crypto.getRandomValues(new Uint8Array(32));
  const port = 20000 + Math.floor(Math.random() * 20000);
  opt.topic = hex(topic);
  opt.port = String(port);
  if (procs === 1) {
    // for ws/tcp the peer listens before its first await, then this side connects
    const peerEp = peerEndpoint();
    const ep = await senderEndpoint(topic, port);
    const pe = await peerEp;
    const handle = receiver(pe);
    return {
      ep,
      topics: [hex(topic), pe.topic ?? ""],
      peer: {
        cmd: (c) => Promise.resolve(handle(c)),
        close: async () => {
          await pe.close();
          tcpListener?.close();
          await wsServer?.close();
        },
      },
    };
  }
  const args = [
    "run",
    "-A",
    import.meta.filename!,
    "peer",
    "--via",
    via,
    "--procs",
    "2",
    "--url",
    url,
    "--port",
    String(port),
  ];
  if (service) args.push("--service", service);
  if (opt.word) args.push("--word", opt.word);
  else args.push("--topic", hex(topic));
  const child = new Deno.Command(Deno.execPath(), {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const writer = child.stdin.getWriter();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let rest = "";
  const line = async (): Promise<any> => {
    while (true) {
      const i = rest.indexOf("\n");
      if (i >= 0) {
        const l = rest.slice(0, i);
        rest = rest.slice(i + 1);
        return JSON.parse(l);
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("peer process ended");
      rest += value;
    }
  };
  let chain = Promise.resolve<any>(null);
  const cmd = (c: any) =>
    (chain = chain.then(async () => {
      await writer.write(new TextEncoder().encode(JSON.stringify(c) + "\n"));
      return await line();
    }));
  let peerTopic = "";
  if (via === "sub") {
    peerTopic = (await line()).topic;
    const ep = await senderEndpoint(topic, port);
    return { ep, topics: [hex(topic), peerTopic], peer: { cmd, close: quit } };
  }
  await line(); // listening
  const ep = await senderEndpoint(topic, port);
  await line(); // ready
  return { ep, topics: [hex(topic)], peer: { cmd, close: quit } };
  async function quit() {
    try {
      await writer.write(new TextEncoder().encode(JSON.stringify({ op: "quit" }) + "\n"));
    } catch { /* gone */ }
    await child.status;
  }
}

// --- the sending side

function message(kind: number, run: number, seq: number, size: number) {
  const b = new Uint8Array(Math.max(16, size));
  if (size > 16) crypto.getRandomValues(b.subarray(16, Math.min(size, 16 + 65536)));
  const dv = new DataView(b.buffer);
  dv.setUint8(0, kind);
  dv.setUint8(1, run);
  dv.setUint32(4, seq);
  dv.setFloat64(8, now());
  return b;
}

let errors = 0;
function send(ep: Endpoint, b: Uint8Array) {
  if (via === "sub" && !/127\.0\.0\.1|localhost/.test(url) && published + b.length > budget) throw new Error("budget spent");
  published += b.length;
  try {
    const p = ep.send(b);
    if (p) p.catch(() => errors++);
  } catch {
    errors++;
  }
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const r1 = (x: number) => Math.round(x * 10) / 10;

async function pings(ep: Endpoint, n: number) {
  const waiting = new Map<number, (t: number) => void>();
  ep.receive((b) => {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (dv.getUint8(0) === PONG) waiting.get(dv.getUint32(4))?.(now());
  });
  const rtts: number[] = [];
  let lost = 0;
  for (let i = 0; i < n && lost < 3; i++) {
    const got = new Promise<number>((r) => waiting.set(i, r));
    const t = now();
    send(ep, message(PING, 0, i, 16));
    const at = await Promise.race([got, sleep(5000).then(() => -1)]);
    waiting.delete(i);
    if (at < 0) lost++;
    else rtts.push(at - t);
    await sleep(30);
  }
  return {
    n: rtts.length,
    lost,
    min: r1(Math.min(...rtts)),
    p50: r1(q(rtts, 0.5)),
    p95: r1(q(rtts, 0.95)),
    max: r1(Math.max(...rtts)),
  };
}

let runId = 0;
// waits for the run's messages: until all arrive, or none for 3 s and then
// up to `late` more for stragglers
async function drain(peer: Ctl, run: number, sent: number) {
  const t0 = now();
  let last = -1, still = now(), lateWait = false;
  while (true) {
    const p = await peer.cmd({ op: "progress", run });
    if (p.n >= sent) return;
    if (p.n !== last) {
      last = p.n;
      still = now();
    }
    if (!lateWait && now() - still > 3000) {
      if (late <= 0) return;
      lateWait = true;
      console.error(`  ${sent - p.n} missing; waiting up to ${late / 1000} s for stragglers`);
    }
    if (lateWait && now() - t0 > late + 3000) return;
    await sleep(100);
  }
}

function summarize(arr: Arrival[], sent: number, t0: number, bytes: number) {
  let ooo = 0, max = -1;
  const seen = new Set<number>();
  let dup = 0;
  for (const a of arr) {
    if (seen.has(a.seq)) dup++;
    seen.add(a.seq);
    if (a.seq < max) ooo++;
    else max = a.seq;
  }
  const lats = arr.map((a) => a.got - a.sent);
  const first = Math.min(...arr.map((a) => a.got)), last = Math.max(...arr.map((a) => a.got));
  const span = (last - t0) / 1000;
  const got = seen.size;
  return {
    sent,
    got,
    lost: sent - got,
    ooo,
    dup,
    lat: {
      min: r1(Math.min(...lats)),
      p50: r1(q(lats, 0.5)),
      p95: r1(q(lats, 0.95)),
      max: r1(Math.max(...lats)),
    },
    // delivered rate over [first send, last arrival]
    msgs_s: r1(got / span),
    kB_s: r1((got * bytes) / 1000 / span),
    first_ms: r1(first - t0),
    last_ms: r1(last - t0),
  };
}

async function flow(ep: Endpoint, peer: Ctl, size: number, rate: number, secs: number) {
  const run = ++runId;
  const total = Math.max(1, Math.round(rate * secs));
  const t0 = performance.now(), abs0 = now();
  let sent = 0, checked = performance.now(), stalled = "";
  let maxBuf = 0;
  const bufTimer = setInterval(() => (maxBuf = Math.max(maxBuf, ep.buffered())), 20);
  while (sent < total) {
    const wait = t0 + (sent * 1000) / rate - performance.now();
    if (wait > 0) await sleep(wait);
    while (sent < total && t0 + (sent * 1000) / rate <= performance.now() + 0.5) {
      send(ep, message(DATA, run, sent, size));
      sent++;
    }
    if (performance.now() - checked > 500) {
      checked = performance.now();
      const p = await peer.cmd({ op: "progress", run });
      const behind = now() - (p.last || abs0);
      if (performance.now() - t0 > 1500 && behind > 2000) {
        stalled = `nothing arrived for ${Math.round(behind)} ms after ${p.n} of ${sent}`;
        break;
      }
    }
  }
  const sendSecs = (performance.now() - t0) / 1000;
  await drain(peer, run, sent);
  clearInterval(bufTimer);
  const rep = await peer.cmd({ op: "report", run });
  return {
    size,
    rate,
    secs: r1(sendSecs),
    ...summarize(rep.arrivals, sent, abs0, size),
    maxBuf,
    stalled,
  };
}

async function burst(ep: Endpoint, peer: Ctl, count: number, size: number, gap: number) {
  const run = ++runId;
  const abs0 = now();
  const buf: [number, number][] = [];
  const bufTimer = setInterval(() => buf.push([r1(now() - abs0), ep.buffered()]), 50);
  for (let i = 0; i < count; i++) {
    send(ep, message(DATA, run, i, size));
    if (gap > 0) await sleep(gap);
  }
  const sendMs = now() - abs0;
  let poked: number | undefined;
  const poke = Number(opt.poke ?? 0);
  const pokeTimer = poke > 0
    ? setTimeout(() => peer.cmd({ op: "poke" }).then((r) => (poked = r1(r.poked - abs0))), poke)
    : undefined;
  let nudged: number | undefined;
  const nudge = Number(opt.nudge ?? 0);
  const nudgeTimer = nudge > 0
    ? setTimeout(() => {
      nudged = r1(now() - abs0);
      send(ep, message(POKE, 0, 0, 16));
    }, nudge)
    : undefined;
  await drain(peer, run, count);
  clearTimeout(pokeTimer);
  clearTimeout(nudgeTimer);
  const mine = ep.frames().filter(([t]) => t >= abs0).map(([t, n]) => [r1(t - abs0), n]);
  clearInterval(bufTimer);
  const rep = await peer.cmd({ op: "report", run, since: abs0 });
  const s = summarize(rep.arrivals, count, abs0, size);
  // arrivals in send order: ms after the burst began
  const arr = (rep.arrivals as Arrival[]).map((a) => [a.seq, r1(a.got - abs0)]);
  const frames = (rep.frames ?? []).map(([t, n]: [number, number]) => [r1(t - abs0), n]);
  const drained = buf.find(([, b], i) => b === 0 && i > 0 && buf[i - 1][1] > 0)?.[0];
  return {
    count,
    size,
    gap,
    sendMs: r1(sendMs),
    ...s,
    maxBuf: Math.max(0, ...buf.map(([, b]) => b)),
    drainedAt: drained,
    poked,
    nudged,
    senderFrames: mine,
    arrivals: arr,
    frames,
  };
}

function show(name: string, r: any) {
  const { arrivals, frames, ...rest } = r;
  console.log(name, JSON.stringify(rest));
  if (arrivals && "detail" in opt) {
    console.log("  arrivals [seq, ms]:", JSON.stringify(arrivals));
    console.log("  receiver frames [ms, bytes]:", JSON.stringify(frames));
  }
  if (json) console.log(JSON.stringify({ test: name, ...r }));
}

async function main() {
  if (test === "peer") return await peerProcess();
  const t = now();
  const { ep, peer, topics } = await pair();
  console.error(`# ${test} via ${via}${via === "sub" ? " " + url : ""}, ${procs} process(es); connected in ${Math.round(now() - t)} ms`);
  try {
    // let the subscriptions settle before the first message
    await sleep(via === "sub" ? 500 : 50);
    if (test === "ping" || test === "word") {
      if (test === "word") {
        console.log(`word ${JSON.stringify(opt.word)}: sender topic ${topics[0]}`);
        console.log(`                 receiver topic ${topics[1]}`);
      }
      show("ping", await pings(ep, Number(opt.n ?? (test === "word" ? 5 : 50))));
    } else if (test === "flow") {
      const sizes = (opt.sizes ?? "100").split(",").map(Number);
      const rates = (opt.rates ?? "10").split(",").map(Number);
      const secs = Number(opt.secs ?? 5);
      for (const size of sizes) {
        for (const rate of rates) {
          const r = await flow(ep, peer, size, rate, secs);
          show("flow", r);
          await sleep(Number(opt.pause ?? 2000));
          if (r.lost > 0 || r.stalled || r.lat.max > 2000) {
            console.log(`  breaks at ${size} B × ${rate}/s`);
            break;
          }
        }
      }
    } else if (test === "burst") {
      const counts = (opt.count ?? "10").split(",").map(Number);
      for (const c of counts) {
        const r = await burst(ep, peer, c, Number(opt.size ?? 16000), Number(opt.gap ?? 0));
        show("burst", r);
        await sleep(Number(opt.pause ?? 2000));
        if ("stop" in opt && (r.lost > 0 || r.lat.max > 2000)) break;
      }
    }
  } finally {
    console.error(`# published ${published} payload bytes, ${errors} send errors`);
    await ep.close();
    await peer.close();
  }
  Deno.exit(0);
}

await main();
