# XpandMax · Chrome Web Store 上架材料

- 商店安装包：运行 `npm run package:store`，输出 `dist/xpandmax-版本号-chrome-web-store.zip`，`manifest.json` 直接位于 ZIP 根目录。
- 图标：`extension/icons/`，包含 16、32、48、128 像素 PNG。
- 宣传图：`promo-440x280.png`。
- 商店文案、权限说明及审核步骤：`listing-zh-CN.txt`。
- 演示截图：`screenshot-feed-1280x800.jpg`、`screenshot-profile-1280x800.jpg`。截图中的账号与数字均为演示数据，页面运行真实插件脚本，不含开发者个人账号内容。

图标与宣传图为原创几何图形，不使用 X 或 Chrome 官方标志。素材重建脚本 `generate_assets.py` 仅在制作素材时需要 Pillow，不是插件运行依赖。

发布前确认隐私政策地址可公开访问、联系邮箱正确、注册/身份与付款步骤完成，并按后台实际字段完成隐私申报。准备好 ZIP 或创建草稿不代表已送审，送审不代表已通过或已上架。


## 0.9.2 更新提交

- 上传包：`dist/xpandmax-0.9.2-chrome-web-store.zip`。
- 沿用已有条目 ID `dckjdeemcnjccfbinnmncalmoajleboo`，不要新建插件。
- 描述、storage 权限理由、隐私处理和测试说明见 `listing-zh-CN.txt`。
- 截图使用上述两张 1280×800 图，均由本版真实资料展示脚本渲染虚构账号。
- 隐私政策：`https://xpandmax.com/privacy/`。显示开关和可选 API 配置（含 Key）保存在本机，不同步至云端；账号资料、关注状态及通知内容不持久化。
- 官方 API 发布命令及首次连接步骤见 [API.md](API.md)。本地打包不代表已经送审，以 API 返回和读回状态为准。
