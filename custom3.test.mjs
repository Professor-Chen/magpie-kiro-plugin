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

test("the JSON sign-in asks for the JSON, then which account only when there are several", async () => {
  const { KiroAuthPlugin } = await import("./index.mjs")
  const hooks = await KiroAuthPlugin({ client: {} }, {})
  const m = hooks.auth.methods.find((x) => /JSON/.test(x.label))
  const q1 = await m.ask({})
  expect(q1).toMatchObject({ key: "json", type: "file" })
  const one = JSON.stringify({ accounts: [{ email: "a@x", credentials: { refreshToken: "r", authMethod: "social" } }] })
  expect(await m.ask({ json: one })).toBeNull()
  const two = JSON.stringify({ accounts: [{ email: "a@x", credentials: { refreshToken: "r1", authMethod: "social", provider: "Github" } },
    { email: "b@x", credentials: { refreshToken: "r2", authMethod: "social", provider: "Google" } }] })
  const q2 = await m.ask({ json: two })
  expect(q2.type).toBe("select")
  expect(q2.options).toEqual([{ label: "a@x", value: "1", hint: "Github" }, { label: "b@x", value: "2", hint: "Google" }])
  expect(await m.ask({ json: two, index: "2" })).toBeNull()
  // not JSON: no more questions; the sign-in says why
  expect(await m.ask({ json: "{nope" })).toBeNull()
})
