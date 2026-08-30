# 域名与 NameSilo 无推广说明

域名入口必须按以下顺序展示，使用相同组件、字号、按钮尺寸、颜色层级和可点击面积；任何一个都不预选、不加倒计时或“最佳”徽章：

<!-- domain-paths:start -->
1. I already have a domain
2. Use any registrar
3. NameSilo — No referral
<!-- domain-paths:end -->

以上三项保留界面英文原文；其中文含义依次为“我已有域名”“使用任意注册商”和“NameSilo（无推广）”。核心 Setup、Cloudflare、27 tools 与支持质量不依赖任何选择。ToolSpan 不自动打开链接、复制 coupon、应用 coupon、注册、登录、购买、支付、下单或发送点击遥测。

超过 30 天自动隐藏所有具体价格、折扣、合计数字和 coupon CTA；当前官方来源不能证明数字仍然有效时，也执行同一 `STALE_FALLBACK`，显示“查看当前结账页”。不能只换一个“可能过期”标签却继续展示数字。

ToolSpan 当前不展示任何 referral/推广路径；NameSilo 只通过无推广链接提供。若未来重新引入推荐链接，必须先恢复对应商业声明与当前性验证。

## NameSilo 无推广路径（NameSilo — No referral）

<!-- namesilo-direct:start -->
这条路径不带 `rid`，不显示、复制或使用 affiliate coupon：

- 主页（Home）：<https://www.namesilo.com/>
- 搜索（Search）：<https://www.namesilo.com/domain/search-domains>
- 价格（Pricing）：<https://www.namesilo.com/pricing>
<!-- namesilo-direct:end -->

不得通过 redirect、local storage 或不可见参数重新添加 attribution（归因信息）。

## 供应商资产（Vendor 资产）

<!-- vendor-fallback:start -->
`TEXT_ONLY_FALLBACK`：默认只显示纯文字 NameSilo 卡片。只有 maintainer-supplied archive、selected asset SHA-256 和权利确认全部通过时，才可发布 manifest 允许的最小 Logo 集；字体、EPS 和未选择的批量营销素材一律不导入。资产缺失、哈希不匹配或授权未确认时隐藏 Logo/Banner，并保持 `FALLBACK_PASS`。
<!-- vendor-fallback:end -->

纯文字 fallback 不代表 NameSilo 认可、赞助或背书 ToolSpan。外部资产 gate 可保持 `EXTERNAL_GATE_PENDING`，不得阻塞非商业 Setup source。
