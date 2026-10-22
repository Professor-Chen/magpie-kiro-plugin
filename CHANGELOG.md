# 更新记录

[English](README.en.md) · [简体中文](README.md)

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
