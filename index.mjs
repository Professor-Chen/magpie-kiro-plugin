// Kiro's subscriptions (kiro.dev) as an OpenCode provider plugin.
//
// An account is signed in the way the Kiro IDE signs in: Kiro's sign-in
// page (app.kiro.dev) offers Google, GitHub, AWS Builder ID and IAM
// Identity Center, and sends the browser back to one of the ports the IDE
// listens on. Google and GitHub come back with a code Kiro's auth service
// trades for tokens; Builder ID and Identity Center come back with where to
// sign in at AWS, which is then done with a client registered for it.
// kiro-cli's or the IDE's own sign-in can be used instead: it is read where
// they keep it each time, refreshed by kiro-cli first, and a token
// refreshed here is written back, so they go on with it. A Kiro API key
// (ksk_…) signs in too.
//
// Kiro has no API OpenCode speaks: the models are declared on Anthropic's
// Messages, and the fetch here sends each request whole to Kiro's own API
// (runtime.<region>.kiro.dev/generateAssistantResponse, the one kiro-cli
// talks to) as a conversation, and turns the AWS event stream it answers
// with back into Messages' events.
import { createServer } from "node:http"
import { gunzipSync } from "node:zlib"
import { createDecipheriv, createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { readFile, rename, writeFile } from "node:fs/promises"
import { homedir, hostname, release } from "node:os"
import { delimiter, join } from "node:path"

// kiro-custom, not kiro: magpie's built-in Kiro and the community plugin
// @magpie-community/opencode-kiro-auth both sign in as kiro. This plugin
// is a separate provider, so installing it neither replaces them nor
// shares their sign-in.
const ID = "kiro-custom"
const MESSAGES = "@ai-sdk/anthropic"
const BASE = "https://runtime.us-east-1.kiro.dev" // what OpenCode is given; the fetch sends each request to the account's region

const PORTAL = "https://app.kiro.dev"
const AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev"
const oidc = (region) => `https://oidc.${region}.amazonaws.com`
const runtime = (region) => `https://runtime.${region}.kiro.dev`
const management = (region) => `https://management.${region}.kiro.dev`
const refreshURL = (region) => `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`
// the ports Kiro's sign-in page sends the browser back to, the IDE's
const CALLBACK_PORTS = [3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153]
// import.html, where 选择文件… chooses an export (pageSignIn); importPage
// (KIRO_IMPORT_PAGE) puts a copy of it elsewhere
const IMPORT_PAGE = "https://professor-chen.github.io/magpie-kiro-plugin/import.html"
const IMPORT_MAX = 4 << 20 // the accounts' text, unpacked
// the relay the page hands an import to when it can't reach the plugin
const IMPORT_RELAY = "https://ntfy.sh"
// what the IDE asks AWS for
const SCOPES = ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations",
  "codewhisperer:transformations", "codewhisperer:taskassist"]
// how the IDE names itself to Kiro's auth service, and when refreshing
const IDE_UA = "KiroIDE-1.1.70-" + createHash("sha256").update("magpie:" + hostname()).digest("hex")
const DESKTOP_UA = "Kiro-Desktop/0.2.13 (darwin; arm64)"
// refreshUA is who refreshes a sign-in with Google or GitHub: the IDE of
// the fingerprint the account's requests carry, or Kiro Desktop's, as before
const refreshUA = (c) => (cfg.fingerprint === "cli" ? DESKTOP_UA : `KiroIDE-${cfg.kiroVersion}-${machineIdOf(c)}`)
const SIGN_IN_TIMEOUT = 10 * 60 * 1000

// ---- settings ------------------------------------------------------------------------

// The plugin's settings, from its entry's options in magpie's plugins.json
// ({"spec": "…", "options": {"cacheRatio": 0.8}}) or OpenCode's
// ["…", {options}], else KIRO_* environment variables. web and dropHidden
// are also switches in the provider's editor (auth.options, read on the
// next request):
//   - cacheRatio (KIRO_CACHE_RATIO, 0–1): the share of the prompt reported as
//     read from the cache when Kiro reports none, as a relay's billing and
//     Claude Code's display read it; 0, the default, reports none
//   - fingerprint (KIRO_FINGERPRINT): "ide" (the default) calls as the Kiro
//     IDE does (aws-sdk-js, KiroIDE-<version>-<machineId>), "cli" as kiro-cli
//   - kiroVersion (KIRO_VERSION), nodeVersion (KIRO_NODE_VERSION),
//     systemVersion (KIRO_SYSTEM_VERSION): what the IDE fingerprint says
//   - endpoint (KIRO_ENDPOINT): "kiro" (runtime.<region>.kiro.dev, the
//     default) or "q" (q.<region>.amazonaws.com)
//   - retries (KIRO_RETRIES, 0–5): how often a request a network error, a
//     5xx or a throttle turned away is tried again; 2 by default
//   - thinkingMin / thinkingMax (KIRO_THINKING_MIN / _MAX): the bounds of
//     a thinking budget, 1024 and 64000 by default
//   - budgets (KIRO_BUDGETS, "low=10000,medium=20000,…"): each effort's
//     budget, over the defaults below
//   - adaptive (KIRO_ADAPTIVE): a caller's {thinking: {type: "adaptive"}}
//     goes to Kiro as kiro-cli's adaptive mode (an effort, not a length);
//     off by default: Kiro answered it without thinking (a live check of
//     claude-sonnet-4.5, which thinks when given a length), so adaptive
//     goes as a length, the effort's budget
//   - effortField (KIRO_EFFORT_FIELD): "auto" (the default) asks the
//     Claudes that think natively on Kiro (Opus and Sonnet 4.7 and later)
//     by their own fields, additionalModelRequestFields' thinking
//     {type: "adaptive"} and output_config.effort, rather than the prompt's
//     tags they don't heed; "off" asks every model by the prompt
//   - minInterval (KIRO_MIN_INTERVAL_MS): the least time between two
//     requests of one account, 0 (none) by default
//   - toolDescriptionLimit (KIRO_TOOL_DESCRIPTION_LIMIT): a tool's
//     description is cut at this, 9216 by default (Kiro refuses longer)
//   - meter (KIRO_METER): "on" (the default) reads the cache tokens, and
//     a native thinker's unshown reasoning, from what Kiro metered (meter());
//     "off" leaves them to cacheRatio
//   - web (KIRO_WEB): each message says it comes from Kiro Web (KIRO_WEB)
//     rather than kiro-cli (KIRO_CLI), and Kiro puts a shorter prompt of
//     its own before it (HIDDEN: 740 tokens rather than 4052 for Sonnet
//     4.5); off by default
//   - dropHidden (KIRO_DROP_HIDDEN): the prompt's tokens are told without
//     Kiro's own prompt (HIDDEN), the cache's share of them first; off by
//     default, the prompt told as Kiro counted it. An estimate of the
//     caller's own request, Kiro having told no size, is left as it is
const DEFAULTS = { cacheRatio: 0, fingerprint: "ide", kiroVersion: "0.9.2", nodeVersion: "22.21.1", systemVersion: "",
  endpoint: "kiro", retries: 2, thinkingMin: 1024, thinkingMax: 64000, budgets: "", adaptive: false, effortField: "auto",
  minInterval: 0, toolDescriptionLimit: 9216, meter: "on", web: false, dropHidden: false, importPage: "", importRelay: "" }
const cfg = { ...DEFAULTS }
// BUDGETS are each effort's thinking budget (xhigh its own level: #120)
const BASE_BUDGETS = { low: 10000, medium: 20000, high: 30000, xhigh: 50000, max: 64000 }
const BUDGETS = { ...BASE_BUDGETS }

const clamp = (x, lo, hi, d) => (Number.isFinite(Number(x)) && String(x).trim() !== "" ? Math.min(hi, Math.max(lo, Number(x))) : d)
const bool = (x, d) => (typeof x === "boolean" ? x : /^(1|true|on|yes)$/i.test(String(x)) ? true : /^(0|false|off|no)$/i.test(String(x)) ? false : d)
function configure(o = {}) {
  const e = (k) => process.env[k] ?? ""
  const pick = (k, envKey) => (o?.[k] !== undefined && o[k] !== null && o[k] !== "" ? o[k] : e(envKey) || DEFAULTS[k])
  cfg.cacheRatio = clamp(pick("cacheRatio", "KIRO_CACHE_RATIO"), 0, 1, 0)
  cfg.fingerprint = String(pick("fingerprint", "KIRO_FINGERPRINT")).toLowerCase() === "cli" ? "cli" : "ide"
  cfg.kiroVersion = String(pick("kiroVersion", "KIRO_VERSION"))
  cfg.nodeVersion = String(pick("nodeVersion", "KIRO_NODE_VERSION"))
  cfg.systemVersion = String(pick("systemVersion", "KIRO_SYSTEM_VERSION") || systemVersion())
  cfg.endpoint = String(pick("endpoint", "KIRO_ENDPOINT")).toLowerCase() === "q" ? "q" : "kiro"
  cfg.retries = Math.trunc(clamp(pick("retries", "KIRO_RETRIES"), 0, 5, 2))
  cfg.thinkingMin = Math.trunc(clamp(pick("thinkingMin", "KIRO_THINKING_MIN"), 0, 200000, DEFAULTS.thinkingMin))
  cfg.thinkingMax = Math.max(cfg.thinkingMin, Math.trunc(clamp(pick("thinkingMax", "KIRO_THINKING_MAX"), 1024, 200000, DEFAULTS.thinkingMax)))
  cfg.adaptive = bool(pick("adaptive", "KIRO_ADAPTIVE"), false)
  cfg.effortField = String(pick("effortField", "KIRO_EFFORT_FIELD")).toLowerCase() === "off" ? "off" : "auto"
  cfg.minInterval = Math.trunc(clamp(pick("minInterval", "KIRO_MIN_INTERVAL_MS"), 0, 60000, 0))
  cfg.toolDescriptionLimit = Math.trunc(clamp(pick("toolDescriptionLimit", "KIRO_TOOL_DESCRIPTION_LIMIT"), 256, 100000, 9216))
  cfg.meter = String(pick("meter", "KIRO_METER")).toLowerCase() === "off" ? "off" : "on"
  cfg.web = bool(pick("web", "KIRO_WEB"), false)
  cfg.dropHidden = bool(pick("dropHidden", "KIRO_DROP_HIDDEN"), false)
  const ip = String(pick("importPage", "KIRO_IMPORT_PAGE"))
  cfg.importPage = /^https?:\/\//i.test(ip) ? ip : IMPORT_PAGE
  // where the import page hands the accounts over when its browser can't
  // reach the plugin's port: an ntfy server, or "off"
  const relay = String(pick("importRelay", "KIRO_IMPORT_RELAY")).trim().replace(/\/+$/, "")
  cfg.importRelay = /^off$/i.test(relay) ? "" : /^https?:\/\//i.test(relay) ? relay : IMPORT_RELAY
  Object.assign(BUDGETS, BASE_BUDGETS)
  const b = pick("budgets", "KIRO_BUDGETS")
  const pairs = b && typeof b === "object" ? Object.entries(b) : String(b ?? "").split(",").map((s) => s.split("="))
  for (const [k, v] of pairs) {
    const key = String(k ?? "").trim().toLowerCase()
    if (key in BASE_BUDGETS && Number(v) > 0) BUDGETS[key] = Math.trunc(Number(v))
  }
  return cfg
}

// systemVersion is the OS the IDE fingerprint names, as Node's does it:
// darwin#24.6.0, win32#10.0.22631, linux#6.8.0.
function systemVersion() {
  try {
    return `${process.platform}#${release()}`
  } catch {
    return "darwin#24.6.0"
  }
}
configure()
// A Builder ID sign-in has no profile of its own, and Kiro won't list one
// for it (List-Available-Profiles is a 403, "AWS Builder ID is not supported
// for this operation"); the Kiro IDE and kiro-cli name this service profile
// for it instead, so its models, usage and chat are asked with it too.
const BUILDER_ID_START = "https://view.awsapps.com/start"
const BUILDER_ID_PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"
const isBuilderID = (provider) => String(provider ?? "").toLowerCase() === "builderid"

const env = (k) => process.env[k] ?? ""
const home = () => env("HOME") || homedir()

// ---- where Kiro's own apps keep their sign-in -----------------------------------

function cliDB() {
  if (process.platform === "win32") return join(env("APPDATA") || join(home(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3")
  if (process.platform === "darwin") return join(home(), "Library", "Application Support", "kiro-cli", "data.sqlite3")
  return join(home(), ".local", "share", "kiro-cli", "data.sqlite3")
}
const ideDir = () => join(home(), ".aws", "sso", "cache")

// kiroExecutable finds kiro-cli, which refreshes its own sign-in.
function kiroExecutable() {
  for (const d of env("PATH").split(delimiter)) {
    const p = join(d, process.platform === "win32" ? "kiro-cli.exe" : "kiro-cli")
    if (d && isFile(p)) return p
  }
  for (const p of [join(home(), ".local", "bin", "kiro-cli"), "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli",
    "/usr/local/bin/kiro-cli", "/opt/homebrew/bin/kiro-cli"])
    if (isFile(p)) return p
  return ""
}
function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// openDB opens kiro-cli's SQLite database, with Bun's driver or Node's.
async function openDB(path, readonly) {
  try {
    const { Database } = await import("bun:sqlite")
    return new Database(path, readonly ? { readonly: true } : { readwrite: true })
  } catch (e) {
    if (typeof Bun !== "undefined") throw e
  }
  const { DatabaseSync } = await import("node:sqlite")
  return new DatabaseSync(path, { readOnly: readonly })
}

const time = (s) => {
  const t = Date.parse(s ?? "")
  return Number.isFinite(t) ? t : 0
}

// readCLI reads kiro-cli's sign-in: with Google or GitHub, with AWS (Builder
// ID, IAM Identity Center), or with a company's own identity provider.
async function readCLI() {
  const path = cliDB()
  if (!existsSync(path)) return null
  let db
  try {
    db = await openDB(path, true)
    const get = (key) => {
      const row = db.prepare("SELECT value FROM auth_kv WHERE key = ?").get(key)
      if (!row?.value) return null
      try {
        return JSON.parse(row.value)
      } catch {
        return null
      }
    }
    for (const kind of ["social", "odic", "external-idp"]) {
      const key = `kirocli:${kind}:token`
      const m = get(key)
      if (!m?.access_token) continue
      const c = { access: m.access_token, refresh: m.refresh_token ?? "", expires: time(m.expires_at), region: m.region || "us-east-1",
        profile: m.profile_arn ?? "", dbKey: key }
      if (kind === "social") c.method = "social"
      else if (kind === "odic") {
        c.method = "idc"
        // as kiro-cli tells them apart: Builder ID's start URL, or none
        c.builderID = !m.start_url || m.start_url === BUILDER_ID_START
        const reg = get("kirocli:odic:device-registration")
        if (reg) [c.clientId, c.clientSecret] = [reg.client_id ?? "", reg.client_secret ?? ""]
      } else {
        c.method = "external-idp"
        c.clientId = m.client_id ?? ""
        c.tokenURL = m.token_endpoint || (m.issuer_url ? m.issuer_url.replace(/\/$/, "") + "/v1/token" : "")
      }
      return c
    }
  } catch {
  } finally {
    db?.close()
  }
  return null
}

// readIDE reads the Kiro IDE's sign-in.
async function readIDE() {
  const path = join(ideDir(), "kiro-auth-token.json")
  let t
  try {
    t = JSON.parse(await readFile(path, "utf8"))
  } catch {
    return null
  }
  if (!t?.accessToken) return null
  const c = { access: t.accessToken, refresh: t.refreshToken ?? "", expires: time(t.expiresAt), region: t.region || "us-east-1",
    profile: t.profileArn ?? "", method: "idc", idePath: path, builderID: isBuilderID(t.provider) }
  if (t.clientIdHash) {
    try {
      const reg = JSON.parse(await readFile(join(ideDir(), t.clientIdHash + ".json"), "utf8"))
      ;[c.clientId, c.clientSecret] = [reg.clientId ?? "", reg.clientSecret ?? ""]
    } catch {}
  }
  if (String(t.authMethod).toLowerCase() === "social" || !c.clientId) c.method = "social"
  return c
}

// saveBack writes a refreshed token back where it was read from, so
// kiro-cli or the IDE goes on with it (a refresh may replace the refresh
// token).
async function saveBack(c) {
  const expires = new Date(c.expires).toISOString()
  if (c.dbKey) {
    let db
    try {
      db = await openDB(cliDB(), false)
      db.exec("PRAGMA busy_timeout = 3000")
      const row = db.prepare("SELECT value FROM auth_kv WHERE key = ?").get(c.dbKey)
      if (!row?.value) return
      const m = JSON.parse(row.value)
      Object.assign(m, { access_token: c.access, refresh_token: c.refresh, expires_at: expires })
      if (c.profile && c.method === "social") m.profile_arn = c.profile
      db.prepare("UPDATE auth_kv SET value = ? WHERE key = ?").run(JSON.stringify(m), c.dbKey)
    } catch {
    } finally {
      db?.close()
    }
  } else if (c.idePath) {
    try {
      const m = JSON.parse(await readFile(c.idePath, "utf8"))
      Object.assign(m, { accessToken: c.access, refreshToken: c.refresh, expiresAt: expires })
      await writeFile(c.idePath + ".magpie-tmp", JSON.stringify(m, null, 2), { mode: 0o600 })
      await rename(c.idePath + ".magpie-tmp", c.idePath)
    } catch {}
  }
}

// ---- tokens --------------------------------------------------------------------

// EXPIRED is the built-in's words for a sign-in Kiro refused, or one with
// nothing to refresh it.
const EXPIRED = "Kiro's sign-in has expired; sign in again"
const EXPIRED_CLI = EXPIRED + " with `kiro-cli login` or the Kiro IDE"

// gone is an error saying the sign-in itself is gone — refused, or never
// there. The built-in marked no Kiro account lapsed, not even then, nor
// cleared one: every answer and usage read says the account is kept.
const gone = (msg) => Object.assign(new Error(msg), { gone: true })
const EARLY_MS = 2 * 60 * 1000 // a token this close to its end is refreshed before a request
const LEAD_MS = 10 * 60 * 1000 // and this close, magpie renews it ahead of time (auth.refresh)
const fresh = (c, early = EARLY_MS) => c.method === "apikey" || !c.expires || c.expires - Date.now() > early

async function post(url, contentType, body, headers = {}) {
  let res
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": contentType, Accept: "application/json", ...headers }, body,
      signal: AbortSignal.timeout(30_000) })
  } catch (e) {
    throw new Error("refreshing Kiro's sign-in: " + e.message)
  }
  const text = await res.text()
  if (!res.ok) {
    if ([400, 401, 403].includes(res.status)) throw gone(EXPIRED_CLI)
    throw new Error(`refreshing Kiro's sign-in: ${res.status} ${STATUS_TEXT[res.status] ?? ""}`.trimEnd()) // Go's res.Status
  }
  return JSON.parse(text)
}

// refresh refreshes a sign-in's token the way its owner would: kiro-cli's
// by kiro-cli first.
async function refresh(c) {
  if (c.dbKey) {
    const bin = kiroExecutable()
    if (bin) {
      await new Promise((r) => execFile(bin, ["debug", "refresh-auth-token"], { timeout: 20_000 }, () => r()))
      const n = await readCLI()
      if (n && n.dbKey === c.dbKey && n.access !== c.access && fresh(n)) return n
    }
  }
  if (!c.refresh) throw gone(EXPIRED_CLI)
  let out
  switch (c.method) {
    case "social": {
      const r = await post(refreshURL(c.region), "application/json", JSON.stringify({ refreshToken: c.refresh }), { "User-Agent": refreshUA(c) })
      out = { access: r.accessToken, refresh: r.refreshToken, expiresIn: r.expiresIn }
      if (r.profileArn) c.profile = r.profileArn
      break
    }
    case "idc": {
      const r = await post(oidc(c.region) + "/token", "application/json",
        JSON.stringify({ clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: c.refresh, grantType: "refresh_token" }))
      out = { access: r.accessToken, refresh: r.refreshToken, expiresIn: r.expiresIn }
      break
    }
    case "external-idp": {
      if (!c.tokenURL) throw gone(EXPIRED + " with `kiro-cli login`")
      const form = new URLSearchParams({ grant_type: "refresh_token", client_id: c.clientId ?? "", refresh_token: c.refresh })
      const r = await post(c.tokenURL, "application/x-www-form-urlencoded", form.toString())
      out = { access: r.access_token, refresh: r.refresh_token, expiresIn: r.expires_in }
      break
    }
    default:
      throw gone("Kiro's sign-in has expired")
  }
  if (!out.access) throw gone(EXPIRED_CLI)
  const n = { ...c, access: out.access, expires: Date.now() + (out.expiresIn > 0 ? out.expiresIn : 3600) * 1000 }
  if (out.refresh) n.refresh = out.refresh
  await saveBack(n)
  return n
}

// headers say who is calling: the token, and what kind it is.
function authHeaders(a) {
  const h = { Authorization: `Bearer ${a.token}` }
  if (a.tokenType) h.tokentype = a.tokenType
  return h
}
const tokenType = (c) => (c.method === "apikey" ? "API_KEY" : c.method === "external-idp" ? "EXTERNAL_IDP" : "")

// region is where the account's API is: the region its profile is in, else
// the nearer of Kiro's two to where it signed in.
function regionOf(profile, signedIn) {
  const parts = String(profile ?? "").split(":")
  if (parts.length > 4 && parts[3]) return parts[3]
  return String(signedIn ?? "").startsWith("eu-") ? "eu-central-1" : "us-east-1"
}

// STATUS_TEXT is Go's http.StatusText for the answers Kiro gives.
const STATUS_TEXT = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 408: "Request Timeout",
  409: "Conflict", 413: "Request Entity Too Large", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout" }

class KiroError extends Error {
  constructor(status, body) {
    let msg = ""
    try {
      msg = JSON.parse(body)?.message ?? ""
    } catch {}
    super(msg ? `Kiro: ${msg} (${status})` : `Kiro: ${STATUS_TEXT[status] ?? ""}`)
    this.status = status
    this.body = String(body ?? "")
  }
}

// managementCall calls Kiro's management API: GET with a query, or POST
// with a JSON body.
async function managementCall(region, a, method, query, body) {
  let url = `${management(region)}/${method}`
  if (!body && query) url += "?" + new URLSearchParams(query)
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { ...authHeaders(a), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) throw new KiroError(res.status, text)
  return JSON.parse(text)
}

// profileOf finds the profile a sign-in that doesn't name one uses: an API
// key's own, Builder ID's, or the first Kiro lists in either of its regions.
async function profileOf(c) {
  if (c.method === "apikey") {
    const res = await fetch(management("us-east-1") + "/", {
      method: "POST",
      headers: { ...authHeaders({ token: c.access, tokenType: "API_KEY" }), "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonCodeWhispererService.GetProfile" },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      const msg = `Kiro didn't take the API key: ${res.status} ${STATUS_TEXT[res.status] ?? ""}`.trimEnd()
      throw res.status === 401 || res.status === 403 ? gone(msg) : new Error(msg)
    }
    const arn = (await res.json().catch(() => null))?.profile?.arn
    if (!arn) throw new Error("Kiro didn't say which profile the API key is for")
    return arn
  }
  if (c.builderID) return BUILDER_ID_PROFILE
  let last
  for (const region of ["us-east-1", "eu-central-1"]) {
    try {
      const out = await managementCall(region, { token: c.access, tokenType: tokenType(c) }, "List-Available-Profiles", null, {})
      const arn = (out?.profiles ?? []).find((p) => p?.arn)?.arn
      if (arn) return arn
    } catch (e) {
      // a Builder ID sign-in the token didn't say was one
      if (c.method === "idc" && e?.status === 403 && e.body.includes("Builder ID")) return BUILDER_ID_PROFILE
      last = e
    }
  }
  throw last ?? new Error("Kiro has no profile for this sign-in")
}

// usageLimits is Get-Usage-Limits: the plan, the account's email, credits.
function usageLimits(a, email) {
  return managementCall(a.region, a, "Get-Usage-Limits",
    { origin: "KIRO_CLI", profileArn: a.profile, resourceType: "CREDIT", isEmailRequired: String(email) })
}

// planName is the subscription's name as Kiro gives it ("KIRO FREE"), said
// "Kiro Free".
const planName = (title) =>
  String(title ?? "").toLowerCase().split(/\s+/).filter(Boolean).map((w) => (w === "kiro" ? "Kiro" : w[0].toUpperCase() + w.slice(1))).join(" ")

// goG is Go's %g of x: an exponent from a million up.
function goG(x) {
  const [m, e] = x.toExponential().split("e")
  const exp = Number(e)
  if (exp < -4 || exp >= 6) return `${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`
  return String(x)
}

// usageOf is the allowance Get-Usage-Limits tells, as magpie's built-in
// said it: the account's email, the credits of each allowance, the month's and a free trial's
// while it runs.
function usageOf(l) {
  const at = (secs) => (secs > 0 ? new Date(Math.trunc(secs) * 1000).toISOString() : undefined)
  const count = (used, limit) => used.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") + " / " + goG(limit)
  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0)
  const windows = []
  for (const u of l?.usageBreakdownList ?? []) {
    const t = u?.freeTrialInfo
    if (t && String(t.freeTrialStatus ?? "").toUpperCase() === "ACTIVE" && num(t.usageLimitWithPrecision) > 0) {
      const used = num(t.currentUsageWithPrecision), limit = num(t.usageLimitWithPrecision)
      windows.push({ name: "Free trial", used: (100 * used) / limit, resetsAt: at(num(t.freeTrialExpiry)), display: count(used, limit) })
    }
    const used = num(u?.currentUsageWithPrecision), limit = num(u?.usageLimitWithPrecision)
    if (limit <= 0) continue
    const reset = num(u?.nextDateReset) || num(l?.nextDateReset)
    windows.push({ name: u?.displayNamePlural || u?.displayName || "Credits", used: (100 * used) / limit, resetsAt: at(reset),
      display: count(used, limit), span: 30 * 24 * 3600 })
  }
  const email = l?.userInfo?.email
  return { plan: planName(l?.subscriptionInfo?.subscriptionTitle), ...(typeof email === "string" && email ? { user: email } : {}), windows }
}

// ---- the account, as the plugin holds it -------------------------------------------

// credOf is the sign-in a stored auth names: a key, one signed in here, or
// kiro-cli's or the IDE's, read where they keep it now.
async function credOf(auth) {
  if (auth?.type === "api" && auth.key) return { access: auth.key, method: "apikey", region: "us-east-1" }
  if (auth?.type !== "oauth") return null
  if (auth.source === "kiro-cli") return readCLI()
  if (auth.source === "kiro-ide") return readIDE()
  if (auth.source === "kiro") return (await readCLI()) ?? (await readIDE())
  if (!auth.access && !auth.refresh) return null
  return { access: auth.access ?? "", refresh: auth.refresh ?? "", expires: auth.access ? auth.expires ?? 0 : 1, method: auth.method || "social",
    region: auth.region || "us-east-1", profile: auth.profileArn ?? "", clientId: auth.clientId ?? "", clientSecret: auth.clientSecret ?? "",
    builderID: isBuilderID(auth.loginProvider), machineId: auth.machineId ?? "", seed: auth.accountId ?? "", own: true }
}

// ---- machine id ------------------------------------------------------------------------

// machineIdOf is the 64-hex id the IDE fingerprint carries: the account's
// own (64 hex, or a UUID doubled, as kiro.rs takes one), else a hash of the
// key, or of what names the account (its refresh token as kiro.rs hashes
// it, when nothing else does), the same across restarts and refreshes.
function machineIdOf(c) {
  const own = normalizeMachineId(c?.machineId)
  if (own) return own
  if (c?.method === "apikey" && c.access) return sha256Hex("KiroAPIKey/" + c.access)
  if (c?.seed) return sha256Hex("KotlinNativeAPI/" + c.seed)
  if (c?.refresh) return sha256Hex("KotlinNativeAPI/" + c.refresh)
  return sha256Hex("KiroFallback/magpie:" + hostname())
}
const sha256Hex = (s) => createHash("sha256").update(s).digest("hex")
function normalizeMachineId(id) {
  const s = String(id ?? "").trim().toLowerCase()
  if (/^[0-9a-f]{64}$/.test(s)) return s
  const u = s.replaceAll("-", "")
  if (/^[0-9a-f]{32}$/.test(u) && s.length === 36) return u + u
  return ""
}

// ---- importing an exported account -----------------------------------------------------

// importedAccounts reads the accounts in an export, whichever tool made it:
//   - Kiro Account Manager: {version, exportedAt, accounts: [{email, credentials: {…}, machineId, status}]}
//   - Cockpit: {version: "cockpit-kiro-import", accounts: [{email, auth: {…}, machineId, status}]}
//   - kiro.rs's credentials.json: one object or an array of them, the
//     credentials at the top (expiresAt RFC3339)
//   - the Kiro IDE's kiro-auth-token.json, with its client's clientId and
//     clientSecret beside it
// Each comes out as the oauth sign-in the plugin keeps ({access, refresh,
// expires, method, region, …}); an account not active, or with no refresh
// token, is left out with why. Nothing but the sign-in is kept: an export's
// passwords and notes are not.
function importedAccounts(text) {
  let data
  try {
    data = typeof text === "string" ? JSON.parse(text) : text
  } catch (e) {
    throw new Error("that isn't JSON: " + e.message)
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.accounts) ? data.accounts : data && typeof data === "object" ? [data] : []
  const out = []
  const skipped = []
  for (const [i, a] of list.entries()) {
    if (!a || typeof a !== "object") continue
    const c = a.credentials && typeof a.credentials === "object" ? a.credentials : a.auth && typeof a.auth === "object" ? a.auth : a
    const name = String(a.email || a.nickname || c.email || a.id || `account ${i + 1}`)
    const status = String(a.status ?? "active").toLowerCase()
    if (a.disabled === true || !["active", "normal", "ok", ""].includes(status)) {
      skipped.push(`${name}: ${status || "disabled"}`)
      continue
    }
    const refresh = String(c.refreshToken ?? c.refresh_token ?? c.refresh ?? "")
    const access = String(c.accessToken ?? c.access_token ?? c.access ?? "")
    if (!refresh) {
      skipped.push(`${name}: no refresh token`)
      continue
    }
    const raw = String(c.authMethod ?? c.auth_method ?? c.method ?? "").toLowerCase()
    const clientId = String(c.clientId ?? c.client_id ?? "")
    const clientSecret = String(c.clientSecret ?? c.client_secret ?? "")
    const idc = ["idc", "builder-id", "builderid", "iam", "iam_identity_center"].includes(raw) || (!raw && clientId && clientSecret)
    if (idc && !(clientId && clientSecret)) {
      skipped.push(`${name}: an Identity Center sign-in without its clientId and clientSecret`)
      continue
    }
    const loginProvider = String(c.provider ?? a.idp ?? c.loginProvider ?? "")
    out.push({
      user: name,
      auth: {
        access,
        refresh,
        expires: expiresOf(c.expiresAt ?? c.expires_at ?? c.expires),
        method: idc ? "idc" : "social",
        region: String(c.region || c.authRegion || "us-east-1"),
        ...(c.profileArn || a.profileArn ? { profileArn: String(c.profileArn || a.profileArn) } : {}),
        ...(idc ? { clientId, clientSecret } : {}),
        ...(loginProvider ? { loginProvider } : {}),
        ...(normalizeMachineId(a.machineId ?? c.machineId) ? { machineId: normalizeMachineId(a.machineId ?? c.machineId) } : {}),
        accountId: name,
      },
    })
  }
  return { accounts: out, skipped }
}

// expiresOf is an export's expiry as milliseconds: milliseconds, seconds
// or a date; 0 (refreshed before its first use) when it says none.
function expiresOf(x) {
  if (typeof x === "number" && Number.isFinite(x) && x > 0) return x < 1e12 ? x * 1000 : x
  if (typeof x === "string" && x.trim()) {
    if (/^\d+$/.test(x.trim())) return expiresOf(Number(x.trim()))
    const t = Date.parse(x)
    if (Number.isFinite(t)) return t
  }
  return 0
}

// Account holds the credentials in use, refreshing them when near their
// end or when Kiro turned one down; one refresh at a time, as a refresh
// may replace the refresh token.
//
// after is what each refresh gave, by the access token it replaced: a
// sign-in read with that token (its save failed, or magpie hasn't yet
// saved what auth.refresh gave) goes on with the newer one rather than
// spending the replaced refresh token again.
function account(client) {
  let held = null // { id, c }
  const after = new Map()
  const newest = (c) => {
    for (let i = 0; i < 16 && after.has(c.access); i++) c = { ...after.get(c.access) }
    return c
  }
  const renewed = (c, n) => {
    after.set(c.access, n)
    if (after.size > 16) after.delete(after.keys().next().value)
    return n
  }
  let lock = Promise.resolve()
  const locked = (fn) => {
    const run = lock.then(fn, fn)
    lock = run.catch(() => {})
    return run
  }
  const save = async (auth, c) => {
    if (!c.own || !client?.auth?.set) return
    const { type: _t, ...rest } = auth
    await client.auth.set({ path: { id: ID }, body: { ...rest, type: "oauth", access: c.access, refresh: c.refresh, expires: c.expires,
      profileArn: c.profile, region: c.region } }).catch(() => {})
  }
  const creds = (auth, stale = false) =>
    locked(async () => {
      const id = auth?.type === "api" ? "key:" + auth.key : "oauth:" + (auth?.source ?? "own")
      // what its owner holds now: it may have refreshed it, signed out, or
      // signed in to another account since
      let read = await credOf(auth)
      if (!read) {
        held = null
        throw gone(
          auth?.source
            ? "Kiro isn't signed in; add the Kiro subscription in magpie, sign in with `kiro-cli login` or the Kiro IDE, or save a Kiro API key on the provider"
            : "this Kiro account's sign-in is gone; add it again in magpie",
        )
      }
      read = newest(read)
      let c = held?.id === id ? held.c : null
      if (!c || read.access !== c.access || !fresh(c) || stale) {
        if (!read.profile && c && read.access === c.access) read.profile = c.profile
        if (stale && c && read.access !== c.access && fresh(read)) stale = false // the owner refreshed it already
        c = read
        if (!fresh(c) || stale) {
          if (c.method === "apikey") throw gone("Kiro turned down the API key saved on the provider")
          c = renewed(c, await refresh(c))
          await save(auth, c)
        }
      }
      if (!c.profile) {
        c.profile = await profileOf(c)
        if (!auth?.profileArn) await save(auth, c)
      }
      held = { id, c }
      return { token: c.access, tokenType: tokenType(c), profile: c.profile, region: regionOf(c.profile, c.region), machineId: machineIdOf(c) }
    })
  // renew is auth.refresh's: a sign-in kept here (not kiro-cli's or the
  // IDE's, which their owners keep) renewed under the same lock as the
  // requests' refresh, so the two never spend one refresh token. It saves
  // nothing — magpie saves what it gives — and gives only what changed.
  creds.renew = (auth) =>
    locked(async () => {
      const read = await credOf(auth)
      if (!read?.own || !read.refresh) return undefined
      let c = newest(read)
      // renewed here already (a request's refresh, or this hook's whose
      // result magpie hasn't saved yet), the store not yet saying so
      if (c.access === read.access || !fresh(c, LEAD_MS)) c = renewed(c, await refresh(c))
      held = { id: "oauth:own", c }
      const out = { access: c.access, expires: c.expires }
      if (c.refresh !== auth.refresh) out.refresh = c.refresh
      if (c.profile && c.profile !== auth.profileArn) out.profileArn = c.profile
      return out
    })
  return creds
}

// ---- models ----------------------------------------------------------------------

const windows = new Map() // a model's context, as Kiro last listed it

const thinks = (id) => /claude/i.test(id) || id === "auto"
// the levels a thinking model offers: BUDGETS, each its own (xhigh as its
// own level: #120)
const variants = () => Object.fromEntries(EFFORTS.map((k) => [k, { thinking: { type: "enabled", budgetTokens: BUDGETS[k] } }]))

function configModel(m) {
  return {
    name: m.name,
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    ...(m.images ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    ...(thinks(m.id)
      ? { reasoning: true, variants: variants() }
      : {}),
    tool_call: true,
  }
}

function runtimeModel(m) {
  const input = { text: true, image: !!m.images, audio: false, video: false, pdf: false }
  return {
    id: m.id,
    providerID: ID,
    name: m.name ?? m.id,
    api: { id: m.id, url: BASE, npm: MESSAGES },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: thinks(m.id),
      attachment: !!m.images,
      toolcall: true,
      input,
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: thinks(m.id) ? variants() : {},
  }
}

// Kiro's own list is asked for once signed in; until then, Auto, which
// picks a model for each request.
const MODELS = [{ id: "auto", name: "Auto" }]

// listModels is List-Available-Models, the default first.
async function listModels(a) {
  const out = await managementCall(a.region, a, "List-Available-Models", { origin: "KIRO_CLI", profileArn: a.profile })
  const list = []
  for (const m of out?.models ?? []) {
    if (!m?.modelId) continue
    let name = m.modelName
    if (!name || name === m.modelId) name = m.modelId === "auto" ? "Auto" : m.modelId
    const model = { id: m.modelId, name, context: m.tokenLimits?.maxInputTokens ?? 0, output: m.tokenLimits?.maxOutputTokens ?? 0,
      images: (m.supportedInputTypes ?? []).some((t) => String(t).toUpperCase() === "IMAGE") }
    if (m.modelId === out?.defaultModel?.modelId) list.unshift(model)
    else list.push(model)
  }
  if (!list.length) throw new Error("Kiro listed no models")
  for (const m of list) windows.set(m.id, m.context)
  return list
}

// ---- the request: Messages → a Kiro conversation ---------------------------------------

const PROCEED = "Please proceed with the task." // Kiro takes no empty message
const NO_RESULT = "Tool use was interrupted and did not produce a result."
const RESULT_LIMIT = 250000 // a tool's output is cut at this, as Kiro's own agent cuts it
const TOOL_ID = /^[a-zA-Z0-9_.:-]{1,64}$/

// toolID is a tool call's id as Kiro takes one: another vendor's becomes
// one of Kiro's own, the same each time.
const toolID = (id) => (TOOL_ID.test(id ?? "") ? id : "t_" + createHash("sha256").update(String(id ?? "")).digest("base64url").slice(0, 32))

// Kiro answers a tool named past 64 characters, or outside these, "Invalid
// tool use format." and won't raise the limit (kirodotdev/Kiro#7684), while
// MCP tools in Claude Code are named mcp__plugin_<plugin>_<server>__<tool>
// (yetone/magpie#1393).
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

// toolName is a tool's name as Kiro takes one: another is its head with a
// hash of the whole name, the same each time, so the conversation's later
// turns name it the same way. toolNames maps each such name back.
const toolName = (name) => {
  const n = String(name ?? "")
  if (TOOL_NAME.test(n)) return n
  const hash = createHash("sha256").update(n).digest("hex").slice(0, 12)
  return n.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64 - 1 - hash.length) + "_" + hash
}

// toolNames is the name the caller knows for each tool a request names
// that Kiro is sent under another name.
function toolNames(req) {
  const names = new Map()
  const add = (n) => {
    if (typeof n !== "string" || !n) return
    const k = toolName(n)
    if (k !== n) names.set(k, n)
  }
  for (const t of req.tools ?? []) add(t?.name)
  for (const m of req.messages ?? []) if (Array.isArray(m.content)) for (const p of m.content) if (p?.type === "tool_use") add(p.name)
  return names
}

function imageFormat(mediaType) {
  const t = String(mediaType ?? "").toLowerCase()
  const f = t.replace(/^image\//, "")
  if (f === "jpg") return "jpeg"
  if (!f || f === t) return "png"
  return f
}

// addImage puts an Anthropic image block in images as Kiro takes it: the
// bytes inline. One named only by a URL has no bytes to send and is left out.
function addImage(images, p) {
  if (p.source?.type === "base64" && p.source.data) images.push({ format: imageFormat(p.source.media_type), source: { bytes: p.source.data } })
}

const textOf = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n\n") : ""
const joinNonEmpty = (a, b) => (a && b ? a + "\n\n" + b : a + b)

function documentText(p) {
  const title = p.title ? `${p.title}\n` : ""
  if (p.source?.type === "text") return title + (p.source.data ?? "")
  if (p.source?.type === "content") return title + textOf(p.source.content)
  return `${title}[a ${p.source?.media_type ?? "document"} attachment]`
}

// thinking is how the model is asked to think aloud, when the caller asked
// for it, of a Claude model (or Auto): { budget, effort, adaptive, native },
// or null. The budget is the caller's budget_tokens, else its effort's
// (BUDGETS), within thinkingMin–thinkingMax; adaptive is a caller asking
// {type: "adaptive"}, said to Kiro as an effort rather than a length;
// native, a model that thinks by its own fields (effortField), told no
// tags in the prompt.
function thinking(req, model) {
  const effort = String(req.output_config?.effort ?? req.reasoning_effort ?? "").toLowerCase().trim()
  const type = req.thinking?.type
  if (type === "disabled") return null
  const on = type === "enabled" || type === "adaptive" || (effort && effort !== "low" && effort !== "none")
  if (!on || !thinks(String(model).toLowerCase())) return null
  let budget = BUDGETS[effort] ?? 0
  if (!budget && req.thinking?.budget_tokens > 0) budget = Math.floor(req.thinking.budget_tokens)
  if (!budget) budget = BUDGETS.medium
  budget = Math.min(cfg.thinkingMax, Math.max(cfg.thinkingMin, budget))
  const native = cfg.effortField !== "off" && nativeThinker(model)
  return { budget, effort: EFFORTS.includes(effort) ? effort : "", adaptive: type === "adaptive" && cfg.adaptive, native }
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

// thinkingPrefix is how kiro-cli asks a model to think, in the prompt: a
// length, or (adaptive) an effort Kiro reads as low, medium or high. A
// native thinker is told nothing there (effortField says it).
function thinkingPrefix(t) {
  if (!t || t.native) return ""
  if (t.adaptive) {
    const e = t.effort === "low" || t.effort === "medium" ? t.effort : "high"
    return `<thinking_mode>adaptive</thinking_mode><thinking_effort>${e}</thinking_effort>`
  }
  return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${t.budget}</max_thinking_length>`
}

// effortField is the thinking said as the model's own fields
// (additionalModelRequestFields), for the Claudes that think natively on
// Kiro: Opus and Sonnet 4.7 and later. As live checks on Kiro showed, they
// think adaptively, the reasoning streamed as reasoningContentEvent,
// whatever the prompt says (the prompt's tags do nothing for them), and
// output_config.effort sets how much (on one hard question: low 47
// reasoning frames, max 218); thinking.type takes "adaptive" alone (an
// "enabled" is a 400). 4.6 and 4.5 think only as the prompt's tags ask,
// and 4.5 and Haiku turn the field away (400 "additionalModelRequestFields
// is not supported for this model"). effortField: "auto" (the default)
// sends it to the native thinkers, "off" never.
const NATIVE_THINKER = /claude-(opus|sonnet)-(5\.5|5-5|5|4\.8|4-8|4\.7|4-7)(\b|$|[.-])/
const nativeThinker = (model) => NATIVE_THINKER.test(String(model).toLowerCase().replace(/^.*:/, ""))
function effortField(req, model, t) {
  if (cfg.effortField === "off" || !nativeThinker(model)) return undefined
  let e = String(req.output_config?.effort ?? req.reasoning_effort ?? "").toLowerCase().trim()
  if (!EFFORTS.includes(e)) e = ""
  // thinking off: the least of it, as the model thinks however it's asked
  if (!t) return e ? { output_config: { effort: e } } : req.thinking?.type === "disabled" ? { output_config: { effort: "low" } } : undefined
  return { thinking: { type: "adaptive" }, output_config: { effort: e || t.effort || effortOfBudget(t.budget) } }
}

// effortOfBudget is the effort a thinking budget comes nearest, for a
// caller that named a length (budget_tokens) and no effort.
function effortOfBudget(budget) {
  let best = "medium"
  for (const k of EFFORTS) if (budget >= BUDGETS[k]) best = k
  return best
}

// originOf is who each message says sent it: kiro-cli, or Kiro Web (web).
const originOf = () => (cfg.web ? "KIRO_WEB" : "KIRO_CLI")

// buildKiro is the body of a generateAssistantResponse call. think is
// thinking()'s (a number, the budget alone, is taken too).
function buildKiro(req, model, profile, think) {
  if (typeof think === "number") think = think > 0 ? { budget: think, effort: "", adaptive: false } : null
  const entries = []
  // the messages the caller marked for its prompt cache (cache_control),
  // which go to Kiro as a cachePoint on the message they end up in (#110)
  const marked = new WeakSet()
  const mark = (msg, parts) => {
    if (parts.some((p) => p?.cache_control)) marked.add(msg)
  }
  const user = () => ({ content: "", modelId: model, origin: originOf() })
  for (const m of req.messages ?? []) {
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? []
    const texts = []
    if (m.role === "assistant") {
      const a = { content: "", toolUses: [] }
      // what the model thought, sent back as it said it, so a thinking
      // conversation goes on from its own reasoning (as kiro-cli keeps it);
      // a native thinker's reasoning was its own event, not the reply's
      // words, and goes back as nothing (it thinks anew each turn)
      let thought = ""
      for (const p of parts) {
        if (p?.type === "text" && p.text) texts.push(p.text)
        else if (p?.type === "thinking" && think && !think.native && typeof p.thinking === "string") thought += p.thinking
        else if (p?.type === "tool_use") {
          const input = p.input && typeof p.input === "object" && !Array.isArray(p.input) ? p.input : {}
          a.toolUses.push({ name: toolName(p.name), toolUseId: toolID(p.id), input })
        }
      }
      a.content = texts.join("\n\n")
      if (thought.trim()) a.content = OPEN + thought + CLOSE + (a.content ? "\n\n" + a.content : "")
      if (!a.content && !a.toolUses.length) continue // a turn that only thought
      const prev = entries.at(-1)?.assistantResponseMessage
      if (prev) {
        prev.content = joinNonEmpty(prev.content, a.content)
        prev.toolUses.push(...a.toolUses)
      } else entries.push({ assistantResponseMessage: a })
      mark(prev ?? a, parts)
      continue
    }
    const u = user()
    u.images = []
    const results = []
    for (const p of parts) {
      if (p?.type === "text") {
        if (p.text) texts.push(p.text)
      } else if (p?.type === "document") texts.push(documentText(p))
      else if (p?.type === "image") addImage(u.images, p)
      else if (p?.type === "tool_result") {
        let out = textOf(p.content)
        if (out.length > RESULT_LIMIT) out = out.slice(0, RESULT_LIMIT) + "\n… (cut)"
        results.push({ toolUseId: toolID(p.tool_use_id), status: p.is_error ? "error" : "success", content: [{ text: out || "(no output)" }] })
        // a tool's images (a screenshot, Codex's view_image) go with the
        // message, as Kiro's tool results carry text alone (magpie #369, #1861)
        if (Array.isArray(p.content)) for (const c of p.content) if (c?.type === "image") addImage(u.images, c)
      }
    }
    u.content = texts.join("\n\n")
    if (results.length) u.userInputMessageContext = { toolResults: results }
    const prev = entries.at(-1)?.userInputMessage
    if (prev) {
      prev.content = joinNonEmpty(prev.content, u.content)
      prev.images.push(...u.images)
      if (results.length) (prev.userInputMessageContext ??= { toolResults: [] }).toolResults.push(...results)
    } else entries.push({ userInputMessage: u })
    mark(prev ?? u, parts)
  }
  // the conversation opens with something the user said: tool results with
  // no call before them go, and a reply the caller began with
  while (entries.length) {
    const u = entries[0].userInputMessage
    if (u) {
      if (u.userInputMessageContext && !u.content && !u.images.length) {
        entries.shift()
        continue
      }
      delete u.userInputMessageContext
      break
    }
    entries.shift()
  }
  // and ends with it, the message being answered
  if (!entries.at(-1)?.userInputMessage) entries.push({ userInputMessage: { ...user(), images: [] } })
  // each call is answered in the message after it, and only calls are
  entries.forEach((e, i) => {
    const u = e.userInputMessage
    if (!u) return
    const calls = entries[i - 1]?.assistantResponseMessage?.toolUses ?? []
    const results = u.userInputMessageContext?.toolResults ?? []
    const answered = new Set()
    const kept = []
    for (const r of results)
      if (!answered.has(r.toolUseId) && calls.some((c) => c.toolUseId === r.toolUseId)) {
        answered.add(r.toolUseId)
        kept.push(r)
      }
    for (const c of calls)
      if (!answered.has(c.toolUseId)) {
        answered.add(c.toolUseId)
        kept.push({ toolUseId: c.toolUseId, status: "error", content: [{ text: NO_RESULT }] })
      }
    delete u.userInputMessageContext
    if (kept.length) u.userInputMessageContext = { toolResults: kept }
    if (!u.content && !u.userInputMessageContext) u.content = PROCEED
  })
  // only the latest images are sent again, as Kiro's own agent does
  let latest = -1
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i].userInputMessage?.images.length) {
      latest = i
      break
    }
  entries.forEach((e, i) => {
    const u = e.userInputMessage
    if (u && (i !== latest || !u.images.length)) delete u.images
  })
  for (const e of entries) if (e.assistantResponseMessage && !e.assistantResponseMessage.toolUses.length) delete e.assistantResponseMessage.toolUses
  // the instructions go at the head of the first message
  let system = typeof req.system === "string" ? req.system : textOf(req.system)
  const prefix = thinkingPrefix(think)
  if (prefix && !/<thinking_mode>/.test(system)) system = prefix + (system ? "\n" + system : "")
  if (system) entries[0].userInputMessage.content = system + "\n\n" + entries[0].userInputMessage.content
  if (Array.isArray(req.system)) mark(entries[0].userInputMessage, req.system)

  // the caller's tools, and any the conversation used that it no longer
  // offers — Kiro rejects a history naming a tool it wasn't given
  const current = entries.at(-1).userInputMessage
  const tools = []
  const offered = new Set()
  const EMPTY = { type: "object", properties: {} }
  for (const t of req.tools ?? []) {
    if (!t?.name || (t.type && t.type !== "custom" && !t.input_schema)) continue // server tools Kiro hasn't
    const name = toolName(t.name)
    offered.add(name)
    // Kiro refuses a request whose tool says too much (an MCP server's
    // long manual): the head of it goes
    let description = String(t.description || t.name)
    if (description.length > cfg.toolDescriptionLimit) description = description.slice(0, cfg.toolDescriptionLimit - 16) + "\n… (cut)"
    tools.push({ toolSpecification: { name, description, inputSchema: { json: t.input_schema ?? EMPTY } } })
    if (t.cache_control) tools.push({ cachePoint: { type: "default" } })
  }
  for (const e of entries)
    for (const c of e.assistantResponseMessage?.toolUses ?? [])
      if (!offered.has(c.name)) {
        offered.add(c.name)
        tools.push({ toolSpecification: { name: c.name, description: "Tool", inputSchema: { json: EMPTY } } })
      }
  if (tools.length) (current.userInputMessageContext ??= {}).tools = tools
  // Kiro's cachePoint is Bedrock's: it caches the prompt up to the point,
  // and a request may hold 4 at most, as Anthropic's cache_control; past
  // that the last ones are kept, the most of the prompt they cover
  const points = []
  for (const t of tools) if (t.cachePoint) points.push(() => tools.splice(tools.indexOf(t), 1))
  for (const e of entries) {
    const msg = e.userInputMessage ?? e.assistantResponseMessage
    if (marked.has(msg)) {
      msg.cachePoint = { type: "default" }
      points.push(() => delete msg.cachePoint)
    }
  }
  for (const drop of points.slice(0, Math.max(0, points.length - 4))) drop()

  const state = { chatTriggerType: "MANUAL", agentTaskType: "vibe", conversationId: randomUUID(), currentMessage: { userInputMessage: current } }
  if (entries.length > 1) state.history = entries.slice(0, -1)
  const out = { conversationState: state, agentMode: "vibe" }
  const extra = effortField(req, model, think)
  if (extra) out.additionalModelRequestFields = extra
  if (profile) out.profileArn = profile
  return JSON.stringify(out)
}

// kiroHeaders are the headers a generateAssistantResponse call says who
// is calling with: the Kiro IDE's (aws-sdk-js, KiroIDE-<version>-<machine
// id>, as kiro.rs sends them), or kiro-cli's (aws-sdk-rust).
function kiroHeaders(a, attempt = 1, max = 1) {
  let ua, xua
  if (cfg.fingerprint === "cli") {
    ua = xua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${randomUUID().replaceAll("-", "")}`
  } else {
    const id = a.machineId || machineIdOf(null)
    xua = `aws-sdk-js/1.0.34 KiroIDE-${cfg.kiroVersion}-${id}`
    ua = `aws-sdk-js/1.0.34 ua/2.1 os/${cfg.systemVersion} lang/js md/nodejs#${cfg.nodeVersion} api/codewhispererstreaming#1.0.34 m/E KiroIDE-${cfg.kiroVersion}-${id}`
  }
  return {
    ...authHeaders(a),
    "Content-Type": "application/json",
    Accept: "application/vnd.amazon.eventstream",
    "x-amzn-codewhisperer-optout": "true",
    "amz-sdk-invocation-id": randomUUID(),
    "amz-sdk-request": `attempt=${attempt}; max=${max}`,
    "x-amzn-kiro-agent-mode": "vibe",
    "x-amz-user-agent": xua,
    "User-Agent": ua,
  }
}

// chatURL is where the account's conversation goes: Kiro's runtime, or
// the Q endpoint the IDE also speaks.
const chatURL = (region) => (cfg.endpoint === "q" ? `https://q.${region}.amazonaws.com` : runtime(region)) + "/generateAssistantResponse"

function sendKiro(a, body, signal, attempt = 1, max = 1) {
  return fetch(chatURL(a.region), { method: "POST", headers: kiroHeaders(a, attempt, max), body, signal })
}

// retryable is whether an answer is worth asking again: a throttle or a
// failure on Kiro's side, never one about the request or the account.
const retryable = (status) => status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
// backoff is how long to wait before try n (1-based): 0.5s, 1s, 2s…, with
// jitter, or what Retry-After says (at most 10s).
function backoff(n, res) {
  const after = Number(res?.headers?.get?.("retry-after"))
  if (Number.isFinite(after) && after > 0) return Math.min(10_000, after * 1000)
  return Math.min(8000, 500 * 2 ** (n - 1)) * (0.75 + Math.random() * 0.5)
}
const sleep = (ms, signal) =>
  new Promise((ok, no) => {
    if (signal?.aborted) return no(signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }))
    const t = setTimeout(ok, ms)
    signal?.addEventListener?.("abort", () => {
      clearTimeout(t)
      no(signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }))
    }, { once: true })
  })

// failure is the status and message for an error Kiro answered with:
// {"message": "...", "reason": "..."}.
function failure(status, body) {
  let msg = String(body ?? "").trim()
  try {
    const e = JSON.parse(body)
    if (e?.message) msg = e.message + (e.reason ? ` (${e.reason})` : "")
  } catch {}
  msg ||= STATUS_TEXT[status] ?? ""
  if (msg.includes("CONTENT_LENGTH_EXCEEDS_THRESHOLD") || msg.toLowerCase().includes("input is too long"))
    return { status: 400, message: "input is too long for the model's context: " + msg }
  if (msg.includes("INSUFFICIENT_MODEL_CAPACITY")) return { status: 503, message: msg }
  if (msg.includes("MONTHLY_REQUEST_COUNT") || msg.includes("USAGE_LIMIT")) return { status: 429, message: "usage limit reached: " + msg }
  return { status, message: msg }
}

const ERROR_TYPES = { 400: "invalid_request_error", 401: "authentication_error", 402: "billing_error", 403: "permission_error",
  404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 503: "overloaded_error", 529: "overloaded_error" }
const errorType = (status) => ERROR_TYPES[status] ?? "api_error"
// Each failure says X-Magpie-Sign-In: kept, as the built-in never marked
// an account lapsed (see gone).
const errorResponse = (status, message) =>
  new Response(JSON.stringify({ type: "error", error: { type: errorType(status), message } }), {
    status,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "kept" },
  })

// kept is res saying the account is kept: a success too, which the
// built-in never took for a sign-in come back.
function kept(res) {
  if (res.headers.has("X-Magpie-Sign-In")) return res
  const headers = new Headers(res.headers)
  headers.set("X-Magpie-Sign-In", "kept")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

// ---- the reply: an AWS event stream → Messages ---------------------------------------

// frames reads an AWS event stream: each message its length, its headers'
// length and a checksum, the headers, the payload, a checksum of the whole.
async function* frames(body) {
  let buf = new Uint8Array(0)
  const reader = body.getReader()
  try {
    for (;;) {
      while (buf.length >= 12) {
        const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
        const total = v.getUint32(0)
        const hlen = v.getUint32(4)
        if (total < 16 || total > 16 << 20 || hlen > total - 16) throw new Error("a malformed event stream")
        if (buf.length < total) break
        const rest = buf.subarray(12, total)
        yield { headers: frameHeaders(rest.subarray(0, hlen)), payload: rest.subarray(hlen, rest.length - 4) }
        buf = buf.slice(total)
      }
      const { value, done } = await reader.read()
      if (done) {
        if (buf.length) throw new Error("unexpected EOF")
        return
      }
      const n = new Uint8Array(buf.length + value.length)
      n.set(buf)
      n.set(value, buf.length)
      buf = n
    }
  } finally {
    reader.releaseLock?.()
  }
}

function frameHeaders(h) {
  const out = {}
  const dec = new TextDecoder()
  const v = new DataView(h.buffer, h.byteOffset, h.byteLength)
  let i = 0
  while (i < h.length) {
    const n = h[i]
    if (h.length < i + 2 + n) break
    const name = dec.decode(h.subarray(i + 1, i + 1 + n))
    const type = h[i + 1 + n]
    i += 2 + n
    const size = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }[type]
    if (type === 6 || type === 7) {
      if (h.length < i + 2) break
      const l = v.getUint16(i)
      if (h.length < i + 2 + l) break
      if (type === 7) out[name] = dec.decode(h.subarray(i + 2, i + 2 + l))
      i += 2 + l
      continue
    }
    if (size === undefined || h.length < i + size) break
    i += size
  }
  return out
}

// exception is what an error in the stream says.
function exception(kind, payload) {
  let e = {}
  try {
    e = JSON.parse(new TextDecoder().decode(payload))
  } catch {}
  let msg = e.message || e.Message || new TextDecoder().decode(payload).trim()
  if (e.reason) msg += ` (${e.reason})`
  if (String(kind).toLowerCase().includes("throttl")) return "rate limited: " + msg
  return kind ? `${kind}: ${msg}` : msg
}

// ThinkParser splits a reply that opens with <thinking>…</thinking> into its
// thinking and the text after, however the tags fall across pieces.
const OPEN = "<thinking>"
const CLOSE = "</thinking>"
function partialSuffix(s, tag) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (s.endsWith(tag.slice(0, n))) return n
  return 0
}
class ThinkParser {
  state = 0 // 0: not yet known, 1: thinking, 2: text
  buf = ""
  said = false
  feed(s) {
    this.buf += s
    const out = []
    for (;;) {
      if (this.state === 0) {
        const t = this.buf.replace(/^[ \t\r\n]+/, "")
        if (t.startsWith(OPEN)) {
          ;[this.buf, this.state] = [t.slice(OPEN.length), 1]
          continue
        }
        if (t.length < OPEN.length && OPEN.startsWith(t)) return out // may yet be the tag
        this.state = 2
        continue
      }
      if (this.state === 1) {
        if (!this.said) {
          this.buf = this.buf.replace(/^[\r\n]+/, "")
          if (!this.buf) return out
        }
        const i = realClose(this.buf, false)
        if (i >= 0) {
          if (i > 0) {
            out.push({ kind: "think", text: this.buf.slice(0, i) })
            this.said = true
          }
          ;[this.buf, this.state] = [this.buf.slice(i + CLOSE.length).replace(/^[\r\n]+/, ""), 2]
          continue
        }
        // hold back what may be the start of the closing tag, or a closing
        // tag whose blank line after it hasn't come yet
        const held = heldBack(this.buf)
        const n = this.buf.length - held
        if (n > 0) {
          out.push({ kind: "think", text: this.buf.slice(0, n) })
          ;[this.buf, this.said] = [this.buf.slice(n), true]
        }
        return out
      }
      if (this.buf) out.push({ kind: "text", text: this.buf })
      this.buf = ""
      return out
    }
  }
  end() {
    if (!this.buf) return []
    const out = []
    if (this.state === 1) {
      // the reply ended: a closing tag with nothing but space after it ends
      // the thinking, the rest is text
      const i = realClose(this.buf, true)
      if (i >= 0) {
        if (i > 0) out.push({ kind: "think", text: this.buf.slice(0, i) })
        const rest = this.buf.slice(i + CLOSE.length).replace(/^[\r\n]+/, "")
        if (rest) out.push({ kind: "text", text: rest })
        this.buf = ""
        this.state = 2
        return out
      }
    }
    const ev = { kind: this.state === 1 ? "think" : "text", text: this.buf }
    this.buf = ""
    if (this.state === 0) this.state = 2
    return [ev]
  }
}

// realClose is where the thinking's own closing tag is in s, or -1: not one
// quoted (`</thinking>`, "</thinking>", as the model may write of it), and
// followed by a blank line — or, at the reply's end, by nothing but space.
function realClose(s, atEnd) {
  for (let i = s.indexOf(CLOSE); i >= 0; i = s.indexOf(CLOSE, i + 1)) {
    const before = s[i - 1]
    const after = s.slice(i + CLOSE.length)
    if (QUOTES.includes(before) || QUOTES.includes(after[0])) continue
    if (after.startsWith("\n\n") || after.startsWith("\r\n\r\n")) return i
    if (atEnd && !after.trim()) return i
  }
  return -1
}
const QUOTES = ['"', "'", "`"]

// heldBack is how much of s's end may yet be the thinking's closing tag:
// the start of the tag, or a whole one whose blank line hasn't come.
function heldBack(s) {
  for (let i = s.indexOf(CLOSE); i >= 0; i = s.indexOf(CLOSE, i + 1)) {
    const after = s.slice(i + CLOSE.length)
    if (QUOTES.includes(s[i - 1]) || QUOTES.includes(after[0])) continue
    if (["", "\n", "\r", "\r\n", "\r\n\r"].includes(after)) return s.length - i
  }
  return partialSuffix(s, CLOSE)
}

// TextCalls takes out of the text a tool call Kiro's model now and then
// says in words rather than as a toolUseEvent — "[Called Bash with args:
// {"command":"ls"}]" — and gives it as the call it is (AIClient-2-API does
// the same). Only a tool the request offered is taken; the text around it
// is said as it was. What may yet be the start of one is held back.
const CALLED = "[Called "
class TextCalls {
  buf = ""
  n = 0
  after = false // a call was just taken out: the line it ended goes too
  constructor(known) {
    this.known = known // the names the request offered (Kiro's), or null: any
  }
  feed(s) {
    this.buf += s
    if (this.after) {
      if (!this.buf) return []
      this.buf = this.buf.replace(/^[ \t]*\r?\n?/, "")
      this.after = false
    }
    const out = []
    for (;;) {
      const i = this.buf.indexOf(CALLED)
      if (i < 0) {
        // hold back what may be the start of "[Called "
        const keep = partialSuffix(this.buf, CALLED)
        const say = this.buf.slice(0, this.buf.length - keep)
        if (say) out.push({ kind: "text", text: say })
        this.buf = this.buf.slice(say.length)
        return out
      }
      const m = /^\[Called ([A-Za-z0-9_.:-]{1,64}) with args: /.exec(this.buf.slice(i))
      if (!m) {
        const head = this.buf.slice(i)
        // too short yet to tell
        if (head.length < 96 && /^\[Called [A-Za-z0-9_.:-]*( (w(i(t(h( (a(r(g(s(:)?)?)?)?)?)?)?)?)?)?)?$/.test(head)) {
          if (i) out.push({ kind: "text", text: this.buf.slice(0, i) })
          this.buf = head
          return out
        }
        out.push({ kind: "text", text: this.buf.slice(0, i + 1) })
        this.buf = this.buf.slice(i + 1)
        continue
      }
      const start = i + m[0].length
      const end = jsonEnd(this.buf, start)
      if (end === -2) {
        // not JSON after all: said as text
        out.push({ kind: "text", text: this.buf.slice(0, start) })
        this.buf = this.buf.slice(start)
        continue
      }
      if (end < 0 || end >= this.buf.length) {
        // the arguments haven't all come
        if (this.buf.length - i > 1 << 20) {
          out.push({ kind: "text", text: this.buf })
          this.buf = ""
          return out
        }
        if (i) out.push({ kind: "text", text: this.buf.slice(0, i) })
        this.buf = this.buf.slice(i)
        return out
      }
      if (this.buf[end] !== "]") {
        out.push({ kind: "text", text: this.buf.slice(0, start) })
        this.buf = this.buf.slice(start)
        continue
      }
      const name = m[1]
      let args
      try {
        args = JSON.parse(this.buf.slice(start, end))
      } catch {}
      if (!args || typeof args !== "object" || Array.isArray(args) || (this.known && !this.known.has(name))) {
        out.push({ kind: "text", text: this.buf.slice(0, end + 1) })
        this.buf = this.buf.slice(end + 1)
        continue
      }
      const before = this.buf.slice(0, i).replace(/[ \t]+$/, "")
      if (before.trim()) out.push({ kind: "text", text: before })
      const id = "tooluse_txt" + randomBytes(9).toString("base64url") + String(++this.n)
      out.push({ kind: "toolStart", id, name }, { kind: "toolArgs", text: JSON.stringify(args) })
      this.buf = this.buf.slice(end + 1)
      if (!this.buf) this.after = true
      else this.buf = this.buf.replace(/^[ \t]*\r?\n?/, "")
    }
  }
  end() {
    const s = this.buf
    this.buf = ""
    return s ? [{ kind: "text", text: s }] : []
  }
}

// jsonEnd is where the JSON object starting at s[i] ends (the index after
// its closing brace), -1 when it hasn't ended yet, -2 when it isn't one.
function jsonEnd(s, i) {
  if (s[i] !== "{") return i >= s.length ? -1 : -2
  let depth = 0
  let str = false
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (str) {
      if (c === "\\") j++
      else if (c === '"') str = false
    } else if (c === '"') str = true
    else if (c === "{" || c === "[") depth++
    else if (c === "}" || c === "]") {
      depth--
      if (depth === 0) return j + 1
    }
  }
  return -1
}

// events turns Kiro's reply into events: text, thinking, tool calls (the
// arguments in pieces), then the usage and why it stopped — or an error.
async function* events(body, model, budget, estimate = 0, known = null, req = null) {
  const think = new ThinkParser()
  const calls = new TextCalls(known)
  let tool = ""
  let tools = 0
  let stop = ""
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let kiroCounted = false // the prompt's size is Kiro's, its own prompt included
  let pct = 0
  let said = 0
  let failed = ""
  let any = false // whether Kiro said anything at all
  let credits = 0 // what Kiro metered the request (meteringEvent)
  let refusal = null // the model declined (metadataEvent.stopDetails.refusal)
  let spokenChars = 0 // the reply's text as told, its characters (learnFrom)
  let thought = false // whether the reply thought (then not learned from)
  const dec = new TextDecoder()
  // the text, its tool calls said in words taken out (TextCalls)
  function* spoken(evs) {
    for (const e of evs) {
      if (e.kind !== "text") {
        if (e.kind === "think") thought = true
        yield e
        continue
      }
      for (const x of calls.feed(e.text)) {
        if (x.kind === "toolStart") tools++
        else if (x.kind === "text") spokenChars += x.text.length
        yield x
      }
    }
  }
  try {
    for await (const f of frames(body)) {
      const type = f.headers[":message-type"]
      if (type === "exception" || type === "error") {
        failed = exception(f.headers[":exception-type"] || f.headers[":error-code"], f.payload)
        break
      }
      let m
      try {
        m = JSON.parse(dec.decode(f.payload))
      } catch {
        continue
      }
      const kind = f.headers[":event-type"]
      if (kind === "assistantResponseEvent") {
        const text = typeof m.content === "string" ? m.content : ""
        said += text.length
        if (text) any = true
        if (budget && !budget.native) yield* spoken(think.feed(text))
        else if (text) yield* spoken([{ kind: "text", text }])
      } else if (kind === "reasoningContentEvent") {
        // a native thinker thinks whether asked or not: a caller that asked
        // no thinking isn't shown it (as Anthropic shows none then)
        if (m.text) {
          said += m.text.length
          any = true
          thought = true
          if (budget) yield { kind: "think", text: m.text }
        } else if (m.signature && budget) yield { kind: "sig", text: m.signature }
      } else if (kind === "toolUseEvent") {
        any = true
        if (m.toolUseId && m.toolUseId !== tool) {
          yield* spoken(think.end()) // the text before a call is all said
          yield* spoken(calls.end())
          tool = m.toolUseId
          tools++
          yield { kind: "toolStart", id: m.toolUseId, name: m.name ?? "" }
        }
        if (m.input !== undefined && m.input !== null) {
          if (typeof m.input === "string") {
            if (m.input) yield { kind: "toolArgs", text: m.input }
            said += m.input.length
          } else {
            const s = JSON.stringify(m.input)
            if (s !== "{}") yield { kind: "toolArgs", text: s }
            said += s.length
          }
        }
      } else if (kind === "metadataEvent" || kind === "messageMetadataEvent") {
        if (m.stopReason) stop = m.stopReason
        const tu = m.tokenUsage
        if (tu && typeof tu === "object") {
          const inn = tu.uncachedInputTokens || tu.inputTokens || 0
          const cr = tu.cacheReadInputTokens || 0
          const cw = tu.cacheWriteInputTokens || 0
          usage.input += inn
          usage.output += tu.outputTokens || 0
          usage.cacheRead += cr
          usage.cacheWrite += cw
          if (inn || cr || cw) kiroCounted = true
          if (tu.contextUsagePercentage > 0) pct = tu.contextUsagePercentage
        }
      } else if (kind === "contextUsageEvent") {
        if (m.contextUsagePercentage > 0) pct = m.contextUsagePercentage
      } else if (kind === "meteringEvent") {
        // what the request cost the account, in credits: the one exact
        // figure Kiro gives of what it did (meter() reads the cache from it)
        if (typeof m.usage === "number" && Number.isFinite(m.usage)) credits += m.usage
      } else if (["error", "throttlingError", "validationError", "serviceUnavailableError", "internalServerException"].includes(kind)) {
        failed = exception(kind, f.payload)
        break
      }
      // the model declined (Kiro's safety filter: "BIO", …): an answer, not
      // a failure, as Anthropic's stop_reason "refusal" is
      if ((kind === "metadataEvent" || kind === "messageMetadataEvent") && m.stopDetails?.refusal) {
        refusal = m.stopDetails.refusal
        any = true
      }
    }
  } catch (e) {
    if (e?.name !== "AbortError") failed = "the reply broke off: " + e.message
  }
  yield* spoken(think.end())
  yield* spoken(calls.end())
  if (failed) {
    yield { kind: "error", text: failed }
    return
  }
  // refused before a word: a failure, its status a refusal's (refusedBefore),
  // for a relay to tell the caller and bill nothing, as Kiro meters nothing
  // for it (live: 0 credits where the same prompt answered cost 0.17)
  if (refusal && !said) {
    const why = String(refusal.explanation || "The model declined to answer.")
    yield { kind: "error", text: why + (refusal.category ? ` (${refusal.category})` : ""), refused: true }
    return
  }
  // a 200 that said nothing at all: a failure on Kiro's side, retryable
  if (!any) {
    yield { kind: "error", text: "Kiro's reply was empty", empty: true }
    return
  }
  const window = windows.get(model) ?? 0
  // Kiro says how full the context is rather than how many tokens; with
  // neither, the request's own size, estimated
  const exact = pct > 0 && window > 0 ? Math.floor((pct / 100) * window) : 0
  if (!usage.input && exact) {
    usage.input = exact
    kiroCounted = true
  }
  if (!usage.input && estimate > 0) usage.input = estimate
  // what the conversation's last reply came to, exact, from this prompt
  if (req && exact) learnFrom(req, model, exact)
  // the reply's tokens: Kiro tells none, so its characters over the model's
  // own (calibrated, then learned: charsOf)
  if (!usage.output) usage.output = Math.floor((said + 3) / charsOf(model))
  if (!(usage.cacheRead || usage.cacheWrite)) {
    if (!meter(usage, model, credits)) withCache(usage)
  }
  // Kiro's own prompt is in the size it counted; told without it when
  // asked (withoutHidden). The estimate above is the caller's request
  // alone, so it is left
  if (kiroCounted) withoutHidden(usage, model)
  // a plain reply (no call, no thought) is kept for the next turn to learn
  if (req && exact && !tools && !thought) remember(req, model, exact, spokenChars)
  let reason = "end_turn"
  if (tools > 0) reason = "tool_use"
  else if (/^max_tokens$/i.test(stop)) reason = "max_tokens"
  else if (refusal || /^content_filtered$/i.test(stop)) reason = "refusal"
  yield { kind: "stop", reason, usage }
}

// finished is the message's blocks with each call's arguments read.
function finished(content) {
  for (const b of content)
    if (b.type === "tool_use") {
      try {
        b.input = b.input ? JSON.parse(b.input) : {}
      } catch {
        b.input = {}
      }
    }
  return content
}

const anthropicUsage = (u) => ({
  input_tokens: u.input,
  output_tokens: u.output,
  cache_read_input_tokens: u.cacheRead,
  cache_creation_input_tokens: u.cacheWrite,
})

// withCache splits the prompt's tokens into those read from the cache and
// the rest, by cacheRatio, when Kiro reported no cache of its own and its
// metering couldn't be read (meter): the whole prompt is usage.input, and
// Anthropic's input_tokens doesn't count what the cache read.
function withCache(usage) {
  if (usage.cacheRead || usage.cacheWrite || !(cfg.cacheRatio > 0) || !(usage.input > 0)) return usage
  const read = Math.floor(usage.input * cfg.cacheRatio)
  usage.cacheRead = read
  usage.input -= read
  return usage
}

// PRICES are what Kiro meters a model, in credits a million tokens, as
// calibrated live (testenv/calib.mjs, 2026-10-16): fresh, the prompt not
// read from Kiro's cache; cached, read from it; output, a reply's. Kiro
// tells no token counts (kiro-cli's own client has none: "if only rts gave
// usage metrics…"), but it tells two exact figures — the prompt's size
// (contextUsagePercentage × the window) and what the request cost
// (meteringEvent) — and with the prices, the cache follows:
//   credits = fresh·(T − R) + cached·R + output·O
// for T the prompt, R what the cache read, O the reply. chars is the
// characters a reply token holds, as Kiro counted a story's (English): the
// newer tokenizer (4.7 and later) about 3.3, the older 4.5, GPT and the
// open models 4.5–5.2; learnChars refines it from each conversation.
//
// What the calibration found: Kiro meters a Claude's cached token at 0.526
// of a fresh one (Opus/Sonnet 5.5: 0.266), and caches nothing of GPT-5.6,
// DeepSeek, MiniMax or GLM (cached = fresh). Opus 5.5 and Sonnet 5.5 are
// metered per token of their newer tokenizer, whose prompts count ~1.3×.
const PRICES = {
  "auto": { fresh: 3.15, cached: 1.66, output: 97.7, chars: 3.34 },
  "claude-opus-5.5": { fresh: 12.49, cached: 3.32, output: 157.5, chars: 3.34 },
  "claude-sonnet-5.5": { fresh: 8.11, cached: 2.16, output: 99.0, chars: 3.15 },
  "claude-opus-5": { fresh: 6.93, cached: 3.65, output: 211.8, chars: 3.27 },
  "claude-sonnet-5": { fresh: 4.1, cached: 2.16, output: 125.1, chars: 3.37 },
  "claude-opus-4.8": { fresh: 6.93, cached: 3.65, output: 212.1, chars: 3.29 },
  "claude-opus-4.7": { fresh: 6.93, cached: 3.65, output: 214.0, chars: 3.25 },
  "claude-opus-4.6": { fresh: 6.93, cached: 3.65, output: 215.8, chars: 4.56 },
  "claude-opus-4.5": { fresh: 6.93, cached: 3.65, output: 235.7, chars: 4.43 },
  "claude-sonnet-4.6": { fresh: 4.1, cached: 2.16, output: 127.7, chars: 4.47 },
  "claude-sonnet-4.5": { fresh: 4.1, cached: 2.16, output: 128.7, chars: 4.59 },
  "claude-sonnet-4": { fresh: 4.1, cached: 2.16, output: 128.0, chars: 4.5 },
  "claude-haiku-4.5": { fresh: 1.26, cached: 0.66, output: 42.9, chars: 4.79 },
  "gpt-5.6-sol": { fresh: 72.97, cached: 72.97, output: 454.9, chars: 4.49 },
  "gpt-5.6-terra": { fresh: 36.59, cached: 36.59, output: 217.9, chars: 4.62 },
  "gpt-5.6-luna": { fresh: 9.95, cached: 9.95, output: 58.8, chars: 4.77 },
  "deepseek-3.2": { fresh: 6.1, cached: 6.1, output: 12.1, chars: 4.69 },
  "minimax-m2.5": { fresh: 5.18, cached: 5.18, output: 16.0, chars: 4.84 },
  "minimax-m2.1": { fresh: 3.17, cached: 3.17, output: 10.1, chars: 5.19 },
  "glm-5": { fresh: 11.77, cached: 11.77, output: 25.9, chars: 4.58 },
}

// learnChars: a model's characters a reply token, refined from what costs
// no credit more. The next turn of a conversation holds the last reply in
// its history, and Kiro's context (exact, by its own tokenizer) grows by the
// reply's tokens and the new ask's: so the reply's exact token count is
// what the prompt grew by, less the ask's (kept short against the reply,
// so its estimate matters little). Learned only of a plain reply (no tool
// call, no thinking), whose text comes back as it was said. A conversation
// is known by its model and first message.
const turns = new Map() // conversation → { at, model, prompt, messages, chars }
const learned = new Map() // model → { chars, tokens, n }
const TURN_TTL = 30 * 60 * 1000
function charsOf(model) {
  const l = learned.get(model)
  return l && l.n >= 3 ? l.chars : PRICES[model]?.chars || 4
}
const textLen = (c) =>
  typeof c === "string" ? c.length : Array.isArray(c) ? c.reduce((n, p) => n + (p?.type === "text" ? String(p.text ?? "").length : 0), 0) : 0
function conversationKey(req) {
  const first = req.messages?.[0]
  const text = typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? "")
  return createHash("sha256").update(String(req.model ?? "") + "\0" + text.slice(0, 4096)).digest("hex").slice(0, 24)
}
// learnFrom is this turn's prompt, exact, read against the conversation's
// last turn: what that turn's reply came to in tokens.
function learnFrom(req, model, prompt) {
  const was = turns.get(conversationKey(req))
  if (!was || was.model !== model || Date.now() - was.at > TURN_TTL || !(prompt > was.prompt)) return
  const ms = req.messages ?? []
  const reply = ms[was.messages]
  if (reply?.role !== "assistant" || textLen(reply.content) !== was.chars) return
  const askChars = ms.slice(was.messages + 1).reduce((n, m) => n + textLen(m.content), 0)
  if (askChars * 3 > was.chars) return // the ask too long to leave the reply's count clear
  const tokens = prompt - was.prompt - askChars / charsOf(model)
  if (!(tokens > 20)) return
  const chars = was.chars / tokens
  if (!(chars > 1.5 && chars < 8)) return
  const l = learned.get(model) ?? { chars: 0, tokens: 0, n: 0 }
  l.chars = (l.chars * l.tokens + was.chars) / (l.tokens + tokens)
  l.tokens += tokens
  l.n++
  learned.set(model, l)
}
// remember keeps this turn, for the next one to learn its reply from.
function remember(req, model, prompt, chars) {
  if (!(chars > 200)) return
  turns.set(conversationKey(req), { at: Date.now(), model, prompt, messages: (req.messages ?? []).length, chars })
  if (turns.size > 512) turns.delete(turns.keys().next().value)
}

// meter reads usage's cache from what Kiro metered, the prompt's size and
// the reply's tokens: the tokens it read from its cache, the rest fresh.
// A native thinker's reasoning, metered as output but said only in
// summary, is what the credits leave over: told as output, so it is
// billed as Kiro billed it. False when it can't be read (no price, no
// metering), and cacheRatio stands in.
function meter(usage, model, credits) {
  const p = PRICES[model]
  if (cfg.meter === "off" || !p || !(credits > 0) || !(usage.input > 0)) return false
  const T = usage.input
  const O = usage.output
  const perTok = (x) => x / 1e6
  const outCost = perTok(p.output) * O
  // all the prompt fresh, and all of it read from the cache: what lies
  // between is read as that share of it cached
  const cold = perTok(p.fresh) * T + outCost
  let read = 0
  if (credits < cold && p.fresh > p.cached) read = ((cold - credits) / (perTok(p.fresh) - perTok(p.cached)))
  read = Math.max(0, Math.min(T, Math.round(read)))
  // more than a cold prompt and the reply cost: what the reply didn't show
  // (a native thinker's reasoning), told as output
  if (credits > cold && p.output > 0) usage.output = O + Math.round((credits - cold) / perTok(p.output))
  usage.cacheRead = read
  usage.input = T - read
  usage.credits = credits
  return true
}

// HIDDEN is the tokens of Kiro's own prompt, measured live (testenv
// probe-reply, part hidden2): a bare ask's context, less that ask and the
// one-token reply. cli is what origin KIRO_CLI adds, web what KIRO_WEB
// adds (the shorter one). A model not measured is left as Kiro counted it.
const HIDDEN = {
  "auto": { cli: 5806, web: 1106 },
  "claude-opus-5.5": { cli: 6698, web: 1262 },
  "claude-sonnet-5.5": { cli: 6509, web: 1197 },
  "claude-opus-5": { cli: 6696, web: 1260 },
  "claude-sonnet-5": { cli: 6507, web: 1195 },
  "claude-opus-4.8": { cli: 6421, web: 1195 },
  "claude-opus-4.7": { cli: 5907, web: 1202 },
  "claude-opus-4.6": { cli: 4114, web: 802 },
  "claude-opus-4.5": { cli: 4052, web: 740 },
  "claude-sonnet-4.6": { cli: 4055, web: 742 },
  "claude-sonnet-4.5": { cli: 4052, web: 740 },
  "claude-haiku-4.5": { cli: 4054, web: 741 },
  "gpt-5.6-sol": { cli: 1526, web: 930 },
  "gpt-5.6-terra": { cli: 1526, web: 930 },
  "gpt-5.6-luna": { cli: 1526, web: 930 },
  "deepseek-3.2": { cli: 3699, web: 665 },
  "minimax-m2.5": { cli: 3870, web: 696 },
  "minimax-m2.1": { cli: 3632, web: 686 },
  "glm-5": { cli: 3883, web: 673 },
  "qwen3-coder-next": { cli: 3646, web: 682 },
  "kimi-k3": { cli: 4082, web: 767 },
}

// withoutHidden takes Kiro's own prompt out of a count Kiro made, so the
// caller isn't told those tokens. The cached share goes first: that prompt
// is the part Kiro caches. What remains comes out of the fresh tokens.
// The reply is left as it was. Off unless dropHidden.
function withoutHidden(usage, model) {
  if (!cfg.dropHidden) return usage
  const h = HIDDEN[String(model).toLowerCase().replace(/^.*:/, "")]
  let n = h ? (cfg.web ? h.web : h.cli) : 0
  if (!(n > 0)) return usage
  const fromCache = Math.min(usage.cacheRead || 0, n)
  usage.cacheRead = (usage.cacheRead || 0) - fromCache
  n -= fromCache
  if (n > 0) usage.input = Math.max(0, (usage.input || 0) - n)
  return usage
}

// estimateInput is how many tokens a request's prompt holds, roughly, for
// when Kiro tells nothing of it: about 4 characters a token for text (CJK
// about 1), and 1600 an image, as Anthropic counts a full-size one.
function estimateInput(req) {
  let chars = 0
  let cjk = 0
  let images = 0
  const add = (s) => {
    if (typeof s !== "string" || !s) return
    chars += s.length
    const m = s.match(/[぀-ヿ㐀-鿿가-힯豈-﫿]/g)
    if (m) cjk += m.length
  }
  const walk = (c) => {
    if (typeof c === "string") return add(c)
    if (!Array.isArray(c)) return
    for (const p of c) {
      if (!p || typeof p !== "object") continue
      if (p.type === "text") add(p.text)
      else if (p.type === "thinking") add(p.thinking)
      else if (p.type === "image") images++
      else if (p.type === "tool_use") add(JSON.stringify(p.input ?? {}))
      else if (p.type === "tool_result") walk(typeof p.content === "string" ? [{ type: "text", text: p.content }] : p.content)
      else if (p.type === "document") add(documentText(p))
    }
  }
  walk(typeof req.system === "string" ? [{ type: "text", text: req.system }] : req.system)
  for (const m of req.messages ?? []) walk(typeof m?.content === "string" ? [{ type: "text", text: m.content }] : m?.content)
  for (const t of req.tools ?? []) add((t?.name ?? "") + (t?.description ?? "") + JSON.stringify(t?.input_schema ?? {}))
  return Math.ceil((chars - cjk) / 4 + cjk) + images * 1600
}

// quotaWords are magpie's (internal/gateway/fallback.go): how a vendor says
// "out of quota" or "slow down".
const QUOTA_WORDS = /quota|insufficient|balance|credit|billing|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i

// failedBefore is the reply to an error before any of the answer, as
// magpie's built-in relay gives it: a status, not a stream, so another
// account can take over — a 429 when it reads as a quota or rate limit,
// else a 502.
const failedBefore = (text) => errorResponse(QUOTA_WORDS.test(text) ? 429 : 502, text)

// refusedBefore is a refusal with nothing said: a 400 whose code is a safety
// filter's, as OpenAI's content_filter. magpie reads that code as a refusal
// (policyRefusal), asks the next account without setting this one aside,
// and once none is left says it at a 400, which new-api neither retries nor
// bills, handing back what it held for the request.
const refusedBefore = (text) =>
  new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", code: "content_filter", message: text } }), {
    status: 400,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "kept" },
  })
const failedAs = (e) => (e.refused ? refusedBefore(e.text) : failedBefore(e.text))

const PING = Symbol("ping")
let PING_MS = 15_000

// reply answers the Messages request from Kiro's events: a stream of
// Messages' events, or one message. names gives back the caller's name of
// a tool Kiro was sent under another (toolNames); estimate is the prompt's
// size, told in message_start before Kiro tells its own at the end.
async function reply(it, model, stream, names = new Map(), estimate = 0) {
  const id = "msg_" + randomBytes(12).toString("hex")
  if (!stream) {
    const content = []
    let last = null
    const add = (block) => {
      content.push(block)
      last = block
    }
    for await (const e of it) {
      if (e.kind === "text") {
        if (last?.type === "text") last.text += e.text
        else add({ type: "text", text: e.text })
      } else if (e.kind === "think") {
        if (last?.type === "thinking") last.thinking += e.text
        else add({ type: "thinking", thinking: e.text, signature: "" })
      } else if (e.kind === "sig") {
        if (last?.type === "thinking") last.signature += e.text
      } else if (e.kind === "toolStart") add({ type: "tool_use", id: e.id, name: names.get(e.name) ?? e.name, input: "" })
      else if (e.kind === "toolArgs") {
        if (last?.type === "tool_use") last.input += e.text
      } else if (e.kind === "error") {
        // with none of the answer said, a status; else what was said
        if (!content.length) return failedAs(e)
        return Response.json({ id, type: "message", role: "assistant", model, content: finished(content), stop_reason: "end_turn",
          stop_sequence: null, usage: anthropicUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) })
      } else if (e.kind === "stop") {
        return Response.json({ id, type: "message", role: "assistant", model, content: finished(content), stop_reason: e.reason, stop_sequence: null,
          usage: anthropicUsage(e.usage) })
      }
    }
    return errorResponse(502, "the reply ended before it was complete")
  }

  // an error before any of the answer is a status, as the built-in's
  const head = await it.next()
  if (head.value?.kind === "error") return failedAs(head.value)
  let pending = head

  const enc = new TextEncoder()
  const sse = (type, data) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  let index = -1
  let open = "" // the kind of block open
  let started = false
  let opened = false // the hold on a Claude's thinking has been released once
  let waiting = null // the event awaited across pings
  const body = new ReadableStream({
    async pull(ctl) {
      if (!started) {
        started = true
        const start = withCache({ input: estimate, output: 0, cacheRead: 0, cacheWrite: 0 })
        ctl.enqueue(sse("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null,
          stop_sequence: null, usage: { ...anthropicUsage(start), output_tokens: 1 } } }))
        return
      }
      const close = () => {
        if (open) ctl.enqueue(sse("content_block_stop", { index }))
        open = ""
      }
      const begin = (kind, block) => {
        close()
        index++
        open = kind
        ctl.enqueue(sse("content_block_start", { index, content_block: block }))
      }
      // a long silence (thinking, a long tool call) is kept alive with a
      // ping every PING_MS, as Anthropic's stream is, so no proxy between
      // drops it; the next event is still the one awaited
      let r = pending
      if (!r) {
        const next = (waiting ??= it.next())
        for (;;) {
          let t
          const tick = new Promise((ok) => (t = setTimeout(() => ok(PING), PING_MS)))
          const got = await Promise.race([next, tick])
          clearTimeout(t)
          if (got !== PING) {
            r = got
            break
          }
          ctl.enqueue(sse("ping", {}))
        }
        waiting = null
      }
      pending = null
      if (r.done) return ctl.close()
      const e = r.value
      switch (e.kind) {
        case "text":
          if (open !== "text") begin("text", { type: "text", text: "" })
          ctl.enqueue(sse("content_block_delta", { index, delta: { type: "text_delta", text: e.text } }))
          break
        case "think":
          if (open !== "thinking") begin("thinking", { type: "thinking", thinking: "", signature: "" })
          ctl.enqueue(sse("content_block_delta", { index, delta: { type: "thinking_delta", thinking: e.text } }))
          // magpie holds a Claude's thinking while another account could
          // still answer, and only lets it through on content. response.done
          // is that to magpie: Anthropic's client skips an event it doesn't
          // know, and new-api drops it when turning the stream into OpenAI
          // Chat, so it never becomes text or a tool call. Once, on the
          // first thinking delta, after the block has started.
          if (!opened) {
            opened = true
            ctl.enqueue(sse("response.done", {}))
          }
          break
        case "sig":
          if (open === "thinking") ctl.enqueue(sse("content_block_delta", { index, delta: { type: "signature_delta", signature: e.text } }))
          break
        case "toolStart":
          begin("tool", { type: "tool_use", id: e.id, name: names.get(e.name) ?? e.name, input: {} })
          break
        case "toolArgs":
          if (open === "tool") ctl.enqueue(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: e.text } }))
          break
        case "error":
          close()
          ctl.enqueue(sse("error", { error: { type: "api_error", message: e.text } }))
          return ctl.close()
        case "stop":
          close()
          ctl.enqueue(sse("message_delta", { delta: { stop_reason: e.reason, stop_sequence: null }, usage: anthropicUsage(e.usage) }))
          ctl.enqueue(sse("message_stop", {}))
          return ctl.close()
      }
    },
    cancel() {
      it.return?.()
    },
  })
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}

// generate answers a Messages request through Kiro's API: once more,
// refreshed, when Kiro turns the token down (403). As the built-in: no
// credentials is a 401, a failed refresh after the 403 a 502; none marks
// the account.
async function generate(creds, auth, req, signal) {
  const model = String(req.model ?? "auto")
  const budget = thinking(req, model)
  let a
  try {
    a = await creds(auth)
  } catch (e) {
    return errorResponse(401, e.message)
  }
  const max = 1 + cfg.retries
  const estimate = estimateInput(req)
  const names = toolNames(req)
  const known = new Set((req.tools ?? []).map((t) => toolName(t?.name)).filter(Boolean))
  let refreshed = false
  let res
  for (let n = 1; ; n++) {
    try {
      await paced(a, signal)
      res = await sendKiro(a, buildKiro(req, model, a.profile, budget), signal, n, max)
    } catch (e) {
      if (e?.name === "AbortError" || signal?.aborted) throw e
      // a network error: tried again while tries are left
      if (n < max) {
        await sleep(backoff(n), signal)
        continue
      }
      return errorResponse(502, e.message)
    }
    if (res.status === 403) {
      const text = (await res.text().catch(() => "")).slice(0, 1 << 20)
      // a suspended or banned account won't come back by a refresh: its
      // sign-in is said expired, so magpie stops picking it and moves on
      if (SUSPENDED.test(text)) return lapsed(403, failure(403, text).message)
      if (!refreshed) {
        // an expired or revoked token: refreshed, it goes once more (not a try)
        refreshed = true
        try {
          a = await creds(auth, true)
        } catch (e) {
          return errorResponse(502, e.message)
        }
        n--
        continue
      }
      const f = failure(403, text)
      return errorResponse(f.status, f.message)
    }
    if (retryable(res.status) && n < max) {
      const text = (await res.text().catch(() => "")).slice(0, 1 << 20)
      // a monthly limit won't lift on its own: the next account, at once
      if (/MONTHLY_REQUEST_COUNT|USAGE_LIMIT/.test(text)) {
        const f = failure(res.status, text)
        return errorResponse(f.status, f.message)
      }
      await sleep(backoff(n, res), signal)
      continue
    }
    if (!res.ok) {
      // Kiro's own 401 is passed on, as the built-in did, the sign-in kept
      const text = (await res.text()).slice(0, 1 << 20)
      if (SUSPENDED.test(text)) return lapsed(res.status, failure(res.status, text).message)
      const f = failure(res.status, text)
      return errorResponse(f.status, f.message)
    }
    // the reply's first event: a 200 that says nothing is tried again
    const it = events(res.body, model, budget, estimate, known, req)
    const head = await it.next()
    if (head.value?.kind === "error" && head.value.empty && n < max) {
      await sleep(backoff(n), signal)
      continue
    }
    return kept(await reply(replayed(head, it), model, req.stream === true, names, estimate))
  }
}

// replayed is it with its first result, already read, given again.
async function* replayed(head, it) {
  if (head.done) return
  yield head.value
  yield* it
}

// SUSPENDED is how Kiro says an account is suspended or banned, as
// AIClient-2-API reads it: no refresh brings it back.
const SUSPENDED = /temporarily (is )?suspended|TEMPORARILY_SUSPENDED|account (has been |is )?(suspended|disabled|banned)|violation of (the )?terms|terms of service|AccountSuspended/i

// lapsed is a failure that marks the account's sign-in lapsed in magpie,
// so the next request goes to another account (X-Magpie-Sign-In: expired).
const lapsed = (status, message) =>
  new Response(JSON.stringify({ type: "error", error: { type: errorType(status), message: "Kiro suspended this account: " + message } }), {
    status,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "expired" },
  })

// paced waits until minInterval has passed since the account's last
// request, so one account isn't asked faster than that.
const lastAsked = new Map()
async function paced(a, signal) {
  if (!(cfg.minInterval > 0)) return
  const key = a.machineId || a.token
  for (;;) {
    const wait = (lastAsked.get(key) ?? 0) + cfg.minInterval - Date.now()
    if (wait <= 0) break
    await sleep(wait, signal)
  }
  lastAsked.set(key, Date.now())
  if (lastAsked.size > 256) lastAsked.delete(lastAsked.keys().next().value)
}

// ---- signing in ----------------------------------------------------------------------

function page(ok, title, text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#222;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}}main{text-align:center;max-width:28rem;padding:1rem}
.d{font-size:2rem;color:${ok ? "#2a9d5c" : "#c0392b"}}</style>
<main><div class="d">${ok ? "✓" : "✕"}</div><h1>${esc(title)}</h1><p>${esc(text)}</p></main>`
}

// signInPost posts JSON to Kiro's auth service or AWS's sign-in.
async function signInPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": IDE_UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    let e = {}
    try {
      e = JSON.parse(text)
    } catch {}
    throw new Error(`the sign-in was refused (${res.status}): ${e.error_description || e.message || e.error || res.statusText}`)
  }
  return JSON.parse(text)
}

const expiry = (s) => Date.now() + (s > 0 ? s : 3600) * 1000

// whoIs names a new sign-in with the email Kiro has for it, and its plan.
async function whoIs(c) {
  try {
    const profile = c.profile || (await profileOf(c))
    const a = { token: c.access, tokenType: tokenType(c), profile, region: regionOf(profile, c.region) }
    const l = await usageLimits(a, true)
    return { profile, email: l?.userInfo?.email ?? "", plan: planName(l?.subscriptionInfo?.subscriptionTitle) }
  } catch {
    return { profile: c.profile ?? "", email: "", plan: "" }
  }
}

async function listen() {
  for (const port of CALLBACK_PORTS) {
    const server = createServer()
    const ok = await new Promise((resolve) => {
      server.once("error", () => resolve(false))
      server.listen(port, "127.0.0.1", () => resolve(true))
    })
    if (ok) return { server, port }
  }
  throw new Error("the ports Kiro's sign-in comes back to are all busy; close the Kiro IDE's sign-in and try again")
}

// browserSignIn is the IDE's: Kiro's sign-in page, back to a port here.
async function browserSignIn() {
  const { server, port } = await listen()
  const state = randomBytes(24).toString("base64url")
  const verifier = randomBytes(48).toString("base64url")
  const redirect = `http://localhost:${port}`
  const aws = {} // once Kiro's page has sent the browser on to AWS
  const awsRedirect = `http://127.0.0.1:${port}/oauth/callback`
  let waiting = true
  let settle
  const done = new Promise((r) => (settle = r))
  const finish = (result) => {
    if (!waiting) return
    waiting = false
    settle(result)
  }

  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", redirect)
    const html = (code, body) => {
      res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" })
      res.end(body)
    }
    if (url.pathname !== "/oauth/callback" && url.pathname !== "/signin/callback") return res.writeHead(404).end()
    const q = url.searchParams
    if (!waiting) return html(200, page(false, "This sign-in is over", "Start it again."))
    const fail = (msg) => {
      finish({ type: "failed", error: msg })
      html(200, page(false, "Sign-in didn't finish", msg))
    }
    if (q.get("error")) return fail(q.get("error_description") || q.get("error"))
    let c
    try {
      if (aws.state && q.get("state") === aws.state) {
        // back from AWS
        if (!q.get("code")) return fail("AWS sent back no code")
        const t = await signInPost(oidc(aws.region) + "/token", { clientId: aws.clientId, clientSecret: aws.clientSecret,
          grantType: "authorization_code", redirectUri: awsRedirect, code: q.get("code"), codeVerifier: aws.verifier })
        if (!t.accessToken) throw new Error("AWS sent back no token")
        c = { access: t.accessToken, refresh: t.refreshToken ?? "", expires: expiry(t.expiresIn), method: "idc", loginProvider: aws.provider,
          region: aws.region, clientId: aws.clientId, clientSecret: aws.clientSecret, profile: "", builderID: isBuilderID(aws.provider) }
      } else if (q.get("state") !== state) {
        // not ours: someone else's page, or a stale tab
        return html(200, page(false, "This link isn't from this sign-in", "Start it again."))
      } else {
        const opt = q.get("login_option") ?? ""
        if (opt === "google" || opt === "github") {
          const t = await signInPost(AUTH_SERVICE + "/oauth/token", { code: q.get("code"), code_verifier: verifier,
            redirect_uri: redirect + url.pathname + "?login_option=" + opt })
          if (!t.accessToken) throw new Error("Kiro sent back no token")
          c = { access: t.accessToken, refresh: t.refreshToken ?? "", expires: expiry(t.expiresIn), method: "social",
            loginProvider: opt === "google" ? "Google" : "Github", region: "us-east-1", profile: t.profileArn ?? "" }
        } else if (opt === "builderid" || opt === "awsidc" || opt === "internal") {
          // on to AWS, with a client registered for this sign-in
          const issuer = q.get("issuer_url")
          const region = q.get("idc_region")
          if (!issuer || !region) return fail("Kiro's page didn't say where to sign in at AWS")
          const reg = await signInPost(oidc(region) + "/client/register", { clientName: "Kiro IDE", clientType: "public", scopes: SCOPES,
            grantTypes: ["authorization_code", "refresh_token"], redirectUris: ["http://127.0.0.1/oauth/callback"], issuerUrl: issuer })
          if (!reg.clientId) throw new Error("AWS registered no client")
          Object.assign(aws, { region, clientId: reg.clientId, clientSecret: reg.clientSecret,
            provider: { builderid: "BuilderId", awsidc: "Enterprise", internal: "Internal" }[opt],
            state: randomBytes(24).toString("base64url"), verifier: randomBytes(48).toString("base64url") })
          const a = new URLSearchParams({ response_type: "code", client_id: aws.clientId, redirect_uri: awsRedirect, scopes: SCOPES.join(","),
            state: aws.state, code_challenge: createHash("sha256").update(aws.verifier).digest("base64url"), code_challenge_method: "S256" })
          res.writeHead(302, { Location: `${oidc(region)}/authorize?${a}` })
          return res.end()
        } else if (opt === "external_idp") {
          return fail("A company's own identity provider can't be signed in to here yet; sign in with `kiro-cli login`, and use Kiro CLI's sign-in")
        } else return fail(`Kiro's page came back with a sign-in this plugin doesn't know (${JSON.stringify(opt)})`)
      }
    } catch (e) {
      return fail(e.message)
    }
    const who = await whoIs(c)
    const user = who.email || "Kiro account"
    finish({ type: "success", provider: ID, refresh: c.refresh, access: c.access, expires: c.expires, accountId: user,
      method: c.method, loginProvider: c.loginProvider, region: c.region, profileArn: who.profile,
      ...(c.clientId ? { clientId: c.clientId, clientSecret: c.clientSecret } : {}), ...(who.plan ? { plan: who.plan } : {}) })
    html(200, page(true, "You're signed in", `${user} is signed in. You can close this tab.`))
  })

  const timer = setTimeout(() => finish({ type: "failed", error: "the sign-in timed out" }), SIGN_IN_TIMEOUT)
  done.then(() => {
    clearTimeout(timer)
    setTimeout(() => server.close(), 10_000).unref?.()
  })
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const q = new URLSearchParams({ state, code_challenge: challenge, code_challenge_method: "S256", redirect_uri: redirect, redirect_from: "KiroIDE" })
  return {
    url: `${PORTAL}/signin?${q}`,
    instructions: "Sign in to Kiro with Google, GitHub, AWS Builder ID or IAM Identity Center.",
    method: "auto",
    callback: () => done,
  }
}

// ownSignIn uses kiro-cli's sign-in, else the Kiro IDE's: nothing is copied,
// they are read where they keep it each time.
async function ownSignIn() {
  return {
    url: "",
    instructions: "Uses the account kiro-cli or the Kiro IDE is signed in to.",
    method: "auto",
    callback: async () => {
      const cli = await readCLI()
      const c = cli ?? (await readIDE())
      if (!c) return { type: "failed", error: "neither kiro-cli nor the Kiro IDE is signed in" }
      const who = fresh(c) ? await whoIs(c) : { email: "", plan: "" }
      return { type: "success", provider: ID, refresh: "", access: "", expires: 0, source: cli ? "kiro-cli" : "kiro-ide",
        accountId: who.email || (cli ? "kiro-cli's account" : "Kiro IDE's account"), ...(who.plan ? { plan: who.plan } : {}) }
    },
  }
}

// ---- the plugin ------------------------------------------------------------------------

// jsonSignIn signs in with an exported account (importedAccounts): the
// JSON pasted, or the path of a file holding it. An export of several
// signs in the first active one here and keeps the rest (client.auth.set
// can't make more accounts), naming them so each can be imported with its
// number. The tokens are checked by a refresh before they are kept.
//
// The installed magpie only draws a select (buttons) or a text box, and
// on the web the plugin runs on another computer than the browser, so a
// file can only be chosen in a page of the browser's own. 选择文件… opens
// import.html (importPage): it reads the files there, one or several, and
// hands the accounts ticked to the plugin the first way that works:
//   - its port on 127.0.0.1 (redirect_uri), when the browser is on the
//     plugin's computer: magpie's window, or its page opened there
//   - a relay (importRelay, ntfy.sh): the page publishes them, sealed
//     with AES-GCM under a key that is only in the link's #fragment, to a
//     topic named at random for this import, and the plugin, subscribed,
//     takes them. The relay sees neither the key nor the accounts.
//   - the address pasted under the sign-in, which magpie opens on its own
//     computer (a plugin's pasted callback, by the port redirect_uri names)

// importPacked is the account the page put in its address: "g" and gzip,
// or "j" and the text, base64url either way
function importPacked(d) {
  const s = String(d ?? "")
  const bytes = Buffer.from(s.slice(1), "base64url")
  if (s[0] === "g") return gunzipSync(bytes, { maxOutputLength: IMPORT_MAX }).toString("utf8")
  if (s[0] === "j" && bytes.length <= IMPORT_MAX) return bytes.toString("utf8")
  throw new Error("the address holds no account")
}

// seal and unseal are the relay's: base64url of iv (12 bytes) and the
// AES-256-GCM ciphertext with its tag, as WebCrypto gives it
function seal(key, text) {
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, iv)
  const body = Buffer.concat([c.update(text, "utf8"), c.final(), c.getAuthTag()])
  return iv.toString("base64url") + "." + body.toString("base64url")
}
function unseal(key, sealed) {
  const [iv, body] = String(sealed ?? "").trim().split(".")
  const b = Buffer.from(body ?? "", "base64url")
  if (!iv || b.length < 17) throw new Error("not sealed")
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"))
  d.setAuthTag(b.subarray(b.length - 16))
  return Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]).toString("utf8")
}

// relayed waits on an ntfy topic for the first message sealed with key,
// subscribed for as long as signal lets it (reconnecting when the stream
// drops), and gives its text. A message too big for one is an attachment.
async function relayed(base, topic, key, signal) {
  let since = "all"
  while (!signal.aborted) {
    try {
      const res = await fetch(`${base}/${topic}/json?since=${since}`, { signal, headers: { Accept: "application/x-ndjson" } })
      if (!res.ok || !res.body) throw new Error(`the relay answered ${res.status}`)
      const lines = res.body.pipeThrough(new TextDecoderStream())
      let buf = ""
      for await (const chunk of lines) {
        buf += chunk
        let nl
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          let m
          try {
            m = JSON.parse(line)
          } catch {
            continue
          }
          if (m.event !== "message") continue
          since = m.id
          try {
            const sealed = m.attachment?.url
              ? await (await fetch(m.attachment.url, { signal })).text()
              : m.message
            return unseal(key, sealed)
          } catch {
            // someone else's message on the topic, or a broken one
          }
        }
      }
    } catch (e) {
      if (signal.aborted) break
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error("aborted")
}

// pageSignIn waits for the accounts import.html hands over: at its own
// port on 127.0.0.1, or through the relay. The first account that signs
// in is this sign-in's; the others ticked are kept beside it as accounts
// of their own (client.auth.set under kiro-custom#…, by their name, so
// importing one again replaces it).
async function pageSignIn(client) {
  const server = createServer({ maxHeaderSize: 1 << 20 })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const state = randomBytes(24).toString("base64url")
  const link = new URL(cfg.importPage)
  link.searchParams.set("redirect_uri", `http://127.0.0.1:${server.address().port}/import`)
  link.searchParams.set("state", state)
  const stop = new AbortController()
  const key = randomBytes(32)
  const topic = "kiro-" + randomBytes(18).toString("base64url")
  // the key goes in the fragment, which the browser never sends anywhere
  if (cfg.importRelay) link.hash = new URLSearchParams({ relay: `${cfg.importRelay}/${topic}`, k: key.toString("base64url") }).toString()
  let settle
  const got = new Promise((r) => (settle = r))
  let busy = false
  // one import, from whichever way comes first
  const take = async (text) => {
    if (busy) return null
    busy = true
    const r = await importAll(client, text)
    settle(r)
    return r
  }
  // magpie gives a sign-in ten minutes; the port and the topic go with it
  const timer = setTimeout(() => settle({ type: "failed", error: "没有收到账号，导入已超时；重新开始导入" }), 11 * 60_000)
  const said = (r) => (r.type === "success"
    ? { ok: true, title: `导入了 ${r.count} 个账号`, text: (r.notes.length ? r.notes.join("；") + "。" : "") + "可以关掉这个页面，回到 magpie。" }
    : { ok: false, title: "没有导入账号", text: r.error })
  if (cfg.importRelay) {
    relayed(cfg.importRelay, topic, key, stop.signal).then(async (packed) => {
      let text
      try {
        text = importPacked(packed)
        JSON.parse(text)
      } catch {
        return
      }
      const r = await take(text)
      // the page waits on the reply topic to say how it went
      if (r) await fetch(`${cfg.importRelay}/${topic}-r`, { method: "POST", body: seal(key, JSON.stringify(said(r))), signal: AbortSignal.timeout(15_000) }).catch(() => {})
    }, () => {})
  }
  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const html = (ok, title, text) => {
      // the port closes after the import: no connection is kept to it
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", Connection: "close" })
      res.end(page(ok, title, text))
    }
    // the page asks this port straight, from its own origin: a public page
    // asking one on this computer (Chrome's private network preflight)
    const cors = { "Access-Control-Allow-Origin": link.origin, "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type", "Cache-Control": "no-store", Connection: "close" }
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end()
    // whether the page reaches this port (a browser on another computer can't)
    if (url.pathname === "/ping") return res.writeHead(200, cors).end()
    // the page posts the accounts and stays, to say how it went and close
    if (url.pathname === "/import" && req.method === "POST") {
      const json = (code, o) => res.writeHead(code, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(o))
      if (url.searchParams.get("state") !== state) return json(403, { ok: false, title: "这不是这次导入", text: "在 magpie 里重新开始导入。" })
      if (busy) return json(409, { ok: false, title: "正在导入", text: "这次导入已经收到了账号，回到 magpie 看结果。" })
      let body = ""
      for await (const chunk of req) {
        body += chunk
        if (body.length > 8 << 20) return json(413, { ok: false, title: "数据太大", text: "少选一些账号，分几次导入。" })
      }
      let text
      try {
        text = importPacked(body.trim())
        JSON.parse(text)
      } catch {
        return json(400, { ok: false, title: "没有收到完整的账号", text: "重新选择文件再试。" })
      }
      return json(200, said(await take(text)))
    }
    if (url.pathname !== "/import") return res.writeHead(404).end()
    if (url.searchParams.get("state") !== state) return html(false, "这个地址不是这次导入的", "在 magpie 里重新开始导入。")
    if (busy) return html(false, "正在导入", "这次导入已经收到了账号，回到 magpie 看结果。")
    let text
    try {
      text = importPacked(url.searchParams.get("d"))
      JSON.parse(text)
    } catch (e) {
      return html(false, "地址里没有完整的账号", "重新在导入页里选择文件，并复制完整的地址。")
    }
    const r = await take(text)
    const { ok, title, text: why } = said(r)
    html(ok, title, why)
  })
  return {
    url: link.href,
    instructions: "magpie 打开了导入页：在页面里选择导出的 JSON 文件（可以多选），勾选账号，再点「完成导入」。导入页会自己把账号交给插件；交不过来时，它会给出一个地址，粘贴到下面。",
    method: "auto",
    callback: async () => {
      const r = await got
      clearTimeout(timer)
      stop.abort()
      server.close()
      server.closeIdleConnections?.()
      if (r.type !== "success") return r
      const { count: _c, notes: _n, ...result } = r
      return result
    },
  }
}

// importAll signs in each account of an export, four at a time: the first
// that signs in is the result, the others are kept with client.auth.set.
async function importAll(client, text) {
  let found
  try {
    found = importedAccounts(text)
  } catch (e) {
    return { type: "failed", error: e.message }
  }
  const { accounts, skipped } = found
  if (!accounts.length) return { type: "failed", error: "没有可导入的账号" + (skipped.length ? "：" + skipped.join("; ") : "") }
  const out = new Array(accounts.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, async () => {
    while (next < accounts.length) {
      const i = next++
      out[i] = await accountSignIn(accounts[i])
    }
  }))
  const ok = out.filter((r) => r.type === "success")
  const notes = [...skipped.map((x) => "跳过 " + x), ...out.filter((r) => r.type !== "success").map((r) => "失败 " + r.error)]
  if (!ok.length) return { type: "failed", error: notes.join("; ") }
  for (const r of ok.slice(1)) {
    const { type: _t, provider: _p, ...body } = r
    await client?.auth?.set?.({ path: { id: ID + "#" + createHash("sha256").update(r.accountId).digest("hex").slice(0, 8) }, body: { type: "oauth", ...body } })
  }
  return { ...ok[0], count: ok.length, notes }
}

function importSource(inputs = {}) {
  return String(inputs.json ?? "").trim()
}

function pastePrompt(message) {
  return {
    type: "text",
    key: "json",
    message,
    placeholder: '{"accounts":[…]} 或 C:\\path\\account.json',
  }
}

async function jsonText(input) {
  const s = String(input ?? "").trim()
  if (!s) throw new Error("粘贴账号的 JSON，或填写文件路径")
  if (s.startsWith("{") || s.startsWith("[")) return s
  const path = s.replace(/^["']|["']$/g, "")
  try {
    return await readFile(path, "utf8")
  } catch (e) {
    throw new Error(`读不了 ${path}：${e.code ?? e.message}`)
  }
}

function jsonSignIn(inputs = {}) {
  return {
    url: "",
    instructions: "Imports an account exported by Kiro Account Manager, Cockpit or kiro.rs (credentials.json).",
    method: "auto",
    callback: async () => {
      let text
      try {
        text = await jsonText(importSource(inputs))
      } catch (e) {
        return { type: "failed", error: e.message }
      }
      return importSignIn(text, inputs.index || 1)
    },
  }
}

// importSignIn is the sign-in for account n (1 for the first) of an export
async function importSignIn(text, n) {
  let found
  try {
    found = importedAccounts(text)
  } catch (e) {
    return { type: "failed", error: e.message }
  }
  const { accounts, skipped } = found
  if (!accounts.length) return { type: "failed", error: "没有可导入的账号" + (skipped.length ? "：" + skipped.join("; ") : "") }
  n = Math.trunc(Number(n))
  if (!(n >= 1 && n <= accounts.length))
    return { type: "failed", error: `这份导出有 ${accounts.length} 个账号：${accounts.map((a, i) => `${i + 1}. ${a.user}`).join(", ")}` }
  return accountSignIn(accounts[n - 1])
}

// accountSignIn checks an imported account with a refresh, and gives the
// sign-in to keep
async function accountSignIn({ auth, user }) {
  let c = { ...auth, refresh: auth.refresh, expires: auth.access ? auth.expires : 1, profile: auth.profileArn ?? "",
    builderID: isBuilderID(auth.loginProvider), own: true }
  try {
    // checked, and fresh: an export's access token is often spent
    if (!fresh(c)) c = await refresh(c)
  } catch (e) {
    return { type: "failed", error: `${user}: ${e.message}` }
  }
  const who = await whoIs(c).catch(() => ({ email: "", plan: "" }))
  return { type: "success", provider: ID, access: c.access, refresh: c.refresh, expires: c.expires, method: auth.method, region: auth.region,
    ...(c.profile ? { profileArn: c.profile } : {}), ...(auth.clientId ? { clientId: auth.clientId, clientSecret: auth.clientSecret } : {}),
    ...(auth.loginProvider ? { loginProvider: auth.loginProvider } : {}), ...(auth.machineId ? { machineId: auth.machineId } : {}),
    accountId: who.email || user, ...(who.plan ? { plan: who.plan } : {}) }
}

async function bodyOf(input, init) {
  const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  return JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b))
}

export async function KiroAuthPlugin({ client, magpie } = {}, options = {}) {
  configure(options)
  const creds = account(client)
  // a switch in the provider's editor, as it stands now: the user's value,
  // else the default declared below (itself this entry's options, or the
  // environment). OpenCode has no editor for them and leaves cfg as configure set it.
  const switched = (key) => (typeof magpie?.option === "function" ? magpie.option(ID, key) === true : null)
  return {
    auth: {
      provider: ID,
      // magpie draws these Off/On in the provider's editor (#2038). The
      // keys stay lowercase: the host drops any other. Nothing runs when
      // one changes; the next request reads it.
      options: [
        { key: "web", label: "Kiro Web", default: cfg.web,
          description: "每条消息声明来自 Kiro Web，Kiro 加在前面的提示更短。Sonnet 4.5 是 740 个 token，不是 kiro-cli 的 4052。" },
        { key: "drop-hidden", label: "去掉 Kiro 自带提示", default: cfg.dropHidden,
          description: "报出的用量去掉 Kiro 自己加的那段提示，先从缓存扣，再从全新输入扣。回复的 token 不变。Kiro 没给出上下文大小时不扣。" },
      ],
      // magpie renews a sign-in kept here LEAD_MS before its end, once for
      // the account, before its requests, models and usage ask for it; the
      // check before each request stays for OpenCode, which doesn't call
      // this. kiro-cli's and the IDE's sign-ins have no end magpie knows
      // (expires 0) and are never asked for.
      refreshLead: LEAD_MS,
      // A failure is thrown as it is, a refusal too: the built-in marked
      // no Kiro account lapsed (see gone).
      async refresh(auth) {
        if (auth?.type !== "oauth" || auth.source || !auth.access || !auth.refresh) return undefined
        return creds.renew(auth)
      },
      async loader(getAuth) {
        const auth = await getAuth()
        if (!(auth?.type === "api" && auth.key) && auth?.type !== "oauth") return {}
        return {
          baseURL: BASE,
          apiKey: "kiro", // the fetch signs each request itself
          // every Messages request answered through Kiro's own API
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (!/\/messages$/.test(new URL(url).pathname))
              return errorResponse(404, `this plugin only answers Anthropic Messages requests, not ${new URL(url).pathname}`)
            let req
            try {
              req = await bodyOf(input, init)
            } catch {
              return errorResponse(400, "a request that isn't JSON")
            }
            const web = switched("web")
            const drop = switched("drop-hidden")
            if (web !== null) cfg.web = web
            if (drop !== null) cfg.dropHidden = drop
            return generate(creds, (await getAuth()) ?? auth, req, init.signal)
          },
        }
      },
      // the account's credits, as magpie's built-in showed them; a read,
      // clean or failed, marked the built-in's account nothing
      async usage(getAuth) {
        const auth = await getAuth()
        if (!(auth?.type === "api" && auth.key) && auth?.type !== "oauth") return { error: "not signed in", signIn: "kept" }
        try {
          return { ...usageOf(await usageLimits(await creds(auth), true)), signIn: "kept" }
        } catch (e) {
          return { error: e.message, signIn: "kept" }
        }
      },
      methods: [
        { type: "oauth", label: "Kiro（Google、GitHub、AWS Builder ID、IAM Identity Center）", authorize: browserSignIn },
        { type: "oauth", label: "使用 Kiro CLI 或 Kiro IDE 的登录", authorize: ownSignIn },
        { type: "api", label: "Kiro API Key（ksk_…）" },
        {
          type: "oauth",
          label: "导入导出的账号（JSON）",
          // OpenCode's TUI asks prompts (a path or the JSON). magpie calls
          // ask, and the installed app only draws these select and text
          // questions, so the words are written here as they should appear.
          prompts: [
            { type: "text", key: "json", message: "The account's JSON (Kiro Account Manager, Cockpit, kiro.rs), or the path of its file",
              placeholder: '{"accounts":[…]} or C:\\path\\account.json' },
          ],
          ask: async (inputs = {}) => {
            if (!("how" in inputs) && !("json" in inputs))
              return {
                type: "select", key: "how", message: "导入导出的 Kiro 账号",
                options: [
                  { label: "选择文件…", value: "file", hint: "在浏览器里打开导入页选择文件，桌面窗口和 web 端都能用" },
                  { label: "粘贴 JSON", value: "paste" },
                ],
              }
            // the page chooses the file and the account (pageSignIn)
            if (inputs.how === "file") return null
            if (!("json" in inputs)) return pastePrompt("粘贴账号的 JSON，或填写文件路径")
            if ("index" in inputs) return null
            let found
            try {
              found = importedAccounts(await jsonText(inputs.json))
            } catch {
              return null // said when it signs in
            }
            if (found.accounts.length < 2) return null
            return { type: "select", key: "index", message: "导出里的哪个账号？",
              options: found.accounts.map((a, i) => ({ label: a.user, value: String(i + 1), hint: a.auth.method === "idc" ? "IAM Identity Center" : a.auth.loginProvider || "" })) }
          },
          authorize: async (inputs = {}) => (inputs.how === "file" ? pageSignIn(client) : jsonSignIn(inputs)),
        },
      ],
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "Kiro Custom",
        npm: MESSAGES,
        api: BASE,
        ...was,
        models: { ...Object.fromEntries(MODELS.map((m) => [m.id, configModel(m)])), ...(was.models ?? {}) },
      }
    },
    // the account's own list, the default first
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (!(auth?.type === "api" && auth.key) && auth?.type !== "oauth") return provider.models
        try {
          const list = await listModels(await creds(auth))
          return Object.fromEntries(list.map((m) => [m.id, runtimeModel(m)]))
        } catch {
          return provider.models
        }
      },
    },
  }
}

// for tests
export const _internal = { generate, refresh, usageOf, buildKiro, events, reply, failure, toolID, toolName, toolNames, thinking, configModel, runtimeModel, readCLI, readIDE, regionOf, planName, frames,
  importedAccounts, expiresOf, machineIdOf, normalizeMachineId, kiroHeaders, chatURL, configure, cfg, withCache, estimateInput, jsonSignIn, importSource, importPacked, pageSignIn, importAll, seal, unseal,
  thinkingPrefix, effortField, BUDGETS, TextCalls, realClose, refreshUA, SUSPENDED, meter, PRICES, learned, turns, charsOf, windowsOf: () => windows, HIDDEN, withoutHidden,
  setPing: (ms) => (PING_MS = ms) }
