// Kiro turns down a tool whose input schema doesn't say type "object" at
// its root: {properties: {text: {type: "string"}}, required: ["text"]} is a
// 400 REQUEST_BODY_INVALID from Haiku 5.5, and the same with type "object"
// added a tool call; {} is a 400 too. A tool's input is always an object,
// so the root says so; nothing under it is touched.
import { expect, test, afterAll, afterEach } from "bun:test"
import { KiroAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
const offline = async () => { throw new Error("no network in tests") }
globalThis.fetch = offline
afterEach(() => (globalThis.fetch = offline))
afterAll(() => (globalThis.fetch = real))

// sent asks through the plugin's fetch with these tools and gives the tool
// specifications Kiro was sent
async function sent(tools) {
  let body
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("generateAssistantResponse")) {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ message: "stop here" }), { status: 500 })
    }
    return new Response("{}", { status: 400 }) // GetProfile: a key with no profile
  }
  const hooks = await KiroAuthPlugin({})
  const l = await hooks.auth.loader(async () => ({ type: "api", key: "ksk_test" }))
  await l.fetch("https://kiro.invalid/v1/messages", { method: "POST",
    body: JSON.stringify({ model: "claude-haiku-5.5", messages: [{ role: "user", content: "hi" }], tools }) })
  return body.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools.map((t) => t.toolSpecification.inputSchema.json)
}
const tool = (input_schema) => ({ name: "echo", description: "echo", input_schema })

test("a root with properties and no type is sent as an object, the rest as given", async () => {
  const schema = { properties: { text: { type: "string" } }, required: ["text"] }
  expect(await sent([tool(schema)])).toEqual([{ type: "object", properties: { text: { type: "string" } }, required: ["text"] }])
})

test("the caller's request object isn't changed", () => {
  const req = { model: "auto", messages: [{ role: "user", content: "hi" }],
    tools: [tool({ properties: { text: { type: "string" } } }), tool({ type: ["object", "null"] }), tool({})] }
  const before = structuredClone(req)
  const json = JSON.parse(_internal.buildKiro(req, "auto", "", 0))
  expect(json.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json.type).toBe("object")
  expect(req).toEqual(before)
})

test("an empty or missing schema is an object with no properties", async () => {
  expect(await sent([tool({}), { name: "bare", description: "x" }])).toEqual([
    { type: "object", properties: {} }, { type: "object", properties: {} }])
})

test("an object root is sent exactly, its nested unions, refs and keywords kept", async () => {
  const schema = {
    type: "object", additionalProperties: false, $defs: { id: { type: "string" } },
    properties: {
      a: { anyOf: [{ type: "string" }, { type: "null" }] },
      b: { oneOf: [{ $ref: "#/$defs/id" }, { type: "integer" }] },
      c: { properties: { d: { type: "string" } } }, // a nested object without type stays so
      e: { type: "string", nullable: true },
    },
    required: ["a"],
  }
  const before = structuredClone(schema)
  expect(await sent([tool(schema)])).toEqual([before])
})

test("a typeless root union says object beside its branches, which are kept", async () => {
  const schema = { anyOf: [{ properties: { x: { type: "string" } }, required: ["x"] }, { properties: { y: { type: "number" } } }] }
  const [got] = await sent([tool(schema)])
  expect(got.type).toBe("object")
  expect(got.anyOf).toEqual(schema.anyOf)
  expect(schema.type).toBeUndefined()
})

test("a nullable object root is an object; another explicit type is left as the caller said it", async () => {
  expect((await sent([tool({ type: ["object", "null"], properties: { x: { type: "string" } } })]))[0])
    .toEqual({ type: "object", properties: { x: { type: "string" } } })
  expect((await sent([tool({ type: "string" })]))[0]).toEqual({ type: "string" })
})
