// The browser sign-in, finished from another computer: magpie on a server
// or in Docker, its browser elsewhere. The page the browser ends on (a
// port on localhost) won't load there, so its address is pasted into
// magpie, which opens it on this machine, where the plugin listens, and
// takes a 302 to an https page coming back to the same port as the next
// page to open (magpie's pluginsignin_paste.go, openPastedCallback). Google
// and GitHub come back once; Builder ID and Identity Center twice, Kiro's
// page then AWS's. Each stage takes only its own state, once; an address
// that isn't this sign-in's is a 404 and ends nothing.
// Every token here is synthetic.
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let plugin
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real sign-in is ever read or written
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ KiroAuthPlugin: plugin } = await import("./index.mjs"))
})
const real = globalThis.fetch
const offline = async () => { throw new Error("no network in tests") }
globalThis.fetch = offline
afterAll(() => (globalThis.fetch = real))
afterEach(() => (globalThis.fetch = offline))

const EMAIL = "remote@example.com"
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"]

// loopbackPorts is magpie's: the ports a page's address sends the browser
// back to, as a redirect address on localhost names them.
function loopbackPorts(page) {
  const ports = []
  for (const [, v] of new URL(page).searchParams) {
    try {
      const r = new URL(v)
      if (r.protocol === "http:" && LOOPBACK.includes(r.hostname) && !ports.includes(r.port || "80")) ports.push(r.port || "80")
    } catch {}
  }
  return ports
}

// paste is magpie's openPastedCallback: an http address on loopback at one
// of the sign-in's ports, opened on 127.0.0.1, its redirect not followed;
// a 302 to https coming back to one of those ports is the next page.
async function paste(ports, raw) {
  const u = new URL(raw.trim())
  if (u.protocol !== "http:" || !LOOPBACK.includes(u.hostname) || !ports.includes(u.port || "80")) return { refused: true }
  const r = await real(`http://127.0.0.1:${u.port}${u.pathname}${u.search}`, { redirect: "manual" })
  await r.text()
  const loc = r.headers.get("location") ?? ""
  const next = r.status >= 300 && r.status < 400 && loc.startsWith("https://") && loopbackPorts(loc).some((p) => ports.includes(p)) ? loc : ""
  return { status: r.status, next }
}

// kiro is Kiro's auth service, AWS's OIDC service and Kiro's API as a
// sign-in sees them; it notes what each was sent, and loopback goes on to
// the plugin's port.
function kiro({ tokenWait = 0, registerWait = 0 } = {}) {
  const seen = { social: [], register: [], token: [], other: [] }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.hostname === "127.0.0.1") return real(input, init)
    const body = init.body ? JSON.parse(init.body) : undefined
    if (url.href === "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token") {
      seen.social.push(body)
      return Response.json({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresIn: 3600,
        profileArn: "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST" })
    }
    if (/^oidc\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) && url.pathname === "/client/register") {
      seen.register.push({ host: url.hostname, body })
      if (registerWait) await new Promise((r) => setTimeout(r, registerWait))
      return Response.json({ clientId: "synthetic-client", clientSecret: "synthetic-secret" })
    }
    if (/^oidc\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) && url.pathname === "/token") {
      seen.token.push({ host: url.hostname, body })
      if (tokenWait) await new Promise((r) => setTimeout(r, tokenWait))
      return Response.json({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresIn: 3600 })
    }
    if (url.pathname === "/List-Available-Profiles") return Response.json({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:222222222222:profile/IDC" }] })
    if (url.pathname === "/getUsageLimits" || url.pathname === "/Get-Usage-Limits") return Response.json({ userInfo: { email: EMAIL } })
    seen.other.push(url.href)
    return new Response("{}", { status: 500 })
  }
  return seen
}

// start begins the browser sign-in as magpie's host does: authorize() (no
// prompts, so no inputs), then callback() for an "auto" method, its
// result followed as it settles.
async function start() {
  const m = (await plugin({})).auth.methods[0]
  expect(m.prompts[0].type).toBe("select")
  const a = await m.authorize(undefined)
  const page = new URL(a.url)
  const ports = loopbackPorts(a.url)
  const flow = { a, ports, state: page.searchParams.get("state"), challenge: page.searchParams.get("code_challenge"),
    back: page.searchParams.get("redirect_uri").replace(/\/$/, ""), result: null }
  flow.done = a.callback().then((r) => (flow.result = r))
  return flow
}
const settle = () => new Promise((r) => setTimeout(r, 30))
const sha = (v) => createHash("sha256").update(v).digest("base64url")

test("the page's address comes back to a port here, so magpie takes the address pasted", async () => {
  kiro()
  const f = await start()
  expect(f.a.method).toBe("auto")
  expect(f.ports).toHaveLength(1)
  expect(new URL(f.back).hostname).toBe("localhost")
  // anywhere else isn't taken by magpie, and never reaches the plugin
  expect(await paste(f.ports, "https://example.com/?code=x")).toEqual({ refused: true })
  expect(await paste(f.ports, "http://localhost:1/oauth/callback?code=x")).toEqual({ refused: true })
  await settle()
  expect(f.result).toBeNull()
})

test("Google: one pasted address signs in, with the PKCE verifier its page was given the challenge of", async () => {
  const seen = kiro()
  const f = await start()
  // as the browser shows it: localhost, opened by magpie on 127.0.0.1
  const r = await paste(f.ports, `  ${f.back}/oauth/callback?login_option=google&code=synthetic-code&state=${f.state}\n`)
  expect(r).toEqual({ status: 200, next: "" })
  await f.done
  expect(seen.social).toHaveLength(1)
  expect(seen.social[0]).toMatchObject({ code: "synthetic-code", redirect_uri: `${f.back}/oauth/callback?login_option=google` })
  expect(sha(seen.social[0].code_verifier)).toBe(f.challenge)
  expect(f.result).toMatchObject({ type: "success", accountId: EMAIL + " (Google)", uid: "google", method: "social", access: "synthetic-access" })
  // over: its address again, or any other, is a 404 and changes nothing
  expect((await paste(f.ports, `${f.back}/oauth/callback?login_option=google&code=synthetic-code&state=${f.state}`)).status).toBe(404)
  expect(seen.social).toHaveLength(1)
})

test("Builder ID: Kiro's page's address gives AWS's page as the next, and AWS's address signs in", async () => {
  const seen = kiro()
  const f = await start()
  const portal = `${f.back}/signin/callback?login_option=builderid&issuer_url=${encodeURIComponent("https://view.awsapps.com/start")}&idc_region=us-east-1&state=${f.state}`
  const one = await paste(f.ports, portal)
  expect(one.status).toBe(302)
  const next = new URL(one.next)
  expect(next.origin + next.pathname).toBe("https://oidc.us-east-1.amazonaws.com/authorize")
  expect(next.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${f.ports[0]}/oauth/callback`)
  expect(next.searchParams.get("client_id")).toBe("synthetic-client")
  expect(next.searchParams.get("code_challenge_method")).toBe("S256")
  const awsState = next.searchParams.get("state")
  expect(awsState).not.toBe(f.state)
  expect(seen.register).toEqual([{ host: "oidc.us-east-1.amazonaws.com", body: expect.objectContaining({ issuerUrl: "https://view.awsapps.com/start" }) }])
  await settle()
  expect(f.result).toBeNull() // one stage isn't the sign-in

  // Kiro's page's address again: the same AWS page, no second client
  expect(await paste(f.ports, portal)).toEqual({ status: 302, next: one.next })
  expect(seen.register).toHaveLength(1)
  // a code with Kiro's page's state, or on the other path, isn't AWS's
  expect((await paste(f.ports, `http://127.0.0.1:${f.ports[0]}/oauth/callback?code=aws-code&state=${f.state}`)).status).toBe(404)
  expect((await paste(f.ports, `http://127.0.0.1:${f.ports[0]}/signin/callback?code=aws-code&state=${awsState}`)).status).toBe(404)
  expect(seen.token).toHaveLength(0)

  const two = await paste(f.ports, `http://127.0.0.1:${f.ports[0]}/oauth/callback?code=aws-code&state=${awsState}`)
  expect(two).toEqual({ status: 200, next: "" })
  await f.done
  expect(seen.token).toHaveLength(1)
  expect(seen.token[0].body).toMatchObject({ clientId: "synthetic-client", clientSecret: "synthetic-secret", grantType: "authorization_code",
    code: "aws-code", redirectUri: `http://127.0.0.1:${f.ports[0]}/oauth/callback` })
  expect(sha(seen.token[0].body.codeVerifier)).toBe(next.searchParams.get("code_challenge"))
  expect(f.result).toMatchObject({ type: "success", accountId: EMAIL + " (Builder ID)", uid: "builderid", method: "idc",
    loginProvider: "BuilderId", region: "us-east-1", clientId: "synthetic-client" })
  // AWS's address again, once it is over: a 404, no second trade
  expect((await paste(f.ports, `http://127.0.0.1:${f.ports[0]}/oauth/callback?code=aws-code&state=${awsState}`)).status).toBe(404)
  expect(seen.token).toHaveLength(1)
  expect(seen.other).toEqual([])
})

test("Identity Center in its own region signs in at that region's AWS", async () => {
  const seen = kiro()
  const f = await start()
  const one = await paste(f.ports, `${f.back}/signin/callback?login_option=awsidc&issuer_url=${encodeURIComponent("https://example-co.awsapps.com/start")}&idc_region=eu-west-1&state=${f.state}`)
  expect(new URL(one.next).host).toBe("oidc.eu-west-1.amazonaws.com")
  const awsState = new URL(one.next).searchParams.get("state")
  await paste(f.ports, `http://127.0.0.1:${f.ports[0]}/oauth/callback?code=aws-code&state=${awsState}`)
  await f.done
  expect(seen.register[0].host).toBe("oidc.eu-west-1.amazonaws.com")
  expect(seen.token[0].host).toBe("oidc.eu-west-1.amazonaws.com")
  expect(f.result).toMatchObject({ type: "success", accountId: EMAIL + " (IAM Identity Center)", uid: "enterprise", region: "eu-west-1" })
})

test("an address that isn't this sign-in's is a 404 and ends nothing, an error included", async () => {
  const seen = kiro()
  const f = await start()
  for (const wrong of [
    `${f.back}/oauth/callback?login_option=google&code=c&state=another`, // a stale tab, another sign-in's
    `${f.back}/oauth/callback?login_option=google&code=c`,
    `${f.back}/oauth/callback?error=access_denied`, // a page sending a request here
    `${f.back}/oauth/callback?error=access_denied&state=another`,
  ]) expect((await paste(f.ports, wrong)).status).toBe(404)
  expect((await paste(f.ports, `${f.back}/elsewhere?state=${f.state}`)).status).toBe(404)
  await settle()
  expect(f.result).toBeNull()
  expect(seen.social).toHaveLength(0)
  // and the right one still signs in
  expect((await paste(f.ports, `${f.back}/oauth/callback?login_option=github&code=c&state=${f.state}`)).status).toBe(200)
  await f.done
  expect(f.result).toMatchObject({ type: "success", accountId: EMAIL + " (GitHub)" })
})

test("a new sign-in ends the one left behind and frees its port", async () => {
  kiro()
  const old = await start()
  const f = await start()
  await old.done
  expect(old.result).toEqual({ type: "failed", error: "another sign-in to Kiro was started" })
  // its port answers nothing now; the new one's is this sign-in's
  expect(await real(`http://127.0.0.1:${old.ports[0]}/oauth/callback`).then(() => "answered", () => "closed")).toBe(old.ports[0] === f.ports[0] ? "answered" : "closed")
  expect((await paste(f.ports, `${f.back}/oauth/callback?login_option=google&code=c&state=${old.state}`)).status).toBe(404)
  await paste(f.ports, `${f.back}/oauth/callback?login_option=google&code=c&state=${f.state}`)
  await f.done
  expect(f.result).toMatchObject({ type: "success" })
})

test("an error with this sign-in's state ends it, at either stage", async () => {
  kiro()
  let f = await start()
  await paste(f.ports, `${f.back}/oauth/callback?error=access_denied&error_description=${encodeURIComponent("The user said no")}&state=${f.state}`)
  await f.done
  expect(f.result).toEqual({ type: "failed", error: "The user said no" })

  f = await start()
  const one = await paste(f.ports, `${f.back}/signin/callback?login_option=builderid&issuer_url=${encodeURIComponent("https://view.awsapps.com/start")}&idc_region=us-east-1&state=${f.state}`)
  const awsState = new URL(one.next).searchParams.get("state")
  expect((await paste(f.ports, `http://127.0.0.1:${f.ports[0]}/oauth/callback?error=access_denied&state=${awsState}`)).status).toBe(200)
  await f.done
  expect(f.result).toEqual({ type: "failed", error: "access_denied" })
})

test("Kiro's page's region and AWS sign-in are taken only in their own shape", async () => {
  for (const [region, issuer, says] of [
    ["evil.example.com/x?", "https://view.awsapps.com/start", "region"],
    ["us-east-1.evil", "https://view.awsapps.com/start", "region"],
    ["us-east-1", "http://view.awsapps.com/start", "https"],
    ["us-east-1", "https://user:pass@view.awsapps.com/start", "https"],
  ]) {
    const seen = kiro()
    const f = await start()
    const r = await paste(f.ports, `${f.back}/signin/callback?login_option=builderid&issuer_url=${encodeURIComponent(issuer)}&idc_region=${encodeURIComponent(region)}&state=${f.state}`)
    expect(r).toEqual({ status: 200, next: "" })
    await f.done
    expect(f.result.type).toBe("failed")
    expect(f.result.error).toContain(says)
    expect(seen.register).toHaveLength(0)
    expect(seen.other).toEqual([])
  }
})

test("a code missing is said, and nothing is sent", async () => {
  const seen = kiro()
  const f = await start()
  await paste(f.ports, `${f.back}/oauth/callback?login_option=google&state=${f.state}`)
  await f.done
  expect(f.result).toEqual({ type: "failed", error: "Kiro's page sent back no code" })
  expect(seen.social).toHaveLength(0)
})

test("going back to Kiro's page and choosing another way takes that way, and AWS's first page no more", async () => {
  const seen = kiro()
  const f = await start()
  const one = await paste(f.ports, `${f.back}/signin/callback?login_option=builderid&issuer_url=${encodeURIComponent("https://view.awsapps.com/start")}&idc_region=us-east-1&state=${f.state}`)
  const firstAWS = new URL(one.next).searchParams.get("state")
  // Back, then Identity Center with the company's start URL: a client for that one
  const two = await paste(f.ports, `${f.back}/signin/callback?login_option=awsidc&issuer_url=${encodeURIComponent("https://example-co.awsapps.com/start")}&idc_region=eu-west-1&state=${f.state}`)
  expect(new URL(two.next).host).toBe("oidc.eu-west-1.amazonaws.com")
  expect(seen.register.map((r) => r.host)).toEqual(["oidc.us-east-1.amazonaws.com", "oidc.eu-west-1.amazonaws.com"])
  expect((await paste(f.ports, `http://127.0.0.1:${f.ports[0]}/oauth/callback?code=aws-code&state=${firstAWS}`)).status).toBe(404)
  // Back again, then Google: that signs in
  expect((await paste(f.ports, `${f.back}/oauth/callback?login_option=google&code=synthetic-code&state=${f.state}`)).status).toBe(200)
  await f.done
  expect(f.result).toMatchObject({ type: "success", accountId: EMAIL + " (Google)", uid: "google" })
  expect(seen.token).toHaveLength(0)
})

test("a sign-in ended while AWS is asked for a client sends the browser nowhere", async () => {
  kiro({ registerWait: 100 })
  const old = await start()
  const pending = paste(old.ports, `${old.back}/signin/callback?login_option=builderid&issuer_url=${encodeURIComponent("https://view.awsapps.com/start")}&idc_region=us-east-1&state=${old.state}`)
  await settle()
  const f = await start() // a new sign-in ends it
  expect((await pending).status).toBe(404)
  await old.done
  expect(old.result).toEqual({ type: "failed", error: "another sign-in to Kiro was started" })
  await settle() // the new one is waiting still
  expect(f.result).toBeNull()
})

test("an error while AWS's code is traded doesn't end the sign-in", async () => {
  kiro({ tokenWait: 100 })
  const f = await start()
  const one = await paste(f.ports, `${f.back}/signin/callback?login_option=builderid&issuer_url=${encodeURIComponent("https://view.awsapps.com/start")}&idc_region=us-east-1&state=${f.state}`)
  const awsState = new URL(one.next).searchParams.get("state")
  const trade = paste(f.ports, `http://127.0.0.1:${f.ports[0]}/oauth/callback?code=aws-code&state=${awsState}`)
  await settle()
  expect((await paste(f.ports, `http://127.0.0.1:${f.ports[0]}/oauth/callback?error=access_denied&state=${awsState}`)).status).toBe(409)
  expect((await trade).status).toBe(200)
  await f.done
  expect(f.result).toMatchObject({ type: "success", accountId: EMAIL + " (Builder ID)" })
})

test("AWS's address pasted twice at once trades its code once", async () => {
  const seen = kiro({ tokenWait: 100 })
  const f = await start()
  const one = await paste(f.ports, `${f.back}/signin/callback?login_option=builderid&issuer_url=${encodeURIComponent("https://view.awsapps.com/start")}&idc_region=us-east-1&state=${f.state}`)
  const back = `http://127.0.0.1:${f.ports[0]}/oauth/callback?code=aws-code&state=${new URL(one.next).searchParams.get("state")}`
  const [a, b] = await Promise.all([paste(f.ports, back), (async () => { await settle(); return paste(f.ports, back) })()])
  await f.done
  expect([a.status, b.status].sort()).toEqual([200, 409])
  expect(seen.token).toHaveLength(1)
  expect(f.result).toMatchObject({ type: "success", accountId: EMAIL + " (Builder ID)" })
})


test("selecting Builder ID opens AWS directly and completes with one pasted callback", async () => {
  const seen = kiro()
  const method = (await plugin({})).auth.methods[0]
  expect(method.prompts[0].options.some((o) => o.value === "builderid")).toBe(true)
  const a = await method.authorize({ loginMethod: "builderid" })
  const page = new URL(a.url)
  expect(page.origin + page.pathname).toBe("https://oidc.us-east-1.amazonaws.com/authorize")
  const back = page.searchParams.get("redirect_uri")
  expect(seen.register).toHaveLength(1)
  expect(seen.register[0].body.issuerUrl).toBe("https://view.awsapps.com/start")
  expect((await paste(loopbackPorts(a.url), `${back}?state=wrong&code=synthetic-code`)).status).toBe(404)
  expect(seen.token).toHaveLength(0)
  expect((await paste(loopbackPorts(a.url), `${back}?state=${page.searchParams.get("state")}&code=synthetic-code`)).status).toBe(200)
  expect(await a.callback()).toMatchObject({ type: "success", loginProvider: "BuilderId", method: "idc", uid: "builderid" })
  expect(seen.token).toHaveLength(1)
  expect(sha(seen.token[0].body.codeVerifier)).toBe(page.searchParams.get("code_challenge"))
  expect(seen.social).toHaveLength(0)
})


test("organization selection registers its Start URL and region and completes one callback", async () => {
  const seen = kiro()
  const method = (await plugin({})).auth.methods[0]
  const a = await method.authorize({ loginMethod: "enterprise", startUrl: "https://d-example.awsapps.com/start", region: "eu-west-1" })
  const page = new URL(a.url)
  expect(page.host).toBe("oidc.eu-west-1.amazonaws.com")
  expect(seen.register[0].body.issuerUrl).toBe("https://d-example.awsapps.com/start")
  await paste(loopbackPorts(a.url), `${page.searchParams.get("redirect_uri")}?state=${page.searchParams.get("state")}&code=synthetic-code`)
  expect(await a.callback()).toMatchObject({ type: "success", loginProvider: "Enterprise", uid: "enterprise", region: "eu-west-1" })
})

test("invalid organization inputs are rejected before registering an AWS client", async () => {
  const seen = kiro()
  const method = (await plugin({})).auth.methods[0]
  await expect(method.authorize({ loginMethod: "enterprise", startUrl: "http://example.com/start" })).rejects.toThrow("HTTPS")
  await expect(method.authorize({ loginMethod: "enterprise", startUrl: "https://example.com/start", region: "bad/host" })).rejects.toThrow("region")
  expect(seen.register).toHaveLength(0)
})
