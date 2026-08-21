'use strict';

/**
 * 淘宝库存监控小工具 —— 后端服务 (Node + Express)
 *
 * 数据流：
 *   调度器(setInterval) 或 「立即检查」按钮
 *     → checkNow() 拉取库存(真实 ERP / 回退 mock) → 计算每物件预警线(近30天销量×系数) → 与库存比较
 *     → 仅状态变化才记报警(去重防刷屏) → (可选)发通知 → 写 store.json → 前端轮询展示
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

// 零依赖读取 .env（没有 .env 文件就忽略；已存在的环境变量优先）
try {
  const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (e) { /* 无 .env 文件，使用系统环境变量 */ }

const STORE_PATH = path.join(__dirname, 'store.json');
const PORT = process.env.PORT || 3000;

const DEFAULT_STORE = {
  globalFactor: 1,           // 全局预警系数：库存 < 近30天销量 × 系数 即报警（默认 1 = 低于30天销量即警告）
  frequencyMinutes: 60,      // 检查频率（分钟）
  notifications: { email: '', wechat: '' }, // 通知地址（空 = 不发送）
  itemFactors: {},           // 每物件系数覆盖：{ "P003": 1.2 }
  alerts: [],                // 报警事件
  lastCheck: null,           // 上次检查时间戳
  belowState: {},            // 各物件当前是否低于预警线：{ "P001": true }
  lastInventory: []          // 最近一次库存快照
};

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return {
      ...DEFAULT_STORE,
      ...parsed,
      notifications: { ...DEFAULT_STORE.notifications, ...(parsed.notifications || {}) },
      itemFactors: { ...(parsed.itemFactors || {}) },
      belowState: { ...(parsed.belowState || {}) },
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
      lastInventory: Array.isArray(parsed.lastInventory) ? parsed.lastInventory : []
    };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_STORE));
  }
}

function writeStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

/* ----------------------------- Mock 数据源 ----------------------------- */
// 格式: [title, category, warehouse, stock]
const PRODUCTS = [
  ['纯棉短袖T恤 夏季新款', '女装', '杭州仓', 185],
  ['宽松休闲裤 直筒', '男装', '广州仓', 320],
  ['蓝牙耳机 入耳式', '数码', '北京仓', 76],
  ['保温杯 316不锈钢', '家居', '杭州仓', 540],
  ['口红 哑光丝绒', '美妆', '广州仓', 132],
  ['坚果零食大礼包', '食品', '北京仓', 88],
  ['真丝睡衣 两件装', '女装', '杭州仓', 210],
  ['运动卫衣 加绒', '男装', '广州仓', 45],
  ['机械键盘 87键', '数码', '北京仓', 260],
  ['北欧风台灯', '家居', '杭州仓', 175],
  ['保湿面霜 50ml', '美妆', '广州仓', 390],
  ['手冲咖啡豆 500g', '食品', '北京仓', 120],
  ['雪纺连衣裙', '女装', '杭州仓', 230],
  ['牛仔外套 复古', '男装', '广州仓', 95],
  ['智能手环', '数码', '北京仓', 410],
  ['收纳箱 大号', '家居', '杭州仓', 60],
  ['防晒喷雾 SPF50', '美妆', '广州仓', 280],
  ['冻干水果脆', '食品', '北京仓', 150],
  ['针织开衫', '女装', '杭州仓', 330],
  ['帆布鞋 经典款', '男装', '广州仓', 70],
  ['移动电源 20000mAh', '数码', '北京仓', 240],
  ['香薰蜡烛 礼盒', '家居', '杭州仓', 190],
  ['精华液 30ml', '美妆', '广州仓', 460],
  ['每日坚果 30包', '食品', '北京仓', 200]
];

// 由 PRODUCTS 生成标准物件 { id, sku, title, category, warehouse, stock, price, sales30 }
const BASE = PRODUCTS.map((p, i) => ({
  id: 'P' + String(i + 1).padStart(3, '0'),
  sku: 'SKU' + String(i + 1).padStart(4, '0'),
  title: p[0],
  category: p[1],
  warehouse: p[2],
  stock: p[3],
  price: Math.round(29 + ((i * 37) % 470) + ((i * 7) % 40)),
  sales30: 50 + ((i * 53) % 900)
}));

// 演示用：围绕基准库存做 ±2% 随机抖动，模拟真实库存波动（首次启动即有多个 <200 物件）
function mockFetchSource() {
  return BASE.map(b => {
    const jitter = 1 + (Math.random() - 0.5) * 0.04;
    const stock = Math.max(0, Math.round(b.stock * jitter));
    return { ...b, stock };
  });
}

/* ============ 真实 ERP 数据源（可配置；未配置时回退 mock） ============
   接入步骤：
   1) 打开 ERP 网页 → F12 → Network → 刷新库存页 → 找到返回库存列表的那个 XHR/接口（通常是 JSON）
   2) 把它的 URL 填到 .env 的 ERP_API_URL
   3) 若接口需要登录态/token：ERP_TOKEN(Bearer) / ERP_API_KEY(X-API-Key) / ERP_COOKIE(Cookie)
   4) 在下方 buildItemFromErp() 把 ERP 字段映射到标准结构
      { id, title, sku, category, warehouse, stock, price, sales30 }
   5) 重启 server.js，看板即显示真实数据
   ==================================================================== */

// 把 ERP 一行记录映射成标准物件。
// 已按「快麦(kuaimai/viperp)」真实字段优先命名（itemKey / title / itemBarcode /
// itemCategoryNames / warehouseName / availableStock / sellingPrice / sale30Days），
// 后面仍保留常见通用候选名，换别的 ERP 时无需大改。
function buildItemFromErp(row, i) {
  const pick = (...keys) => {
    for (const k of keys) { if (row[k] != null && row[k] !== '') return row[k]; }
    return undefined;
  };
  return {
    id: String(pick('itemKey', 'sysItemId', 'id', 'goodsId', 'productId', 'itemId') || ('P' + String(i + 1).padStart(3, '0'))),
    sku: String(pick('itemBarcode', 'skuOuterId', 'outerId', 'sku', 'SKU', 'goodsSku', 'itemCode', 'code') || ('SKU' + String(i + 1).padStart(4, '0'))),
    title: String(pick('propertiesName', 'title', 'itemName', 'goodsName', 'name', 'productName') || ('商品' + (i + 1))),
    category: String(pick('itemCategoryNames', 'itemCategoryName', 'category', 'cat', 'className', 'cateName') || '未分类'),
    warehouse: String(pick('warehouseName', 'warehouse', 'wh', 'depot', 'storage', 'storeName') || '默认仓'),
    // 库存：映射为 sellableNum（可卖数）；无此字段时回退 availableStock 等通用候选
    stock: Number(pick('sellableNum', 'availableStock', 'availableInStock', 'goodStock', 'totalAvailableStock', 'stock', 'qty', 'inventory', 'onHand', 'kc', 'num') || 0),
    price: Number(pick('sellingPrice', 'salePrice', 'price', 'wholesalePrice', 'cost', 'priceNow') || 0),
    // 近30天销量：快麦字段为 sale30Days；若想用「日均」改 avgSale30Days
    sales30: Number(pick('sale30Days', 'sale30', 'sold30', 'salesLast30', 'saleNum30') || 0)
  };
}

// 从 ERP 返回里尽量提取「商品数组」，兼容各种包装结构
function extractArray(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return null;
  // 常见的一级 / 二级路径
  const paths = [
    json.data, json.list, json.rows, json.result, json.records, json.datas, json.items, json.content,
    json.data && json.data.list, json.data && json.data.records, json.data && json.data.rows, json.data && json.data.items,
    json.content && json.content.list, json.content && json.content.records,
    json.result && json.result.list, json.result && json.result.records
  ];
  for (const c of paths) if (Array.isArray(c) && c.length) return c;
  // 兜底：深度优先找第一个「元素为对象的非空数组」
  const stack = [json], seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const v of Object.values(node)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

// 用「商品关系信息」接口补真实销量：warehouseStockList 的 sale30Days 恒为 0，
// 而网页的“30天销量”来自 stock_queryItemRelationInfo（按 sysItemId:sysSkuId:warehouseId 关联）。
// rows 为库存列表原始行（需含 sysItemId / sysSkuId / wareHouseId），本函数把真实 sale30Days 写回 row。
async function fetchRelationSales(rows) {
  const base = process.env.ERP_API_URL || '';
  const url = process.env.ERP_RELATION_URL ||
    base.replace(/\/stock\/query\/warehouseStockList$/, '/stock/queryItemRelationInfo');
  if (!url || url === base) return; // 推导不出地址就跳过（沿用库存接口的 0 销量）

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0',
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  if (process.env.ERP_TOKEN) headers['Authorization'] = `Bearer ${process.env.ERP_TOKEN}`;
  if (process.env.ERP_API_KEY) headers['X-API-Key'] = process.env.ERP_API_KEY;
  if (process.env.ERP_COOKIE) headers['Cookie'] = process.env.ERP_COOKIE;

  const items = rows
    .map(r => {
      const sysItemId = r.sysItemId;
      const sysSkuId = r.sysSkuId;
      const wh = r.wareHouseId || r.warehouseId;
      return { key: `${sysItemId}:${sysSkuId}:${wh}`, sysItemId, sysSkuId, wh, row: r };
    })
    .filter(x => x.sysItemId != null && x.sysSkuId != null && x.wh != null);
  if (!items.length) return;

  const map = new Map();
  const CHUNK = 200; // 分批，避免单次请求体过大
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    const body = new URLSearchParams({
      api_name: 'stock_queryItemRelationInfo',
      wareHouseEdition: 'true',
      flag: '0',
      itemIds: JSON.stringify(slice.map(x => x.key)),
      relationInfoFields: 'sale1Days,sale30Days,availableDay'
    }).toString();
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.error('[销量接口] HTTP', res.status); continue; }
    const json = await res.json();
    if (json && json.suc === false) { console.error('[销量接口] suc=false（登录态可能失效）'); continue; }
    const arr = Array.isArray(json.data) ? json.data : [];
    arr.forEach(rel => {
      if (rel && rel.sysItemId != null)
        map.set(`${rel.sysItemId}:${rel.sysSkuId}:${rel.wareHouseId}`, rel);
    });
  }

  // 把真实销量写回原始行（覆盖 warehouseStockList 里恒为 0 的 sale30Days）
  items.forEach(x => {
    const rel = map.get(x.key);
    if (rel) {
      x.row.sale30Days = Number(rel.sale30Days) || 0;
      x.row.sale1Days = Number(rel.sale1Days) || 0;
      x.row.sale7Days = Number(rel.sale7Days) || 0;
      x.row.avgSale30Days = Number(rel.avgSale30Days) || 0;
    }
  });
  console.log(`[销量补充] 成功匹配 ${map.size}/${items.length} 条真实销量`);
}

// 拉取当前筛选条件下的库存总条数（queryWarehouseStockCount 只返回 { data:{ total } }）。
// 用途：列表接口的 data.total 其实是「本页条数」而非总数，不能用它判断翻没翻完；
//      先用本接口拿真实总数，再精确计算需要翻几页。
// 消融实测：必须参数只有 api_name + cId（缺 cId 会回退默认测试店），且必须表单格式；
//          warehouseIds 在此带上以保持与列表口径一致，其余空过滤器可全部省略。
async function fetchErpCount(headers, cid, warehouseIds) {
  const base = process.env.ERP_API_URL || '';
  const url = process.env.ERP_COUNT_URL ||
    base.replace(/\/stock\/query\/warehouseStockList$/, '/stock/queryWarehouseStockCount');
  if (!url || url === base) return null; // 推导不出地址就放弃（调用方回退逐页翻完策略）

  try {
    const body = new URLSearchParams({
      api_name: 'stock_queryWarehouseStockCount',
      cId: cid,
      warehouseIds: warehouseIds,
      pageNo: 1,
      pageSize: 1
    }).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.suc === false) throw new Error('suc=false');
    const total = json && json.data && Number(json.data.total);
    if (!Number.isFinite(total) || total < 0) throw new Error('返回中无有效 total');
    return total;
  } catch (e) {
    console.error('[总数探测] 失败，改用逐页翻完策略：', e.message);
    return null;
  }
}

async function fetchFromErp() {
  const url = process.env.ERP_API_URL;
  if (!url) return null; // 未配置 → 调用方回退 mock
  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0',
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (process.env.ERP_TOKEN) headers['Authorization'] = `Bearer ${process.env.ERP_TOKEN}`;
  if (process.env.ERP_API_KEY) headers['X-API-Key'] = process.env.ERP_API_KEY;
  if (process.env.ERP_COOKIE) headers['Cookie'] = process.env.ERP_COOKIE;

  const method = (process.env.ERP_METHOD || 'POST').toUpperCase();
  const pageSize = Math.min(500, Math.max(1, Number(process.env.ERP_PAGE_SIZE) || 500));
  const cap = 200; // 安全阀：最多翻 200 页，避免接口无视分页参数时死循环

  // 快麦 warehouseStockList 真实请求参数（来自网页 Network 抓包）。
  // 关键：cId = 公司/店铺 ID，必须带，否则接口回退默认(测试)店铺；
  //       warehouseIds 限定仓库（留空=全部）。其余多为空过滤器，照原样带着以贴合真实请求。
  // 重要：该接口只认 application/x-www-form-urlencoded，发 JSON 时 cId 会被直接忽略！
  const cid = process.env.ERP_CID || '';
  // 仓库固定为 116959（义乌大货仓）：.env 未配置或留空时也强制使用该仓库，防止误拉全部仓库
  const warehouseIds = process.env.ERP_WAREHOUSE_IDS || '116959';
  const baseParams = {
    api_name: 'stock_query_warehouseStockList',
    autoUpload: '', catIds: '', brands: '',
    cId: cid,
    flag: 0,
    mainOuterId: '', skuOuterId: '', stockLabelIds: '', stockStatuses: '',
    supplierIds: '', tileSupplierItemOuterId: '', tilePropertiesName: '',
    warehouseIds: warehouseIds,
    warnStatuses: '',
    minTotalAvailableStock: '', maxTotalAvailableStock: '',
    minTotalAvailableStockSum: '', maxTotalAvailableStockSum: '',
    minAvailableStock: '', maxAvailableStock: '',
    minAvailableStockSum: '', maxAvailableStockSum: '',
    minLockStock: '', maxLockStock: '',
    minStockWarnDiff: '', maxStockWarnDiff: '',
    minDefectiveStock: '', maxDefectiveStock: '',
    minVirtualStock: '', maxVirtualStock: '',
    minPurchaseNum: '', maxPurchaseNum: '',
    skuLevelStockWarnDiff: true,
    activeStatus: '', text: '',
    queryType: 'itemName', searchType: 0,
    itemTagIds: '', tagQueryType: 0,
    selectedItems: '', userId: -1,
    shipper: '', skuBrands: ''
  };

  // 先用 count 接口拿真实总条数（列表接口的 data.total 是「本页条数」，不能作为翻页依据）
  const totalCount = await fetchErpCount(headers, cid, warehouseIds);
  const maxPages = totalCount != null ? Math.max(1, Math.ceil(totalCount / pageSize)) : cap;
  if (totalCount != null) {
    console.log(`[总数探测] 共 ${totalCount} 条，计划翻 ${Math.min(maxPages, cap)} 页（每页 ${pageSize}）`);
  }

  const all = [];
  let pageNo = 1;
  let lastFirstKey = null;
  while (pageNo <= Math.min(maxPages, cap)) {
    let reqUrl = url, body, reqHeaders = { ...headers };
    if (method === 'POST') {
      const params = { ...baseParams, pageNo, pageSize };
      reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      body = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    } else {
      reqUrl = url + (url.includes('?') ? '&' : '?') + `pageNo=${pageNo}&pageSize=${pageSize}`;
    }
    const res = await fetch(reqUrl, { method, headers: reqHeaders, body, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`ERP 接口返回 HTTP ${res.status}`);
    const json = await res.json();
    // 快麦：{ suc:true, result:1, data:{ total, list:[...] } }；suc=false/result=0 视为登录态失效
    if (json && json.suc === false) throw new Error('ERP 返回 suc=false（登录态可能失效，请重新抓取 Cookie）');
    if (json && json.result === 0) throw new Error('ERP 返回 result=0（接口调用失败，请检查参数/登录态）');

    const arr = (json && json.data && Array.isArray(json.data.list))
      ? json.data.list
      : extractArray(json);
    if (!arr || !arr.length) break;

    // 防死循环：若分页参数被服务端忽略，相邻两页首元素相同即停止
    const firstKey = (arr[0] && (arr[0].itemKey || arr[0].id)) || null;
    if (pageNo > 1 && firstKey === lastFirstKey) break;
    all.push(...arr);
    lastFirstKey = firstKey;

    if (totalCount != null) {
      if (all.length >= totalCount) break; // 已拉满 count 接口报告的总数
    } else {
      if (arr.length < pageSize) break; // 无总数兜底：不满一页视为最后一页
    }
    pageNo++;
  }
  if (totalCount != null && all.length !== totalCount) {
    console.warn(`[对账] count 报告 ${totalCount} 条，实际拉到 ${all.length} 条（数据可能在查询瞬间变动）`);
  }
  if (!all.length) throw new Error('ERP 返回空列表');
  // 用关系接口补真实销量（warehouseStockList 的 sale30Days 恒为 0，真实销量在 queryItemRelationInfo）
  try {
    await fetchRelationSales(all);
  } catch (e) {
    console.error('[销量补充] 失败，沿用库存接口销量(可能全0)：', e.message);
  }
  return all.map(buildItemFromErp);
}

// 优先用真实 ERP；拉取失败/未配置时回退 mock，保证看板始终有数据
async function getInventorySource() {
  try {
    const real = await fetchFromErp();
    if (real && real.length) return real;
  } catch (e) {
    console.error('[数据源] 真实 ERP 拉取失败，本次回退 mock：', e.message);
  }
  return mockFetchSource();
}

/* ----------------------------- 通知模块 ----------------------------- */
// 演示阶段 notifications 为空 → 仅打印日志；配置后真实发送（报警才发、恢复重报、去重防刷屏）
async function sendWechat(token, title, content) {
  try {
    if (token.startsWith('sctp')) {
      // Server酱：https://sct.ftqq.com
      await fetch(`https://sctapi.ftqq.com/${token}.send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(content)}`
      });
    } else {
      // PushPlus：https://www.pushplus.plus
      await fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, title, content, template: 'html' })
      });
    }
  } catch (e) {
    console.error('[微信通知失败]', e.message);
  }
}

async function sendEmail(to, title, content) {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_PORT } = process.env;
  if (!SMTP_HOST || !SMTP_USER) {
    console.log('[邮箱通知] 未配置 SMTP_* 环境变量，跳过真实发送');
    return;
  }
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 465),
      secure: true,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    await transporter.sendMail({
      from: SMTP_FROM || SMTP_USER,
      to,
      subject: title,
      text: content
    });
    console.log('[邮箱通知] 已发送至', to);
  } catch (e) {
    console.error('[邮箱通知失败]', e.message);
  }
}

async function notify(alert) {
  const store = readStore();
  const n = store.notifications || {};
  const title = alert.type === 'alert' ? '⚠️ 库存预警' : '✅ 库存恢复';
  const content =
    `${alert.title}（${alert.sku} @ ${alert.warehouse}）<br>` +
    `当前库存：<b>${alert.stock}</b><br>预警线(近30天销量×系数)：${alert.warnLine}`;
  if (n.email) await sendEmail(n.email, title, content);
  if (n.wechat) await sendWechat(n.wechat, title, content);
}

/* ----------------------------- 核心：检查一次 ----------------------------- */
// 注意：状态变化去重 —— 只在「跌破 / 恢复」的瞬间记一条报警，避免每次检查都刷屏
async function checkNow() {
  const store = readStore();
  const raw = await getInventorySource(); // 配置了 ERP_API_URL 拉真实数据，否则回退 mock
  const inventory = raw.map(it => {
    // 预警线 = 近30天销量 × 系数（默认系数 1 → 库存 < 近30天销量 即警告）
    // 优先单品覆盖系数，否则用全局系数；任何非法值回退默认 1，避免 warnLine 变成 NaN
    const rawFactor = (store.itemFactors[it.id] != null)
      ? store.itemFactors[it.id]
      : store.globalFactor;
    const factor = (Number.isFinite(Number(rawFactor)) && Number(rawFactor) >= 0)
      ? Number(rawFactor)
      : DEFAULT_STORE.globalFactor;
    const warnLine = Math.max(0, Math.round(it.sales30 * factor));
    return { ...it, factor, warnLine, below: it.stock < warnLine };
  });

  const newAlerts = [];
  inventory.forEach(it => {
    const wasBelow = !!store.belowState[it.id];
    if (it.below && !wasBelow)
      newAlerts.push({
        itemId: it.id, title: it.title, sku: it.sku, warehouse: it.warehouse,
        stock: it.stock, warnLine: it.warnLine, type: 'alert', time: Date.now()
      });
    else if (!it.below && wasBelow)
      newAlerts.push({
        itemId: it.id, title: it.title, sku: it.sku, warehouse: it.warehouse,
        stock: it.stock, warnLine: it.warnLine, type: 'recover', time: Date.now()
      });
  });

  store.alerts = [...newAlerts, ...store.alerts].slice(0, 200);
  store.belowState = {};
  inventory.forEach(it => { store.belowState[it.id] = it.below; });
  store.lastInventory = inventory;
  store.lastCheck = Date.now();
  writeStore(store);

  // 通知：演示阶段 notifications 为空，仅打印日志；接好后在此真实发送
  newAlerts.filter(a => a.type === 'alert').forEach(a => {
    console.log(`[模拟通知] ${a.title} 库存 ${a.stock} 低于预警线 ${a.warnLine}（近30天销量 × 系数）`);
  });
  // 异步发通知（不阻塞主流程），仅状态变化时触发
  newAlerts.forEach(a => { notify(a).catch(e => console.error('[通知失败]', e.message)); });

  return { inventory, newAlerts };
}

/* ----------------------------- Express API ----------------------------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 库存看板数据
app.get('/api/inventory', (req, res) => {
  const store = readStore();
  const inventory = store.lastInventory || [];
  res.json({
    inventory,
    lastCheck: store.lastCheck,
    globalFactor: store.globalFactor,
    belowCount: inventory.filter(it => it.below).length
  });
});

// 报警记录
app.get('/api/alerts', (req, res) => {
  const store = readStore();
  res.json({ alerts: store.alerts });
});

// 立即检查一次
app.post('/api/check-now', async (req, res) => {
  try {
    const { newAlerts } = await checkNow();
    res.json({ ok: true, newAlerts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 读取设置
app.get('/api/settings', (req, res) => {
  const store = readStore();
  res.json({
    globalFactor: store.globalFactor,
    frequencyMinutes: store.frequencyMinutes,
    notifications: store.notifications,
    itemFactors: store.itemFactors
  });
});

// 保存设置（预警系数/频率/通知/每物件系数），频率变化时重建调度
app.post('/api/settings', (req, res) => {
  try {
    const store = readStore();
    const body = req.body || {};

    // 预警系数：显式空值/非法 → 回退默认 1；只有合法非负数才生效（0 = 主动关闭预警）
    // 关键：空的数字输入框经 Number('') 会变成 0，必须先把空/Null 单独判掉，否则“看似没生效”
    if (body.globalFactor !== undefined) {
      if (body.globalFactor === '' || body.globalFactor == null) {
        store.globalFactor = DEFAULT_STORE.globalFactor;
      } else {
        const g = Number(body.globalFactor);
        store.globalFactor = Number.isFinite(g) && g >= 0 ? g : DEFAULT_STORE.globalFactor;
      }
    }
    if (body.frequencyMinutes !== undefined) {
      if (body.frequencyMinutes === '' || body.frequencyMinutes == null) {
        store.frequencyMinutes = 60;
      } else {
        const f = Number(body.frequencyMinutes);
        store.frequencyMinutes = Number.isFinite(f) && f >= 1 ? f : 60;
      }
    }
    if (body.notifications) store.notifications = { ...store.notifications, ...body.notifications };
    writeStore(store);
    checkNow();      // 立即应用新预警线
    startScheduler(); // 频率变化则重建调度
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------- 定时调度 ----------------------------- */
let timer = null;
function startScheduler() {
  if (timer) clearInterval(timer);
  const store = readStore();
  const ms = (store.frequencyMinutes || 60) * 60 * 1000;
  timer = setInterval(() => {
    checkNow().catch(e => console.error('[定时检查失败]', e));
  }, ms);
  console.log(`[调度] 已启动，每 ${store.frequencyMinutes} 分钟检查一次`);
}

app.listen(PORT, () => {
  console.log(`淘宝库存监控已启动： http://localhost:${PORT}`);
  checkNow().catch(e => console.error('[启动检查失败]', e));       // 启动即检查一次，保证看板有数据
  startScheduler();
});