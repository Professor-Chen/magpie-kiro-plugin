# 更新记录

[English](README.en.md) · [简体中文](README.md)

## 0.1.12-custom.14（2026-10-21）

- 可选 `web`（`KIRO_WEB`）：每条消息声明来自 Kiro Web。Kiro 自己加在提示前面的那段更短（Sonnet 4.5 是 740 个 token，kiro-cli 是 4052）。默认关。
- 可选 `dropHidden`（`KIRO_DROP_HIDDEN`）：对外报出的提示 token 去掉 Kiro 自己的那段，先从缓存读到的部分扣，剩下的从全新输入扣。回复不动。默认关，仍按 Kiro 数到的整段提示报。Kiro 没给出上下文大小、只能按调用方请求估算时不扣。没测过的模型不扣。
- 这两个在 magpie 里是该供应商设置中的开关（Kiro Web、去掉 Kiro 自带提示）。拨动后下一个请求生效，不用重启。

## 0.1.12-custom.13（2026-10-20）

- 思考块打开并写出第一段思考后，补一帧 `response.done`。magpie 在还有别的 Kiro 账号可换时，会把只有思考、还没有正文的流压住，外面只看到 `: keepalive`。这一帧被 magpie 当成正文，思考随即按原样往下发。空回复、首字要等几十秒、客户端干等后断开（499）由此解除。
- 这一帧不是 Anthropic 的正文、思考或工具调用。官方客户端不认识 `response.done` 就跳过。new-api 把同一条流转成 OpenAI Chat 时丢掉它，不会多出工具调用或空 chunk。
- 思考已经发出之后若被安全策略拒答，`stop_reason: refusal` 会直接回到客户端，不再换号。此时连接已是 200，new-api 会按已经报出的用量结算。还没开始思考就拒答的，仍按失败状态返回，预扣退回。
