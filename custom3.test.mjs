// The fork's third round: what Kiro metered (meteringEvent) read into the
// usage — the tokens its cache read, and a native thinker's unshown
// reasoning as output — and a refusal (Kiro's safety filter) answered as one.
// No network; the prices are set here, not the calibrated table's.
import { test, expect, afterEach } from "bun:test"
import { _internal } from "./index.mjs"

const { meter, PRICES, events, reply, configure, learned, turns, charsOf } = _internal

const saved = { ...PRICES }
afterEach(() => {
  for (const k of Object.keys(PRICES)) delete PRICES[k]
  Object.assign(PRICES, saved)
  learned.clear()
  turns.clear()
  configure({})
})

// prices in credits a million tokens: Sonnet 4.5's, as calibrated
const P = { fresh: 4.1, cached: 2.16, output: 128, chars: 4.4 }

test("a prompt read whole from the cache is told as cached", () => {
  PRICES["m"] = P
  // 10000-token prompt, all cached, 10-token reply
  const credits = (2.16 * 10000 + 128 * 10) / 1e6
  const u = { input: 10000, output: 10, cacheRead: 0, cacheWrite: 0 }
  expect(meter(u, "m", credits)).toBe(true)
  expect(u.cacheRead).toBe(10000)
  expect(u.input).toBe(0)
  expect(u.output).toBe(10)
})

test("a cold prompt is all fresh; part of it cached is told so", () => {
  PRICES["m"] = P
  const cold = { input: 10000, output: 10, cacheRead: 0, cacheWrite: 0 }
  meter(cold, "m", (4.1 * 10000 + 128 * 10) / 1e6)
  expect(cold.cacheRead).toBe(0)
  expect(cold.input).toBe(10000)
  const part = { input: 10000, output: 10, cacheRead: 0, cacheWrite: 0 }
  meter(part, "m", (4.1 * 6000 + 2.16 * 4000 + 128 * 10) / 1e6)
  expect(part.cacheRead).toBe(4000)
  expect(part.input).toBe(6000)
})

test("credits past a cold prompt and the reply are the unshown reasoning, told as output", () => {
  PRICES["m"] = P
  const u = { input: 10000, output: 100, cacheRead: 0, cacheWrite: 0 }
  // 500 more output tokens than were shown
  meter(u, "m", (4.1 * 10000 + 128 * 600) / 1e6)
  expect(u.cacheRead).toBe(0)
  expect(u.output).toBe(600)
})

test("no price, no metering, or metering off: cacheRatio stands in", () => {
  const u = { input: 10000, output: 10, cacheRead: 0, cacheWrite: 0 }
  expect(meter(u, "unknown", 0.05)).toBe(false)
  PRICES["m"] = P
  expect(meter(u, "m", 0)).toBe(false)
  configure({ meter: "off" })
  expect(meter(u, "m", 0.05)).toBe(false)
})

// ---- the stream ------------------------------------------------------------------------

function frame(headers, payload) {
  const enc = new TextEncoder()
  const hs = Object.entries(headers).map(([k, v]) => {
    const name = enc.encode(k)
    const val = enc.encode(v)
    const h = new Uint8Array(4 + name.length + val.length)
    h[0] = name.length
    h.set(name, 1)
    h[1 + name.length] = 7
    new DataView(h.buffer).setUint16(2 + name.length, val.length)
    h.set(val, 4 + name.length)
    return h
  })
  const hlen = hs.reduce((n, h) => n + h.length, 0)
  const body = enc.encode(JSON.stringify(payload))
  const out = new Uint8Array(16 + hlen + body.length)
  new DataView(out.buffer).setUint32(0, out.length)
  new DataView(out.buffer).setUint32(4, hlen)
  let i = 12
  for (const h of hs) {
    out.set(h, i)
    i += h.length
  }
  out.set(body, i)
  return out
}
const ev = (type, payload) => frame({ ":message-type": "event", ":event-type": type }, payload)
const body = (...fs) => new ReadableStream({ start(c) { for (const f of fs) c.enqueue(f); c.close() } })
const all = async (it) => {
  const out = []
  for await (const e of it) out.push(e)
  return out
}

test("the stream's metering becomes the usage, the cache read from it", async () => {
  PRICES["claude-x"] = P
  // the prompt 10000 tokens (the estimate: this model's window isn't
  // listed), all of it cached; the reply "OK…" 44 chars, 10 tokens
  const said = "OK".padEnd(44, ".")
  const credits = (2.16 * 10000 + 128 * 10) / 1e6
  const evs = await all(events(body(ev("assistantResponseEvent", { content: said }), ev("metadataEvent", { stopReason: "END_TURN" }),
    ev("meteringEvent", { unit: "credit", usage: credits })), "claude-x", null, 10000))
  const stop = evs.at(-1)
  expect(stop.kind).toBe("stop")
  expect(stop.usage.credits).toBeCloseTo(credits, 10)
  expect(stop.usage.output).toBe(10)
  expect(stop.usage.cacheRead).toBe(10000)
  expect(stop.usage.input).toBe(0)
})

const sseOf = async (res) => (await res.text()).split("\n\n").filter(Boolean).map((b) => {
  const [e, d] = b.split("\n")
  return { event: e.slice(7), data: JSON.parse(d.slice(6)) }
})

test("the first thinking delta releases magpie's hold once, and a reply without thinking does not", async () => {
  const budget = { budget: 1000, native: true }
  const thinking = await reply(events(body(
    ev("reasoningContentEvent", { text: "先想" }),
    ev("reasoningContentEvent", { text: "清楚" }),
    ev("assistantResponseEvent", { content: "答案" }),
    ev("metadataEvent", { stopReason: "END_TURN" }),
  ), "claude-opus-5.5", budget), "claude-opus-5.5", true)
  const evs = await sseOf(thinking)
  const gates = evs.filter((e) => e.event === "response.done")
  expect(gates).toHaveLength(1)
  expect(gates[0].data).toEqual({ type: "response.done" })
  const start = evs.findIndex((e) => e.data?.content_block?.type === "thinking")
  const firstThink = evs.findIndex((e) => e.data?.delta?.type === "thinking_delta")
  const gate = evs.findIndex((e) => e.event === "response.done")
  expect(start).toBeGreaterThanOrEqual(0)
  expect(firstThink).toBe(start + 1)
  expect(gate).toBe(firstThink + 1)
  expect(evs.filter((e) => e.data?.delta?.type === "thinking_delta").map((e) => e.data.delta.thinking).join("")).toBe("先想清楚")
  expect(evs.filter((e) => e.data?.delta?.type === "text_delta").map((e) => e.data.delta.text).join("")).toBe("答案")

  const plain = await reply(events(body(ev("assistantResponseEvent", { content: "hi" }), ev("metadataEvent", { stopReason: "END_TURN" })),
    "claude-x", null), "claude-x", true)
  expect((await sseOf(plain)).some((e) => e.event === "response.done")).toBe(false)
})

test("a refusal is an answer with stop_reason refusal, not a retried failure", async () => {
  const refused = ev("metadataEvent", { stopDetails: { refusal: { category: "BIO", explanation: "The selected model cannot continue this conversation." } } })
  const evs = await all(events(body(refused, ev("contextUsageEvent", { contextUsagePercentage: 2 })), "claude-x", null, 100))
  expect(evs.some((e) => e.kind === "error")).toBe(false)
  expect(evs.filter((e) => e.kind === "text").map((e) => e.text).join("")).toContain("(BIO)")
  expect(evs.at(-1)).toMatchObject({ kind: "stop", reason: "refusal" })
  const res = await reply(events(body(refused), "claude-x", null, 100), "claude-x", false)
  expect(res.status).toBe(200)
  expect((await res.json()).stop_reason).toBe("refusal")
})

// ---- learning a model's characters a token, from the next turn ----------------------

test("the next turn's exact prompt teaches what the last reply came to, at no cost", async () => {
  // a model of a known window: 100000 tokens, so 1% is 1000 tokens
  const model = "claude-learn"
  _internal.windowsOf().set(model, 100000)
  for (let i = 0; i < 3; i++) {
    const first = { role: "user", content: `Tell me a story (${i}).` }
    // turn 1: a prompt of 10% (10000 tokens), a 3000-character reply
    const story = "x".repeat(3000)
    const req1 = { model, messages: [first] }
    await all(events(body(ev("assistantResponseEvent", { content: story }), ev("contextUsageEvent", { contextUsagePercentage: 10 })),
      model, null, 0, null, req1))
    // turn 2: the reply in the history and a short ask; the prompt grew by
    // 1000 tokens (11%): so the reply was about 1000 tokens, 3 chars a token
    const req2 = { model, messages: [first, { role: "assistant", content: story }, { role: "user", content: "More?" }] }
    await all(events(body(ev("assistantResponseEvent", { content: "Yes." }), ev("contextUsageEvent", { contextUsagePercentage: 11 })),
      model, null, 0, null, req2))
  }
  // learned from three conversations, it stands over the calibrated figure
  expect(charsOf(model)).toBeGreaterThan(2.9)
  expect(charsOf(model)).toBeLessThan(3.1)
})

test("a reply that called a tool, or thought, isn't learned from", async () => {
  const model = "claude-learn2"
  _internal.windowsOf().set(model, 100000)
  for (let i = 0; i < 3; i++) {
    const first = { role: "user", content: `Q${i}` }
    const req1 = { model, messages: [first] }
    await all(events(body(ev("reasoningContentEvent", { text: "hmm" }), ev("assistantResponseEvent", { content: "y".repeat(3000) }),
      ev("contextUsageEvent", { contextUsagePercentage: 10 })), model, null, 0, null, req1))
    const req2 = { model, messages: [first, { role: "assistant", content: "y".repeat(3000) }, { role: "user", content: "More?" }] }
    await all(events(body(ev("assistantResponseEvent", { content: "Yes." }), ev("contextUsageEvent", { contextUsagePercentage: 11 })),
      model, null, 0, null, req2))
  }
  expect(learned.has(model)).toBe(false)
})


test("the provider id is kiro-custom, beside the official kiro", async () => {
  const { KiroAuthPlugin } = await import("./index.mjs")
  const hooks = await KiroAuthPlugin({ client: {} }, {})
  expect(hooks.auth.provider).toBe("kiro-custom")
  expect(hooks.provider.id).toBe("kiro-custom")
  const config = { provider: {} }
  await hooks.config(config)
  expect(config.provider["kiro-custom"].name).toBe("Kiro Custom")
  expect(config.provider.kiro).toBeUndefined()
})

// ---- the JSON sign-in's questions ---------------------------------------------------

test("the JSON sign-in uses the old magpie buttons, then which account only when there are several", async () => {
  const { KiroAuthPlugin } = await import("./index.mjs")
  const hooks = await KiroAuthPlugin({ client: {} }, {})
  const m = hooks.auth.methods.find((x) => /JSON/.test(x.label))
  const q1 = await m.ask({})
  expect(q1).toMatchObject({ key: "how", type: "select", message: "导入导出的 Kiro 账号" })
  expect(q1.options.map((o) => o.label)).toEqual(["选择文件…", "粘贴 JSON"])
  expect(q1.options.map((o) => o.value)).toEqual(["file", "paste"])
  const paste = await m.ask({ how: "paste" })
  expect(paste).toMatchObject({ type: "text", key: "json" })
  expect(paste.message).toContain("粘贴")
  const one = JSON.stringify({ accounts: [{ email: "a@x", credentials: { refreshToken: "r", authMethod: "social" } }] })
  expect(await m.ask({ how: "paste", json: one })).toBeNull()
  expect(await m.ask({ json: one })).toBeNull()
  const two = JSON.stringify({ accounts: [{ email: "a@x", credentials: { refreshToken: "r1", authMethod: "social", provider: "Github" } },
    { email: "b@x", credentials: { refreshToken: "r2", authMethod: "social", provider: "Google" } }] })
  const q2 = await m.ask({ how: "paste", json: two })
  expect(q2.type).toBe("select")
  expect(q2.key).toBe("index")
  expect(q2.message).toBe("导出里的哪个账号？")
  expect(q2.options).toEqual([{ label: "a@x", value: "1", hint: "Github" }, { label: "b@x", value: "2", hint: "Google" }])
  expect(await m.ask({ how: "paste", json: two, index: "2" })).toBeNull()
  // not JSON: no more questions; the sign-in says why
  expect(await m.ask({ json: "{nope" })).toBeNull()
  // OpenCode still asks with a text prompt, not the magpie buttons
  expect(m.prompts[0]).toMatchObject({ type: "text", key: "json" })
  // a file is chosen in the browser, on the import page: no more questions
  expect(await m.ask({ how: "file" })).toBeNull()
})

// ---- the import page --------------------------------------------------------------

test("选择文件… opens the import page, and the address it sends back signs in", async () => {
  const { KiroAuthPlugin, _internal } = await import("./index.mjs")
  const { gzipSync } = await import("node:zlib")
  const hooks = await KiroAuthPlugin({ client: {} }, { importPage: "https://example.test/import.html", importRelay: "off" })
  const m = hooks.auth.methods.find((x) => /JSON/.test(x.label))
  const a = await m.authorize({ how: "file" })
  expect(a.method).toBe("auto")
  const page = new URL(a.url)
  expect(page.origin + page.pathname).toBe("https://example.test/import.html")
  const back = new URL(page.searchParams.get("redirect_uri"))
  // magpie finishes a pasted address only for a port on this computer
  expect(back.protocol).toBe("http:")
  expect(back.hostname).toBe("127.0.0.1")
  const state = page.searchParams.get("state")
  expect(state).toMatch(/^[A-Za-z0-9_-]{16,}$/)
  const done = a.callback()

  // the page can ask whether it reaches the port, from its own origin
  const ping = await fetch(new URL("/ping", back), { headers: { Origin: "https://example.test" } })
  expect(ping.status).toBe(200)
  expect(ping.headers.get("access-control-allow-origin")).toBe("https://example.test")
  expect(ping.headers.get("access-control-allow-private-network")).toBe("true")
  // the page's preflight for its POST
  const pre = await fetch(back.href, { method: "OPTIONS", headers: { Origin: "https://example.test", "Access-Control-Request-Method": "POST" } })
  expect(pre.status).toBe(204)
  expect(pre.headers.get("access-control-allow-methods")).toContain("POST")
  // a wrong state, and an address with no account, are turned away
  const at = (q) => fetch(back.href + "?" + new URLSearchParams(q)).then((r) => r.text())
  expect(await at({ state: "nope", d: "jxx" })).toContain("不是这次导入的")
  expect(await at({ state, d: "g" + Buffer.from("junk").toString("base64url") })).toContain("没有完整的账号")

  // no refresh token: it reaches the sign-in, which says why, with no network
  const text = JSON.stringify({ accounts: [{ email: "a@x", credentials: { authMethod: "social" } }] })
  const d = "g" + gzipSync(Buffer.from(text)).toString("base64url")
  expect(await at({ state, d })).toContain("没有导入账号")
  const r = await done
  expect(r.type).toBe("failed")
  expect(r.error).toContain("no refresh token")
  // the port is closed once it has the account
  expect(await fetch(back.href).then(() => "open", () => "closed")).toBe("closed")

  expect(_internal.importPacked("j" + Buffer.from(text).toString("base64url"))).toBe(text)
  expect(() => _internal.importPacked("x")).toThrow()
})

test("the import page's accounts are all kept: the first as the sign-in, the others beside it", async () => {
  const { _internal } = await import("./index.mjs")
  const set = []
  const client = { auth: { set: async (o) => set.push(o) } }
  // fresh tokens: no refresh, and whoIs fails quietly with no network
  const later = Date.now() + 3600_000
  const acct = (email) => ({ email, credentials: { accessToken: "a-" + email, refreshToken: "r-" + email, expiresAt: later, authMethod: "social", provider: "Github" } })
  const text = JSON.stringify([acct("a@x"), acct("b@x"), { email: "c@x", credentials: { authMethod: "social" } }, acct("d@x")])
  const r = await _internal.importAll(client, text)
  expect(r.type).toBe("success")
  expect(r.accountId).toBe("a@x")
  expect(r.count).toBe(3)
  expect(r.notes.join()).toContain("c@x")
  expect(set.map((o) => o.body.accountId)).toEqual(["b@x", "d@x"])
  for (const o of set) {
    expect(o.path.id).toMatch(/^kiro-custom#[0-9a-f]{8}$/)
    expect(o.body).toMatchObject({ type: "oauth", method: "social", loginProvider: "Github" })
    expect(o.body.refresh).toBe("r-" + o.body.accountId)
  }
  // the same account always goes to the same key, so importing it again replaces it
  const again = []
  await _internal.importAll({ auth: { set: async (o) => again.push(o) } }, text)
  expect(again.map((o) => o.path.id)).toEqual(set.map((o) => o.path.id))
  expect((await _internal.importAll(client, JSON.stringify([{ email: "c@x", credentials: {} }]))).type).toBe("failed")
})

test("off this computer, the page hands the import over through the relay, sealed", async () => {
  const { KiroAuthPlugin, _internal } = await import("./index.mjs")
  const { gzipSync } = await import("node:zlib")
  const key = Buffer.alloc(32, 7)
  expect(_internal.unseal(key, _internal.seal(key, "账号"))).toBe("账号")
  expect(() => _internal.unseal(Buffer.alloc(32, 8), _internal.seal(key, "x"))).toThrow()

  // a stand-in ntfy: one topic's stream, and its reply topic
  const posts = []
  let streamed
  const relay = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url)
      if (req.method === "POST") {
        posts.push({ path: u.pathname, body: await req.text() })
        return new Response("{}")
      }
      if (u.pathname.endsWith("/json")) {
        return new Response(new ReadableStream({ start(c) { streamed = c } }), { headers: { "Content-Type": "application/x-ndjson" } })
      }
      return new Response("no", { status: 404 })
    },
  })
  try {
    const hooks = await KiroAuthPlugin({ client: {} }, { importPage: "https://example.test/import.html", importRelay: `http://127.0.0.1:${relay.port}` })
    const m = hooks.auth.methods.find((x) => /JSON/.test(x.label))
    const a = await m.authorize({ how: "file" })
    const frag = new URLSearchParams(new URL(a.url).hash.slice(1))
    const topic = new URL(frag.get("relay")).pathname
    expect(topic).toMatch(/^\/kiro-[A-Za-z0-9_-]{24}$/)
    const k = Buffer.from(frag.get("k"), "base64url")
    expect(k.length).toBe(32)
    // the key is never in the query, which a server would see
    expect(new URL(a.url).search).not.toContain(frag.get("k"))
    const done = a.callback()
    for (let i = 0; i < 50 && !streamed; i++) await Bun.sleep(20)
    const enc = (o) => new TextEncoder().encode(JSON.stringify(o) + String.fromCharCode(10))
    // someone else's message on the topic is passed over
    streamed.enqueue(enc({ id: "1", event: "message", message: "junk" }))
    const text = JSON.stringify([{ email: "a@x", credentials: { authMethod: "social" } }])
    streamed.enqueue(enc({ id: "2", event: "message", message: _internal.seal(k, "g" + gzipSync(Buffer.from(text)).toString("base64url")) }))
    const r = await done
    expect(r.type).toBe("failed")
    expect(r.error).toContain("no refresh token")
    for (let i = 0; i < 50 && !posts.length; i++) await Bun.sleep(20)
    expect(posts[0].path).toBe(topic + "-r")
    expect(JSON.parse(_internal.unseal(k, posts[0].body))).toMatchObject({ ok: false, title: "没有导入账号" })
  } finally {
    relay.stop(true)
  }
})

test("importRelay off leaves the link without a relay", async () => {
  const { KiroAuthPlugin } = await import("./index.mjs")
  const hooks = await KiroAuthPlugin({ client: {} }, { importPage: "https://example.test/import.html", importRelay: "off" })
  const a = await hooks.auth.methods.find((x) => /JSON/.test(x.label)).authorize({ how: "file" })
  expect(new URL(a.url).hash).toBe("")
  const back = new URL(new URL(a.url).searchParams.get("redirect_uri"))
  const done = a.callback()
  await fetch(back.href + "?" + new URLSearchParams({ state: new URL(a.url).searchParams.get("state"), d: "j" + Buffer.from("[]").toString("base64url") }))
  expect((await done).type).toBe("failed")
})

test("the page posts the accounts to the port and stays, told how it went", async () => {
  const { KiroAuthPlugin } = await import("./index.mjs")
  const { gzipSync } = await import("node:zlib")
  const hooks = await KiroAuthPlugin({ client: {} }, { importPage: "https://example.test/import.html", importRelay: "off" })
  const a = await hooks.auth.methods.find((x) => /JSON/.test(x.label)).authorize({ how: "file" })
  const page = new URL(a.url)
  const back = new URL(page.searchParams.get("redirect_uri"))
  const done = a.callback()
  const post = (q, body) => fetch(back.href + "?" + new URLSearchParams(q), { method: "POST", body, headers: { Origin: "https://example.test" } })
  const wrong = await post({ state: "nope" }, "j")
  expect(wrong.status).toBe(403)
  expect(wrong.headers.get("access-control-allow-origin")).toBe("https://example.test")
  expect((await post({ state: page.searchParams.get("state") }, "junk")).status).toBe(400)
  const text = JSON.stringify([{ email: "a@x", credentials: { authMethod: "social" } }])
  const r = await post({ state: page.searchParams.get("state") }, "g" + gzipSync(Buffer.from(text)).toString("base64url"))
  expect(r.status).toBe(200)
  expect(await r.json()).toMatchObject({ ok: false, title: "没有导入账号" })
  expect((await done).error).toContain("no refresh token")
})
