# 域名与 NameSilo 透明推荐

域名入口必须按以下顺序展示，使用相同组件、字号、按钮尺寸、颜色层级和可点击面积；任何一个都不预选、不加倒计时或“最佳”徽章：

<!-- domain-paths:start -->
1. I already have a domain
2. Use any registrar
3. NameSilo — Support ToolSpan
4. NameSilo — No referral
<!-- domain-paths:end -->

核心 Setup、Cloudflare、27 tools 与支持质量不依赖任何选择。ToolSpan 不自动打开链接、复制 coupon、应用 coupon、注册、登录、购买、支付、下单或发送点击遥测。

## NameSilo — Support ToolSpan

<!-- namesilo-disclosure:start -->
披露：下面的链接包含 NameSilo referral ID；若你通过它购买，ToolSpan 项目可能获得佣金，你的核心功能和支持不受影响。Affiliate-only Coupon `toolspan` 的使用也可能产生 attribution；资格、首年价格、续费、premium domain、税费、结账总额以及与 Discount Program 能否同时使用，均以结账页和当前条款为准。

- Home: <https://www.namesilo.com/?rid=1373371gm>
- Search: <https://www.namesilo.com/domain/search-domains?rid=1373371gm>
- Pricing: <https://www.namesilo.com/pricing?rid=1373371gm>
<!-- namesilo-disclosure:end -->

只有当 `config/namesilo-offer.snapshot.json` 在 30 天 freshness window 内、`verificationStatus=OFFICIAL_SOURCES_VERIFIED` 且没有 verification gap 时，UI 才可从 snapshot 渲染条件化首年示例与 coupon CTA。超过 30 天自动隐藏所有具体价格、折扣、合计数字和 coupon CTA；当前官方来源不能证明 affiliate ID/coupon 当前性时也执行同一 `STALE_FALLBACK`，显示“查看当前结账页”。不能只换一个“可能过期”标签却继续展示数字。

## NameSilo — No referral

<!-- namesilo-direct:start -->
这条路径不带 `rid`，不显示、复制或使用 affiliate coupon：

- Home: <https://www.namesilo.com/>
- Search: <https://www.namesilo.com/domain/search-domains>
- Pricing: <https://www.namesilo.com/pricing>
<!-- namesilo-direct:end -->

两条 NameSilo 路径在视觉权重和功能上相等。切换到 no-referral 时必须丢弃 referral URL 与 coupon state；不得用 redirect、local storage 或不可见参数重新添加 attribution。

## Vendor 资产

<!-- vendor-fallback:start -->
`TEXT_ONLY_FALLBACK`：默认只显示纯文字 NameSilo 卡片。只有 maintainer-supplied archive、selected asset SHA-256 和权利确认全部通过时，才可发布 manifest 允许的最小 Logo 集；字体、EPS 和未选择的批量营销素材一律不导入。资产缺失、哈希不匹配或授权未确认时隐藏 Logo/Banner，并保持 `FALLBACK_PASS`。
<!-- vendor-fallback:end -->

文字 fallback 不代表 NameSilo 认可、赞助或背书 ToolSpan。外部资产 gate 可保持 `EXTERNAL_GATE_PENDING`，不得阻塞非商业 Setup source。
