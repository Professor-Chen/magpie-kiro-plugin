# 更新记录

[English](README.en.md) · [简体中文](README.md)

## 0.1.12-custom.16（2026-10-30）

- 新增指纹开关 `fp`（`KIRO_FP`），三档：`off` / `safe`（默认）/ `full`。
  - `off`：完全回到旧行为——整台机器共用一个 machineId、不补 `Accept-Language` 和
    `x-amz-date`、`amz-sdk-request` 仍是 `max=1`、不用账号代理。做对照或出问题时用。
  - `safe`：每个账号各自的设备身份和出口，推荐。
  - `full`：同 `safe`；TLS 伪装（curl-impersonate）的接口留好了（`KIRO_CURL_BIN`），
    这版还没接上，填了不生效。
- `fpDeviceId`（`KIRO_FP_DEVICE_ID`）：**修掉最严重的一处**。此前
  `const id = a.machineId || machineIdOf(null)` 传的是 `null`，所有没带 machineId 的账号
  都落到 `sha256("KiroFallback/magpie:" + hostname())` —— 一整池账号发同一个设备指纹。
  现在改成按账号派生（machineId → APIKey → 账号 id → refreshToken），
  不同账号必然不同。真要在旧行为上跑，把 `fpDeviceId` 设 `false`。
- `fpProfile`（`KIRO_FP_PROFILE`）：版本、OS 标识、`Accept-Language` 按账号自洽。
  默认把 `kiroVersion` 的 `0.9.2` 换成 `1.1.70`（除非显式设了 `KIRO_VERSION`），
  并消掉 `IDE_UA` 里写死的 `1.1.70` 与 `cfg.kiroVersion` 各说一套的矛盾——
  sign-in 的 UA 现在也走同一套（`ideUa()`）。
- `fpProxy`（`KIRO_FP_PROXY`）：账号带了 `proxyUrl` 就走它，`direct` 表示显式直连
  （`{proxy: undefined}` 会带着键交给 Bun，从而不让宿主注入全局代理）。
- `amz-sdk-request` 在开关打开时默认 `max=3`，和真实 SDK 一致；关掉仍是 `max=1`。
- `kiro-cli` 指纹的 `md/appVersion-…` 后缀原来每次请求随机，现在按账号固定
  （真实 CLI 的实例 id 是稳定的）。
- 不新增任何 Kiro 官方没有的请求头（`systemVersion` / `nodeVersion` / `x-machine-id`
  这类自创头不加——那比缺头更容易被认出来）。

## 0.1.12-custom.15（2026-10-22）

- 一个字都没写出就被安全策略拒答的，改为 400 错误：`invalid_request_error`，`code: content_filter`，说明带拒答类别（例如 `BIO`）。magpie 认出是拒答，换下一个账号再问、不让这个账号休息，都拒了才把 400 交给客户端。new-api 不重试 400，记错误、退回预扣，不再扣费。此前它是 200 加 `stop_reason: refusal`，插件还按整段提示报用量，new-api 照常扣费，而 Kiro 对它计量为 0（实测：拒答 0 积分，同一段提示正常回答约 0.17）。服务器上 10-20 以来渠道 71 有 25 次这样的拒答被扣费，合计约 ¥2.13。
- 写出过内容之后才拒的不变：连接已是 200，以 `stop_reason: refusal` 结束，按 Kiro 数到的用量报。
- 可选 `refusalReply`（`KIRO_REFUSAL_REPLY`，也是供应商设置里的开关「拒答按 Claude 原样返回」）：一个字都没写出就被拒答时，改为按 Anthropic 的样子回 200，不带正文，`stop_reason: refusal`，原因在 `stop_details`（`category` 小写，例如 `bio`），用量全为 0。magpie 先换别的账号，都拒了才原样交给客户端，直连 magpie 的 Claude Code 随即换自己的备用模型。默认关，即上面的 400。给 new-api 当上游的 magpie 保持关，Claude Code 直连的 magpie 打开。
- 更正 custom.13 的说法：还没开始思考就拒答的此前并不是失败状态，而是 200 加 `stop_reason: refusal`，预扣不会退回。
- 测试：开关测试换掉的 `fetch` 在每个测试后还原，后面导入页的测试不再被它截走。

## 0.1.12-custom.14（2026-10-21）

- 可选 `web`（`KIRO_WEB`）：每条消息声明来自 Kiro Web。Kiro 自己加在提示前面的那段更短（Sonnet 4.5 是 740 个 token，kiro-cli 是 4052）。默认关。
- 可选 `dropHidden`（`KIRO_DROP_HIDDEN`）：对外报出的提示 token 去掉 Kiro 自己的那段，先从缓存读到的部分扣，剩下的从全新输入扣。回复不动。默认关，仍按 Kiro 数到的整段提示报。Kiro 没给出上下文大小、只能按调用方请求估算时不扣。没测过的模型不扣。
- 这两个在 magpie 里是该供应商设置中的开关（Kiro Web、去掉 Kiro 自带提示）。拨动后下一个请求生效，不用重启。

## 0.1.12-custom.13（2026-10-20）

- 思考块打开并写出第一段思考后，补一帧 `response.done`。magpie 在还有别的 Kiro 账号可换时，会把只有思考、还没有正文的流压住，外面只看到 `: keepalive`。这一帧被 magpie 当成正文，思考随即按原样往下发。空回复、首字要等几十秒、客户端干等后断开（499）由此解除。
- 这一帧不是 Anthropic 的正文、思考或工具调用。官方客户端不认识 `response.done` 就跳过。new-api 把同一条流转成 OpenAI Chat 时丢掉它，不会多出工具调用或空 chunk。
- 思考已经发出之后若被安全策略拒答，`stop_reason: refusal` 会直接回到客户端，不再换号。此时连接已是 200，new-api 会按已经报出的用量结算。还没开始思考就拒答的，仍按失败状态返回，预扣退回。
