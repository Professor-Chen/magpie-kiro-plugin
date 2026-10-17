# opencode-kiro-custom

Signs in to a [Kiro](https://kiro.dev) subscription (Free, Pro, Pro+,
Power) and makes its requests, in OpenCode and in magpie. Provider id:
`kiro-custom`.

This is an unofficial plugin. It sits beside magpie's built-in Kiro and
the community plugin `@magpie-community/opencode-kiro-auth` (provider id
`kiro`): a different package, a different provider, its own sign-in. It
does not replace either of them. In magpie it belongs on the unofficial
GitHub list, which needs the repository tagged `magpie-plugin` and
published as its own repository, not as a fork.

## Signing in

- **Kiro (Google, GitHub, AWS Builder ID, IAM Identity Center)**: the Kiro
  IDE's own sign-in.
  - Kiro's page (`app.kiro.dev/signin`) sends the browser back to one of
    the ports the IDE listens on (3128, 4649, 6588, 8008, 9091, 49153,
    50153–53153) on `127.0.0.1`. While the IDE is signing in, those ports
    may be busy.
  - Google and GitHub come back with a code. Kiro's auth service trades it
    for tokens.
  - Builder ID and Identity Center come back with an AWS sign-in URL and
    region. The plugin registers a client with AWS's OIDC service, sends
    the browser to AWS, and trades the code AWS returns.
  - The account is named by the email Kiro has for it (`Get-Usage-Limits`),
    and its plan is read from the same call.
  - A company's own identity provider (`external_idp`) is not supported
    here. Sign in with `kiro-cli login` and use the next method instead.
- **Kiro CLI's or Kiro IDE's sign-in**: uses the account kiro-cli is signed
  in to, or else the Kiro IDE's. Nothing is copied. It is read each time
  from where they keep it:
  - kiro-cli: its SQLite database's `auth_kv` table.
    - macOS: `~/Library/Application Support/kiro-cli/data.sqlite3`
    - Linux: `~/.local/share/kiro-cli/data.sqlite3`
    - Windows: `%APPDATA%\kiro-cli\data.sqlite3`
  - The IDE: `~/.aws/sso/cache/kiro-auth-token.json`.

  kiro-cli refreshes its own token first (`kiro-cli debug refresh-auth-token`).
  A token the plugin refreshes itself is written back, so kiro-cli and the
  IDE go on with it.
- **Kiro API key (`ksk_…`)**: sent with `tokentype: API_KEY`. Its profile is
  found with `GetProfile`.

A browser sign-in is kept where OpenCode keeps sign-ins (`auth.json`; in
magpie, `plugin-auth.json`) as an `oauth` entry. The entry holds the
tokens, the profile ARN, the region and, for AWS, the registered client.
Refreshing such a sign-in:

- magpie renews the token 10 minutes before it expires, through the
  plugin's `auth.refresh`, once for the account and before its requests,
  models and usage need it. magpie saves the new token. A failed renewal,
  even one Kiro refused, doesn't mark the account: it is tried again.
- OpenCode doesn't call that hook: there the token is refreshed 2 minutes
  before it expires, before a request, and saved.
- Either way, a token Kiro turns down (a 403) is refreshed and the request
  tried once more.
- Only one refresh runs at a time, magpie's renewal included, and a token
  refreshed but not yet saved is used rather than spending the old refresh
  token again.
- kiro-cli's and the IDE's sign-ins aren't renewed by magpie: they are
  refreshed before a request, as above, and written back.

Tokens are refreshed through:

- Google/GitHub: through `prod.<region>.auth.desktop.kiro.dev/refreshToken`.
- Builder ID/Identity Center: through AWS's `oidc.<region>.amazonaws.com/token`.

## Requests

Kiro has no API OpenCode speaks. The models are declared on Anthropic's
Messages (`@ai-sdk/anthropic`), and the plugin's `fetch` handles each
request:

- It sends the request to `runtime.<region>.kiro.dev/generateAssistantResponse`,
  the API kiro-cli uses, with kiro-cli's headers. The region is the one the
  profile ARN names.
- It turns the request into a Kiro conversation:
  - The system prompt goes at the head of the first message.
  - Tool calls and results are paired: an unanswered call gets an error
    result, and a result longer than 250,000 characters is cut.
  - Tool ids Kiro wouldn't take are rewritten. A tool name over 64
    characters (an MCP plugin's, in Claude Code) is sent shortened with a
    hash and its calls come back under the full name.
  - A tool's images (a screenshot, Codex's view_image) go with the
    message that answers the call, as Kiro's tool results hold text alone.
  - Only the latest images are sent.
  - Tools the history used but the request doesn't offer are declared.
- It turns the AWS event stream Kiro answers with back into Messages'
  events (streamed) or one message. The reply includes text, thinking,
  tool calls and usage. When Kiro reports only how full the context is,
  input tokens are estimated from that.
- Thinking (Claude models and Auto) is asked for the way kiro-cli asks, in
  the prompt, with a budget: low 10k, medium 20k, high 30k, xhigh and max
  50k (as magpie's built-in Kiro: #120). The
  `<thinking>` block of the reply comes back as thinking.
- Kiro's failures keep their meaning:
  - input too long → 400
  - no capacity → 503
  - usage limit → 429
  - throttling → "rate limited"

## Models

The `config` hook declares `auto` (Kiro picks the model). Once signed in,
the `provider.models` hook replaces it with the account's own list from
`List-Available-Models`, with the default first. Each model carries its
context window, output limit and whether it takes images. Claude models
and Auto have the thinking variants.

## Importing an exported account (this fork)

The sign-in method *Import an exported account (JSON)* takes the JSON, or
the path of the file holding it, as exported by:

- Kiro Account Manager: `{version, exportedAt, accounts: [{email, credentials: {…}, machineId, status}]}`
- Cockpit: `{version: "cockpit-kiro-import", accounts: [{email, auth: {…}, machineId, status}]}`
- kiro.rs's `credentials.json`: one object or an array, `expiresAt` as RFC3339
- the Kiro IDE's `kiro-auth-token.json` (with `clientId`/`clientSecret` for IdC)

The credentials read are `accessToken`, `refreshToken`, `expiresAt`
(milliseconds, seconds or a date), `region`, `authMethod` (`social`, or
`idc`; `builder-id` and `iam` are taken for `idc`), `provider`, `clientId`,
`clientSecret`, `profileArn`, and the account's `machineId`. An account
whose `status` isn't active, or with no refresh token, is skipped with why.
Passwords and notes an export holds are never kept. The second question
picks which account of a multi-account export signs in (1 for the first).
The token is refreshed before the account is kept, so a spent export fails
at once rather than at the first request.

## Settings (this fork)

Set as the plugin's options in magpie's `plugins.json`
(`{"spec": "…", "options": {"cacheRatio": 0.8}}`) or OpenCode's
`["…", {options}]`, else as environment variables:

| Option | Env | Default | |
| --- | --- | --- | --- |
| `cacheRatio` | `KIRO_CACHE_RATIO` | `0` | 0–1: the share of the prompt reported as `cache_read_input_tokens` when Kiro reports no cache; `input_tokens` is the rest. Kiro's own cache figures, when given, stand. |
| `fingerprint` | `KIRO_FINGERPRINT` | `ide` | `ide`: the Kiro IDE's headers (`aws-sdk-js/1.0.34 … KiroIDE-<version>-<machineId>`); `cli`: kiro-cli's, as before. |
| `kiroVersion` | `KIRO_VERSION` | `0.9.2` | The Kiro IDE version the fingerprint names. |
| `nodeVersion` | `KIRO_NODE_VERSION` | `22.21.1` | |
| `systemVersion` | `KIRO_SYSTEM_VERSION` | this OS (`win32#10.0.22631`) | |
| `endpoint` | `KIRO_ENDPOINT` | `kiro` | `kiro`: `runtime.<region>.kiro.dev`; `q`: `q.<region>.amazonaws.com`. |
| `retries` | `KIRO_RETRIES` | `2` | 0–5: tries again after a network error, an empty reply, a 408, a 429 or a 5xx, with backoff (Retry-After honoured). A monthly limit goes to the next account at once. |
| `thinkingMin` / `thinkingMax` | `KIRO_THINKING_MIN` / `_MAX` | `1024` / `64000` | The bounds of a thinking budget, the caller's `budget_tokens` too. |
| `budgets` | `KIRO_BUDGETS` | `low=10000,medium=20000,high=30000,xhigh=50000,max=64000` | Each effort's budget; an object as an option, `k=v,…` in the environment. |
| `adaptive` | `KIRO_ADAPTIVE` | `false` | `true` sends a caller's `thinking: {type: "adaptive"}` as kiro-cli's adaptive mode (`<thinking_effort>low/medium/high`). Off by default: Kiro answered it without thinking in a live check (claude-sonnet-4.5), so adaptive goes as its effort's budget. |
| `effortField` | `KIRO_EFFORT_FIELD` | `auto` | `auto` asks the Claudes that think natively on Kiro (Opus and Sonnet 4.7 and later) by their own fields, `additionalModelRequestFields: {thinking: {type: "adaptive"}, output_config: {effort}}`, as the prompt's tags do nothing for them. `off` asks every model by the prompt. 4.6, 4.5, Haiku and the other vendors' models always think by the prompt; 4.5 and Haiku turn the field away. |
| `minInterval` | `KIRO_MIN_INTERVAL_MS` | `0` | The least time between two requests of one account. |
| `toolDescriptionLimit` | `KIRO_TOOL_DESCRIPTION_LIMIT` | `9216` | A tool's description is cut at this. |
| `meter` | `KIRO_METER` | `on` | `on`: the usage's cache tokens, and a native thinker's unshown reasoning, are read from what Kiro metered (below); `off`: `cacheRatio` stands in. |

### Usage, read from what Kiro metered (this fork)

Kiro tells no token counts: its stream's `metadataEvent` defines a
`tokenUsage` with `cacheReadInputTokens`, but never sends it, and kiro-cli's
own client reports none (`usage: None // if only rts gave usage
metrics...`). It does tell two exact figures: the prompt's size
(`contextUsagePercentage` × the model's window, by its own tokenizer) and
what the request cost (`meteringEvent`, in credits). With each model's
three prices, calibrated live (`PRICES`: a fresh input token, a cached one,
an output token), the cache follows:

    credits = fresh × (prompt − cached) + cached_price × cached + output × reply

so `cache_read_input_tokens` is what Kiro's cache actually read, and
`input_tokens` the rest. Credits past a cold prompt and the reply are a
native thinker's reasoning, told only in summary: told as output tokens, so
the reply is billed as Kiro billed it. Priced back with the same prices, the
usage comes to what Kiro metered: in a live five-turn conversation within
0.01% (Sonnet 4.5: 41–47% of each later prompt cached; Opus 5.5: 72–86%).

The reply's tokens are its characters over the model's characters a token
(calibrated, e.g. 4.59 for Sonnet 4.5, 3.34 for Opus 5.5's newer
tokenizer), refined at no cost: the next turn of a conversation holds the
reply, and Kiro's exact context grows by its tokens.

What the calibration found: Kiro meters a Claude's cached token at 0.526
of a fresh one (Opus and Sonnet 5.5: 0.266), and caches nothing of GPT-5.6,
DeepSeek, MiniMax or GLM. Kiro caches by itself: the plugin's cache points,
their place, and the conversation id change nothing.

A refusal (Kiro's safety filter: `stopDetails.refusal`, e.g. `BIO`) is
answered as one: its explanation as the text, `stop_reason: "refusal"`,
rather than tried again as an empty reply.

Thinking: each effort is its own budget (`max` is past `xhigh`), the
caller's `budget_tokens` is used when it names no effort, and
`thinking: {type: "disabled"}` asks none.

How Kiro's models think, as live checks on a Kiro Pro+ account found:

- Opus and Sonnet 4.7 and later think on their own, whatever the prompt
  says, their reasoning streamed apart (`reasoningContentEvent`, a summary
  of it). `output_config.effort` sets how much: on one hard question,
  `low` 47 reasoning frames and 0.23 credits, `max` 218 and 0.77. Their
  `thinking.type` takes `"adaptive"` alone (`"enabled"` is a 400). They
  are asked so (`effortField: auto`); a caller that asks no thinking is
  shown none of theirs, and with thinking turned off they are asked the
  least (`low`).
- Sonnet and Opus 4.6 and 4.5 (and Auto) think only as the prompt's
  `<thinking_mode>` tags ask, in the reply's words between `<thinking>`
  tags, which are taken out as thinking. kiro-cli's adaptive tags
  (`<thinking_effort>`) were answered without thinking (`adaptive: false`).

What the model thought in earlier turns goes back in the history as
`<thinking>…</thinking>` for a model that thinks by the prompt, so a
thinking conversation goes on from its own reasoning. The thinking ends at
its own closing tag only: not one quoted (`` `</thinking>` ``), and
followed by a blank line or the reply's end.

Also: a tool call Kiro's model says in words (`[Called Bash with args:
{…}]`) is given as the call, for a tool the request offered; a 403 saying
the account is suspended (`TEMPORARILY_SUSPENDED`, terms of service) marks
its sign-in expired in magpie (`X-Magpie-Sign-In: expired`), so the next
request goes to another account, rather than refreshing it; and a Google or
GitHub sign-in is refreshed as the IDE the requests name.

The machine id is the account's own (64 hex, or a UUID doubled), else a
hash of the account's name, so it stays the same across refreshes.

Also in this fork: `message_start` tells the prompt's estimated size (it
said 0 until the end), the prompt is estimated from the request when Kiro
tells nothing of it, and a stream silent for 15 seconds (thinking, a long
tool call) is kept alive with `ping` events.

## Not included

- Usage and quota (credits, the monthly window).
- Switching between several accounts. OpenCode keeps one sign-in per
  provider.
- Signing in with a company's own identity provider in the browser (use
  kiro-cli's sign-in).
- magpie's web-search stand-in for Kiro.
