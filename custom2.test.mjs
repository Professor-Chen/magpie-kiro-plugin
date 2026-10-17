// The fork's second round: the thinking levels (budgets, bounds, adaptive,
// the effort field), the thinking sent back in the history, its closing tag
// told from one quoted, tool calls said in words, a description cut, an
// empty reply tried again, a suspended account marked, pacing. No network:
// fetch is stood in for, and the tokens are made up.
import { test, expect, afterEach } from "bun:test"
import { _internal } from "./index.mjs"

const { thinking, thinkingPrefix, effortField, configure, BUDGETS, buildKiro, events, reply, TextCalls, realClose, refreshUA, generate, configModel } =
  _internal

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  configure({})
})

// ---- the thinking levels -----------------------------------------------------------

test("each effort its own budget, max past xhigh", () => {
  const b = (effort, model = "claude-opus-5.5") => thinking({ output_config: { effort } }, model)?.budget
  expect([b("medium"), b("high"), b("xhigh"), b("max")]).toEqual([20000, 30000, 50000, 64000])
  // low alone asks no thinking; asked to think, it is low's budget
  expect(thinking({ output_config: { effort: "low" } }, "claude-opus-5.5")).toBeNull()
  expect(thinking({ thinking: { type: "enabled" }, output_config: { effort: "low" } }, "claude-opus-5.5").budget).toBe(10000)
  // a model that doesn't think, or thinking turned off, asks none
  expect(thinking({ output_config: { effort: "high" } }, "deepseek-3.2")).toBeNull()
  expect(thinking({ thinking: { type: "disabled" }, output_config: { effort: "high" } }, "claude-opus-5.5")).toBeNull()
})

test("the caller's budget_tokens, within the bounds", () => {
  expect(thinking({ thinking: { type: "enabled", budget_tokens: 12345 } }, "auto").budget).toBe(12345)
  expect(thinking({ thinking: { type: "enabled", budget_tokens: 10 } }, "auto").budget).toBe(1024)
  expect(thinking({ thinking: { type: "enabled", budget_tokens: 999999 } }, "auto").budget).toBe(64000)
  configure({ thinkingMax: 32000 })
  expect(thinking({ output_config: { effort: "max" } }, "claude-x").budget).toBe(32000)
})

test("budgets can be set, as options or the environment", () => {
  configure({ budgets: { high: 40000, max: 100000 } })
  expect(BUDGETS.high).toBe(40000)
  configure({ budgets: "medium=25000, xhigh=60000", thinkingMax: 200000 })
  expect(BUDGETS).toMatchObject({ medium: 25000, xhigh: 60000, high: 30000 })
  expect(configModel({ id: "claude-x", name: "x" }).variants.xhigh.thinking.budgetTokens).toBe(60000)
  process.env.KIRO_BUDGETS = "low=5000"
  try {
    configure({})
    expect(BUDGETS.low).toBe(5000)
  } finally {
    delete process.env.KIRO_BUDGETS
  }
})

test("adaptive thinking goes as a length by default, kiro-cli's adaptive mode when asked", () => {
  const req = { thinking: { type: "adaptive" }, output_config: { effort: "high" } }
  expect(thinkingPrefix(thinking(req, "auto"))).toBe("<thinking_mode>enabled</thinking_mode><max_thinking_length>30000</max_thinking_length>")
  configure({ adaptive: true })
  const t = thinking({ thinking: { type: "adaptive" }, output_config: { effort: "medium" } }, "claude-sonnet-4.6")
  expect(thinkingPrefix(t)).toBe("<thinking_mode>adaptive</thinking_mode><thinking_effort>medium</thinking_effort>")
  // Kiro's adaptive knows low, medium and high: higher is high
  expect(thinkingPrefix(thinking({ thinking: { type: "adaptive" }, output_config: { effort: "max" } }, "auto"))).toContain(
    "<thinking_effort>high</thinking_effort>")
})

test("a native thinker (Opus/Sonnet 4.7 and later) is asked by its own fields, not the prompt", () => {
  const req = { output_config: { effort: "xhigh" }, messages: [{ role: "user", content: "hi" }] }
  const t = thinking(req, "claude-opus-5.5")
  expect(t.native).toBe(true)
  const body = JSON.parse(buildKiro(req, "claude-opus-5.5", "", t))
  expect(body.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } })
  expect(body.conversationState.currentMessage.userInputMessage.content).not.toContain("<thinking_mode>")
  // a length named, no effort: the effort it comes nearest
  expect(effortField({ thinking: { type: "enabled", budget_tokens: 31000 } }, "claude-sonnet-5.5",
    thinking({ thinking: { type: "enabled", budget_tokens: 31000 } }, "claude-sonnet-5.5"))).toEqual(
    { thinking: { type: "adaptive" }, output_config: { effort: "high" } })
  // thinking off: the least effort, as it thinks however asked
  expect(effortField({ thinking: { type: "disabled" } }, "claude-opus-4.7", null)).toEqual({ output_config: { effort: "low" } })
  expect(effortField({ output_config: { effort: "low" } }, "claude-opus-4.8", null)).toEqual({ output_config: { effort: "low" } })
  expect(effortField({}, "claude-opus-5.5", null)).toBeUndefined()
})

test("4.6, 4.5, Haiku and other models think by the prompt, never sent the field", () => {
  for (const m of ["claude-sonnet-4.6", "claude-opus-4.6", "claude-sonnet-4.5", "claude-haiku-4.5", "auto"]) {
    const req = { output_config: { effort: "high" }, messages: [{ role: "user", content: "hi" }] }
    const t = thinking(req, m)
    expect(t.native).toBe(false)
    const body = JSON.parse(buildKiro(req, m, "", t))
    expect(body.additionalModelRequestFields).toBeUndefined()
    expect(body.conversationState.currentMessage.userInputMessage.content).toContain("<max_thinking_length>30000</max_thinking_length>")
  }
})

test("effortField off asks every model by the prompt", () => {
  configure({ effortField: "off" })
  const req = { output_config: { effort: "high" }, messages: [{ role: "user", content: "hi" }] }
  const t = thinking(req, "claude-opus-5.5")
  const body = JSON.parse(buildKiro(req, "claude-opus-5.5", "", t))
  expect(body.additionalModelRequestFields).toBeUndefined()
  expect(body.conversationState.currentMessage.userInputMessage.content).toContain("<thinking_mode>enabled</thinking_mode>")
})

test("a prompt that already says how to think isn't told twice", () => {
  const t = thinking({ output_config: { effort: "high" } }, "auto")
  const sys = "<thinking_mode>enabled</thinking_mode><max_thinking_length>5</max_thinking_length>\nbe brief"
  const s = JSON.parse(buildKiro({ system: sys, messages: [{ role: "user", content: "hi" }] }, "auto", "", t)).conversationState
  expect(s.currentMessage.userInputMessage.content.match(/<thinking_mode>/g)).toHaveLength(1)
})

// ---- the thinking in the history ---------------------------------------------------

test("what the model thought goes back in the history, thinking still asked", () => {
  const req = {
    output_config: { effort: "high" },
    messages: [
      { role: "user", content: "add 2 and 2" },
      { role: "assistant", content: [{ type: "thinking", thinking: "2+2 is 4", signature: "" }, { type: "text", text: "4" }] },
      { role: "user", content: "and times 3?" },
    ],
  }
  const t = thinking(req, "claude-sonnet-4.5")
  const h = JSON.parse(buildKiro(req, "claude-sonnet-4.5", "", t)).conversationState.history
  expect(h[1].assistantResponseMessage.content).toBe("<thinking>2+2 is 4</thinking>\n\n4")
  // not asked to think, the history goes without it
  const h2 = JSON.parse(buildKiro({ ...req, output_config: {} }, "claude-sonnet-4.5", "", null)).conversationState.history
  expect(h2[1].assistantResponseMessage.content).toBe("4")
  // a native thinker's reasoning was its own, not its words: not sent back
  const h3 = JSON.parse(buildKiro(req, "claude-opus-5.5", "", thinking(req, "claude-opus-5.5"))).conversationState.history
  expect(h3[1].assistantResponseMessage.content).toBe("4")
})

const reasoning = (t) => frame({ ":message-type": "event", ":event-type": "reasoningContentEvent" }, { text: t })

test("a native thinker's reasoning is thinking when asked, hidden when not", async () => {
  const native = thinking({ output_config: { effort: "high" } }, "claude-opus-5.5")
  const asked = await all(events(body(reasoning("let me "), reasoning("see"), text("<thinking>not a tag here")), "claude-opus-5.5", native))
  expect(joined(asked, "think")).toBe("let me see")
  // the reply's words are text, a "<thinking>" in them included
  expect(joined(asked, "text")).toBe("<thinking>not a tag here")
  const unasked = await all(events(body(reasoning("quiet"), text("42")), "claude-opus-5.5", null))
  expect(joined(unasked, "think")).toBe("")
  expect(joined(unasked, "text")).toBe("42")
})

// ---- the closing tag ---------------------------------------------------------------

test("the thinking ends at its own closing tag, not one quoted", () => {
  expect(realClose("a `</thinking>` b</thinking>\n\nc", false)).toBe(17)
  expect(realClose('say "</thinking>" ok', true)).toBe(-1)
  // without the blank line it may yet go on; at the end it ends
  expect(realClose("a</thinking>", false)).toBe(-1)
  expect(realClose("a</thinking>  ", true)).toBe(1)
})

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
const text = (content) => frame({ ":message-type": "event", ":event-type": "assistantResponseEvent" }, { content })
const body = (...fs) => new ReadableStream({ start(c) { for (const f of fs) c.enqueue(f); c.close() } })
const all = async (it) => {
  const out = []
  for await (const e of it) out.push(e)
  return out
}
const joined = (evs, kind) => evs.filter((e) => e.kind === kind).map((e) => e.text).join("")

test("a reply that writes of the tag in its thinking is split where the thinking ends", async () => {
  const evs = await all(events(body(text("<thinking>the tag `</thinking>` is "), text("quoted</thinking>"), text("\n\nAnswer.")), "claude-x", 20000))
  expect(joined(evs, "think")).toBe("the tag `</thinking>` is quoted")
  expect(joined(evs, "text")).toBe("Answer.")
})

test("thinking that ends the reply with its tag, nothing after, is thinking", async () => {
  const evs = await all(events(body(text("<thinking>hmm</thinking>")), "claude-x", 20000))
  expect(joined(evs, "think")).toBe("hmm")
  expect(joined(evs, "text")).toBe("")
})

// ---- tool calls said in words ------------------------------------------------------

test("a call said in words is the call, the text around it kept", async () => {
  const known = new Set(["Bash"])
  const evs = await all(events(body(text("Let me look.\n[Called Ba"), text('sh with args: {"command":"ls -la","n":[1,2]}]'), text("\nDone.")), "claude-x", 0, 0, known))
  expect(joined(evs, "text")).toBe("Let me look.\nDone.")
  const start = evs.find((e) => e.kind === "toolStart")
  expect(start.name).toBe("Bash")
  expect(JSON.parse(joined(evs, "toolArgs"))).toEqual({ command: "ls -la", n: [1, 2] })
  expect(evs.at(-1)).toMatchObject({ kind: "stop", reason: "tool_use" })
})

test("words that only look like a call stay words", () => {
  const c = new TextCalls(new Set(["Bash"]))
  const out = [...c.feed("[Called Nope with args: {}] and [Called Bash with args: not json] and [x]"), ...c.end()]
  expect(out.every((e) => e.kind === "text")).toBe(true)
  expect(out.map((e) => e.text).join("")).toBe("[Called Nope with args: {}] and [Called Bash with args: not json] and [x]")
})

// ---- tool descriptions ---------------------------------------------------------------

test("a tool's long description is cut", () => {
  const long = "x".repeat(20000)
  const s = JSON.parse(buildKiro({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "Big", description: long, input_schema: {} }] }, "auto", "", null))
  const d = s.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.description
  expect(d.length).toBeLessThanOrEqual(9216)
  expect(d.endsWith("… (cut)")).toBe(true)
})

// ---- the request ----------------------------------------------------------------------

const MID = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"
const creds = async () => ({ token: "t", profile: "arn:aws:codewhisperer:us-east-1:1:profile/X", region: "us-east-1", machineId: MID })
const req = { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false }

test("an empty 200 is tried again", async () => {
  let n = 0
  globalThis.fetch = async () => (++n === 1 ? new Response(body(), { status: 200 }) : new Response(body(text("ok")), { status: 200 }))
  const res = await generate(creds, {}, req)
  expect(res.status).toBe(200)
  expect((await res.json()).content[0].text).toBe("ok")
  expect(n).toBe(2)
}, 20_000)

test("a suspended account is marked, not refreshed", async () => {
  let refreshed = 0
  let n = 0
  globalThis.fetch = async () => {
    n++
    return new Response(JSON.stringify({ message: "Your User ID temporarily is suspended", reason: "TEMPORARILY_SUSPENDED" }), { status: 403 })
  }
  const c = async (_a, stale) => {
    if (stale) refreshed++
    return creds()
  }
  const res = await generate(c, {}, req)
  expect(res.status).toBe(403)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await res.json()).error.message).toContain("suspended")
  expect(refreshed).toBe(0)
  expect(n).toBe(1)
})

test("another 403 is refreshed once, then said, the account kept", async () => {
  let refreshed = 0
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "The bearer token included in the request is invalid." }), { status: 403 })
  const c = async (_a, stale) => {
    if (stale) refreshed++
    return creds()
  }
  const res = await generate(c, {}, req)
  expect(res.status).toBe(403)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect(refreshed).toBe(1)
})

test("requests of one account are paced by minInterval", async () => {
  configure({ minInterval: 150 })
  const at = []
  globalThis.fetch = async () => {
    at.push(Date.now())
    return new Response(body(text("ok")), { status: 200 })
  }
  await generate(creds, {}, req)
  await generate(creds, {}, req)
  expect(at[1] - at[0]).toBeGreaterThanOrEqual(140)
})

test("a 408 is tried again", async () => {
  let n = 0
  globalThis.fetch = async () => (++n === 1 ? new Response("", { status: 408 }) : new Response(body(text("ok")), { status: 200 }))
  expect((await generate(creds, {}, req)).status).toBe(200)
  expect(n).toBe(2)
}, 20_000)

test("the refresh says it is the IDE the requests say", () => {
  configure({ kiroVersion: "0.9.2" })
  expect(refreshUA({ machineId: MID })).toBe(`KiroIDE-0.9.2-${MID}`)
  configure({ fingerprint: "cli" })
  expect(refreshUA({ machineId: MID })).toBe("Kiro-Desktop/0.2.13 (darwin; arm64)")
})
