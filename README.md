# 淘宝库存监控小工具

本机运行的轻量 Web 工具，定时拉取库存数据，当库存低于「近 30 天销量 × 系数」时在看板标红并记报警，预留邮箱 / 微信通知。

## 运行

```bash
cd /workspace
npm install        # 仅首次需要（已装好 express）
npm start          # 启动后访问 http://localhost:3000
```

服务启动即检查一次（保证看板有数据），之后按设置频率（默认 60 分钟）定时检查。

## 功能

- **库存看板**：顶部 4 张概览卡（监控物件总数 / 低于预警线数 / 全局预警系数 / 上次检查时间）+ 低于预警线商品明细表（含「近30天销量」「预警线」列，跌破行标红）；「立即检查」按钮 + 每 30s 自动刷新。
- **预警规则**：`预警线 = 近30天销量 × 系数`。系数默认 1 ⇒ **库存 < 近30天销量即报警**；系数 <1 更宽松、>1 更严格；0 = 关闭预警。
- **设置页**：全局预警系数、检查频率（分钟）、邮箱 / 微信通知地址（无每物件覆盖）。
- **报警去重**：只在「跌破 / 恢复」瞬间记一条报警，恢复时记 `recover`，避免每次检查都刷屏。

## 接入真实 ERP / 运营后台数据

默认用内置 mock 数据。`server.js` 的数据源已做成「配置即切换」：**配了 `ERP_API_URL` 就拉真实数据，没配就回退 mock**，无需改代码（除非 ERP 字段名很特殊）。

### 第 1 步：找到 ERP 页面背后的接口（关键）
ERP「页面上的数据」几乎都来自一个后台 JSON 接口，直接抓页面 DOM 是下策。做法：

1. 打开 ERP 网页，登录到库存/商品列表页。
2. 按 **F12 → Network（网络）→ 刷新页面**。
3. 在请求列表里找返回库存数据的那个 **XHR / Fetch 请求**（看 Response 预览，是一串商品 JSON）。
4. 复制它的 **URL**——这就是 `ERP_API_URL`。

> 9 成情况到这一步就够用了。如果 ERP 没开放接口、只能看网页，再走文末「无接口时」方案。

### 第 2 步：填写 .env
```bash
cd /workspace
cp .env.example .env      # 然后编辑 .env
```
```ini
ERP_API_URL=https://erp.example.com/api/inventory/list
# 鉴权三选一（按你接口要求）：
ERP_TOKEN=xxxxxxxx        # → 请求头 Authorization: Bearer xxxxxxxx
# ERP_API_KEY=xxxx         # → 请求头 X-API-Key: xxxx
# ERP_COOKIE=sessionid=yyy # → 请求头 Cookie: sessionid=yyy（接口需登录态时用）
```

### 第 3 步：字段映射（仅当 ERP 字段名和标准不一致时）
标准物件结构为 `{ id, title, sku, category, warehouse, stock, price, sales30 }`。
`server.js` 的 `buildItemFromErp(row, i)` 已内置常见候选名（如 `stock/qty/inventory/onHand`、`sku/goodsSku/itemCode`）。若你的 ERP 用了别的名字，改这一处的候选名即可，无需动其它代码。

支持的返回结构：直接数组 `[...]`、或 `{ data:[...] }` / `{ list:[...] }` / `{ rows:[...] }` / `{ result:[...] }` / `{ records:[...] }`。

### 快麦(kuaimai / viperp) 实测字段映射
已实测适配快麦 `queryWarehouseStockList` 接口，`buildItemFromErp()` 按以下优先级映射（兼顾通用候选名，换别的 ERP 也多数能直接用）：

| 标准字段 | 快麦字段 | 备注 |
|---|---|---|
| `id` | `itemKey` | 规格属性+规格商家编码 复合主键 |
| `title` | `title` | |
| `sku` | `itemBarcode`（空则 `skuOuterId`）| 条码 / 商家编码 |
| `category` | `itemCategoryNames` | |
| `warehouse` | `warehouseName` | |
| `stock` | `availableStock` | 可用库存；想看实物总库存改 `goodStock` / `totalAvailableStock` |
| `price` | `sellingPrice` | |
| `sales30` | `sale30Days` | 近30天销量；想用日均改 `avgSale30Days` |

返回结构为 `{ clueId, data:{ total, page, list:[...] }, result, suc }`，已实现：
- **分页自动拉全**：默认每页 100，循环翻页直到 `all.length >= total`；并加「相邻页首元素相同即停止」的防死循环（防止接口忽略分页参数时卡死）。
- **登录态失效识别**：`suc === false` 或 `result === 0` 时主动报错提示重新抓 Cookie。

> ⚠️ **「近30天销量」全为 0 时不报警**：若所连店铺为测试/沙箱账号（标题如"测试2""菜鸟测试"），`sale30Days` 多返回 0，按规则「库存 < 近30天销量」算出的预警线为 0，看板会显示提示横幅且不报警。这是数据本身特征，正式店铺一般有值。若想在销量缺失时仍报警，可在 `server.js` 将 `sales30` 的取数改为固定阈值或其它口径（如平均库存可售天数）。

### 第 4 步：重启验证
```bash
npm start
```
打开 `http://localhost:3000` → 点「立即检查」→ 看板即显示真实库存；若拉取失败会自动回退 mock 并在日志打印原因。

### 无接口、只能看网页时（兜底方案）
若 ERP 完全没有可用接口，需在服务端用无头浏览器登录并读页面：
1. 安装 puppeteer：`npm install puppeteer`（会自动下载 Chromium）。
2. 在 `server.js` 新增一个 `fetchFromErp()` 的浏览器版：用 `puppeteer.launch()` 登录 → 跳库存页 → `page.evaluate` 抓取表格 → 整理成标准结构返回。
3. 把 `getInventorySource()` 里 `fetchFromErp()` 换成这个浏览器版。

> 此方案较重且受 ERP 反爬/改版影响，建议优先用上面的接口方式。


## 启用通知（演示阶段默认仅打印日志）

- **微信**：设置页填 PushPlus token 或 Server酱 key（以 `sctp` 开头识别为 Server酱）。
- **邮箱**：设置页填收件地址；另需在启动环境配置 `SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_FROM`（未配置则跳过真实发送）。

通知仅在状态变化时触发，且报警 / 恢复都会重报，按物件去重。