// The fork's additions: importing an exported account (Kiro Account
// Manager, Cockpit, kiro.rs), the cache ratio, the IDE fingerprint, the
// estimated prompt in message_start, retries and keepalive pings. No
// network and no real sign-in: fetch is stood in for, and the tokens are
// made up.
import { test, expect, afterEach } from "bun:test"
import { _internal } from "./index.mjs"

const { importedAccounts, expiresOf, machineIdOf, normalizeMachineId, kiroHeaders, chatURL, configure, cfg, withCache, estimateInput,
  generate, events, reply, setPing } = _internal

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  configure({})
  setPing(15_000)
})

const MID = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"

const manager = {
  version: "1.7.5",
  exportedAt: 1792045253468,
  accounts: [
    {
      email: "one@example.com",
      idp: "Github",
      credentials: { accessToken: "aoa-1", refreshToken: "aor-1", clientId: "", clientSecret: "", region: "us-east-1",
        expiresAt: 1792046070310, authMethod: "social", provider: "Github" },
      machineId: MID,
      status: "active",
      _new_password: "secret",
    },
    { email: "off@example.com", credentials: { refreshToken: "aor-2", authMethod: "social" }, status: "banned" },
  ],
  groups: [],
  tags: [],
}

const cockpit = {
  version: "cockpit-kiro-import",
  accounts: [
    {
      email: "two@example.com",
      idp: "Google",
      auth: { accessToken: "aoa-3", refreshToken: "aor-3", region: "eu-central-1", expiresAt: 1791954038137, authMethod: "social", provider: "Google" },
      machineId: MID,
      status: "active",
    },
  ],
}

test("Kiro Account Manager's export: the active accounts, their sign-in alone", () => {
  const { accounts, skipped } = importedAccounts(JSON.stringify(manager))
  expect(accounts).toHaveLength(1)
  expect(skipped).toEqual(["off@example.com: banned"])
  const [a] = accounts
  expect(a.user).toBe("one@example.com")
  expect(a.auth).toEqual({ access: "aoa-1", refresh: "aor-1", expires: 1792046070310, method: "social", region: "us-east-1",
    loginProvider: "Github", machineId: MID, accountId: "one@example.com" })
  expect(JSON.stringify(a)).not.toContain("secret")
})

test("Cockpit's export: its auth, its region", () => {
  const [a] = importedAccounts(cockpit).accounts
  expect(a.auth.refresh).toBe("aor-3")
  expect(a.auth.region).toBe("eu-central-1")
  expect(a.auth.loginProvider).toBe("Google")
})

test("kiro.rs's credentials.json: one object or an array, IdC with its client", () => {
  const one = { refreshToken: "r", accessToken: "a", expiresAt: "2026-10-15T01:00:00Z", authMethod: "idc", clientId: "c", clientSecret: "s",
    region: "us-west-2", profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/X" }
  const [a] = importedAccounts(one).accounts
  expect(a.auth.method).toBe("idc")
  expect(a.auth.clientId).toBe("c")
  expect(a.auth.expires).toBe(Date.parse("2026-10-15T01:00:00Z"))
  expect(a.auth.profileArn).toBe(one.profileArn)
  // builder-id and iam are taken for idc, as kiro.rs takes them
  expect(importedAccounts([{ ...one, authMethod: "builder-id" }]).accounts[0].auth.method).toBe("idc")
  // an IdC sign-in without its client can't be refreshed
  const { accounts, skipped } = importedAccounts([{ refreshToken: "r", authMethod: "idc" }])
  expect(accounts).toHaveLength(0)
  expect(skipped[0]).toContain("clientId")
})

test("an account with no refresh token, or JSON that isn't, is said so", () => {
  expect(importedAccounts({ accounts: [{ email: "x", credentials: { accessToken: "a" } }] }).skipped).toEqual(["x: no refresh token"])
  expect(() => importedAccounts("{nope")).toThrow("that isn't JSON")
})

test("an expiry in milliseconds, seconds or a date", () => {
  expect(expiresOf(1792046070310)).toBe(1792046070310)
  expect(expiresOf(1792046070)).toBe(1792046070000)
  expect(expiresOf("1792046070310")).toBe(1792046070310)
  expect(expiresOf("2026-10-15T00:00:00.000Z")).toBe(Date.parse("2026-10-15T00:00:00.000Z"))
  expect(expiresOf(undefined)).toBe(0)
})

test("the machine id: the account's own, a UUID doubled, else a hash that stays", () => {
  expect(normalizeMachineId(MID.toUpperCase())).toBe(MID)
  expect(normalizeMachineId("2582956e-cc88-4669-b546-07adbffcb894")).toBe("2582956ecc884669b54607adbffcb8942582956ecc884669b54607adbffcb894")
  expect(normalizeMachineId("nope")).toBe("")
  expect(machineIdOf({ machineId: MID })).toBe(MID)
  const a = machineIdOf({ seed: "one@example.com", refresh: "r1" })
  // a refresh, which may replace the refresh token, keeps the id
  expect(machineIdOf({ seed: "one@example.com", refresh: "r2" })).toBe(a)
  expect(a).toMatch(/^[0-9a-f]{64}$/)
})

test("the IDE fingerprint by default, kiro-cli's when asked", () => {
  configure({ kiroVersion: "0.9.2", nodeVersion: "22.21.1", systemVersion: "darwin#24.6.0" })
  const h = kiroHeaders({ token: "t", machineId: MID }, 2, 3)
  expect(h["x-amz-user-agent"]).toBe(`aws-sdk-js/1.0.34 KiroIDE-0.9.2-${MID}`)
  expect(h["User-Agent"]).toBe(`aws-sdk-js/1.0.34 ua/2.1 os/darwin#24.6.0 lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.34 m/E KiroIDE-0.9.2-${MID}`)
  expect(h["amz-sdk-request"]).toBe("attempt=2; max=3")
  expect(h.Authorization).toBe("Bearer t")
  configure({ fingerprint: "cli" })
  expect(kiroHeaders({ token: "t" })["User-Agent"]).toContain("app/AmazonQ-For-CLI")
})

test("the endpoint: Kiro's runtime, or Q's", () => {
  expect(chatURL("us-east-1")).toBe("https://runtime.us-east-1.kiro.dev/generateAssistantResponse")
  configure({ endpoint: "q" })
  expect(chatURL("eu-central-1")).toBe("https://q.eu-central-1.amazonaws.com/generateAssistantResponse")
})

test("settings: options first, then the environment, clamped", () => {
  process.env.KIRO_CACHE_RATIO = "0.5"
  try {
    expect(configure({}).cacheRatio).toBe(0.5)
    expect(configure({ cacheRatio: 0.8 }).cacheRatio).toBe(0.8)
    expect(configure({ cacheRatio: 7 }).cacheRatio).toBe(1)
    expect(configure({ cacheRatio: "x" }).cacheRatio).toBe(0)
    expect(configure({ retries: 9 }).retries).toBe(5)
  } finally {
    delete process.env.KIRO_CACHE_RATIO
  }
})

test("the cache ratio splits the prompt; Kiro's own figures stand", () => {
  configure({ cacheRatio: 0.8 })
  expect(withCache({ input: 1000, output: 5, cacheRead: 0, cacheWrite: 0 })).toEqual({ input: 200, output: 5, cacheRead: 800, cacheWrite: 0 })
  expect(withCache({ input: 1000, output: 5, cacheRead: 300, cacheWrite: 0 })).toEqual({ input: 1000, output: 5, cacheRead: 300, cacheWrite: 0 })
  configure({})
  expect(withCache({ input: 1000, output: 5, cacheRead: 0, cacheWrite: 0 }).cacheRead).toBe(0)
})

test("the prompt's size, estimated: text, CJK, images, tools", () => {
  const n = estimateInput({ system: "a".repeat(400), messages: [{ role: "user", content: [{ type: "text", text: "你好世界" },
    { type: "image", source: { type: "base64", data: "x" } }] }], tools: [{ name: "Bash", description: "", input_schema: {} }] })
  expect(n).toBe(Math.ceil(400 / 4 + 4 + "Bash{}".length / 4) + 1600)
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
const text = (content) => frame({ ":message-type": "event", ":event-type": "assistantResponseEvent" }, { content })
const ctx = (pct) => frame({ ":message-type": "event", ":event-type": "contextUsageEvent" }, { contextUsagePercentage: pct })
const body = (...fs) => new ReadableStream({ start(c) { for (const f of fs) c.enqueue(f); c.close() } })
const sseOf = async (res) => (await res.text()).split("\n\n").filter(Boolean).map((b) => {
  const [e, d] = b.split("\n")
  return { event: e.slice(7), data: JSON.parse(d.slice(6)) }
})

test("message_start tells the prompt's estimated size, and message_delta the cache split", async () => {
  configure({ cacheRatio: 0.75 })
  const res = await reply(events(body(text("hi")), "claude-x", 0, 1000), "claude-x", true, new Map(), 1000)
  const evs = await sseOf(res)
  expect(evs[0].data.message.usage).toEqual({ input_tokens: 250, output_tokens: 1, cache_read_input_tokens: 750, cache_creation_input_tokens: 0 })
  const d = evs.find((e) => e.event === "message_delta").data.usage
  expect(d.cache_read_input_tokens).toBe(750)
  expect(d.input_tokens).toBe(250)
})

test("a long silence mid-answer is kept alive with pings, the answer after them", async () => {
  setPing(20)
  let push
  const slow = new ReadableStream({ start(c) { push = c } })
  // the first event is awaited before the reply is given (an error before
  // it is a status, so another account takes over); the silence after it is pinged
  push.enqueue(text("early "))
  const done = reply(events(slow, "claude-x", 0, 10), "claude-x", true)
  setTimeout(() => {
    push.enqueue(text("late"))
    push.close()
  }, 120)
  const evs = await sseOf(await done)
  expect(evs.filter((e) => e.event === "ping").length).toBeGreaterThan(0)
  expect(evs.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text).join("")).toBe("early late")
  expect(evs.at(-1).event).toBe("message_stop")
})

// ---- retries ---------------------------------------------------------------------------

const creds = async () => ({ token: "t", profile: "arn:aws:codewhisperer:us-east-1:1:profile/X", region: "us-east-1", machineId: MID })
const req = { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false }
const ok = () => new Response(body(text("fine"), ctx(1)), { status: 200 })

test("a 503 or a network error is tried again, and then answered", async () => {
  configure({ retries: 2 })
  const seen = []
  let n = 0
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers["amz-sdk-request"])
    n++
    if (n === 1) return new Response(JSON.stringify({ message: "busy" }), { status: 503 })
    if (n === 2) throw new TypeError("socket hang up")
    return ok()
  }
  const res = await generate(creds, {}, req)
  expect(res.status).toBe(200)
  expect((await res.json()).content[0].text).toBe("fine")
  expect(seen).toEqual(["attempt=1; max=3", "attempt=2; max=3", "attempt=3; max=3"])
}, 20_000)

test("a monthly limit isn't waited on: the next account, at once", async () => {
  let n = 0
  globalThis.fetch = async () => {
    n++
    return new Response(JSON.stringify({ message: "limit", reason: "MONTHLY_REQUEST_COUNT" }), { status: 429 })
  }
  const res = await generate(creds, {}, req)
  expect(res.status).toBe(429)
  expect(n).toBe(1)
})

test("a 400 is never tried again", async () => {
  let n = 0
  globalThis.fetch = async () => {
    n++
    return new Response(JSON.stringify({ message: "Improperly formed request." }), { status: 400 })
  }
  expect((await generate(creds, {}, req)).status).toBe(400)
  expect(n).toBe(1)
})

test("with no retries, one try", async () => {
  configure({ retries: 0 })
  let n = 0
  globalThis.fetch = async () => {
    n++
    return new Response("", { status: 503 })
  }
  expect((await generate(creds, {}, req)).status).toBe(503)
  expect(n).toBe(1)
})
