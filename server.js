'use strict';

/**
 * 淘宝库存监控小工具 —— 后端服务 (Node + Express)
 *
 * 数据流：
 *   调度器(setInterval) 或 「立即检查」按钮
 *     → checkNow() 拉取库存(仅真实 ERP) → 计算每物件预警线(近30天销量×系数) → 与库存比较
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
  source: 'erp',             // 最近一次数据源：'erp' 真实 / 'error' 拉取失败
  lastError: '',             // 最近一次拉取失败原因（用于前端提示；空=正常）
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

/* ----------------------------- 数据源说明 ----------------------------- */
// 本工具只使用真实 ERP 接口数据（见下方 buildItemFromErp / fetchFromErp）。
// 真实拉取失败时不会回退任何模拟/演示数据，前端会明确提示「拉取失败」错误。

/* ============ 真实 ERP 数据源（仅真实数据；拉取失败不再回退任何模拟数据） ============
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
    // 是否「在售」：快麦 activeStatus=1 为在售；用于「仅看有销量的在售品」过滤
    active: Number(pick('activeStatus', 'saleStatus', 'itemStatus', 'status') || 0) === 1,
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
  if (!url) throw new Error('未配置 ERP_API_URL，无法获取真实数据。请在 .env 配置真实 ERP 接口地址后重启 server.js');
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
    if (json && json.result === 901) throw new Error('Cookie 已过期（会话异常，请重新登录），请重新抓取 ERP_COOKIE 到 .env 并重启 server.js');
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

// 只返回真实 ERP 数据；任何失败都返回 error（不回退任何模拟数据）
async function getInventorySource() {
  try {
    const data = await fetchFromErp();
    if (!data || !data.length) throw new Error('ERP 未返回任何库存数据');
    return { data, error: null };
  } catch (e) {
    console.error('[数据源] 真实 ERP 拉取失败：', e.message);
    return { data: null, error: e.message };
  }
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
  const src = await getInventorySource();
  // 真实拉取失败：保留上一次成功快照（不写入任何模拟数据），仅记录错误供前端提示
  if (src.error || !src.data || !src.data.length) {
    store.source = 'error';
    store.lastError = src.error || 'ERP 未返回任何库存数据';
    writeStore(store);
    throw new Error(store.lastError);
  }
  store.source = 'erp';
  store.lastError = '';
  const raw = src.data; // 仅真实 ERP 数据
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

  // 监控「状态变化」：与上次检查快照对比，分类记录（去重防刷屏）
  const newChanges = [];
  const prevById = {};
  (store.lastInventory || []).forEach(p => { prevById[p.id] = p; });

  inventory.forEach(it => {
    const wasBelow = !!store.belowState[it.id];
    const prev = prevById[it.id];
    // 1) 预警状态：跌破预警线 / 恢复
    if (it.below && !wasBelow)
      newChanges.push({
        itemId: it.id, title: it.title, sku: it.sku, warehouse: it.warehouse,
        stock: it.stock, warnLine: it.warnLine, type: 'alert', time: Date.now()
      });
    else if (!it.below && wasBelow)
      newChanges.push({
        itemId: it.id, title: it.title, sku: it.sku, warehouse: it.warehouse,
        stock: it.stock, warnLine: it.warnLine, type: 'recover', time: Date.now()
      });
    // 2) 库存数量变化（首次检查无快照不记，避免启动即刷屏）
    if (prev && Number(prev.stock) !== Number(it.stock))
      newChanges.push({
        itemId: it.id, title: it.title, sku: it.sku, warehouse: it.warehouse,
        // 强制取 warnLine：优先用它自身已计算的值；fallback 到实时算（防丢失）
        warnLine: (it.warnLine != null) ? it.warnLine : Math.max(0, Math.round(it.sales30 * (store.globalFactor || 1))),
        type: 'stock_change', from: Number(prev.stock), to: Number(it.stock), time: Date.now()
      });
  });

  store.alerts = [...newChanges, ...store.alerts].slice(0, 500);
  store.belowState = {};
  inventory.forEach(it => { store.belowState[it.id] = it.below; });
  store.lastInventory = inventory;
  store.lastCheck = Date.now();
  writeStore(store);

  // 通知：仅「跌破预警线 / 恢复」触发（库存变动不发）；演示阶段 notifications 为空 → 仅打印日志
  newChanges.filter(a => a.type === 'alert').forEach(a => {
    console.log(`[模拟通知] ${a.title} 库存 ${a.stock} 低于预警线 ${a.warnLine}（近30天销量 × 系数）`);
  });
  newChanges.filter(a => a.type !== 'stock_change').forEach(a => {
    notify(a).catch(e => console.error('[通知失败]', e.message));
  });

  return { inventory, newAlerts: newChanges };
}

/* ============ 出入库统计（快麦报表中心 stockio 接口） ============
   数据源：/kmrp/statistics/original/stockio/page （报表中心「出入库记录」）
   鉴权要点（与库存列表接口 warehouseStockList 完全不同）：
     - 公司ID 走请求头 companyid（统计模块公司=30847，库存 cId=4347622090 是另一个）
     - 必须带 module-path: /report/dynamic/?reportId=68023（网关按此逻辑路径路由）
     - 请求体为 JSON（Content-Type: application/json），含 api_name=kmrp_statistics_original_stockio_page
     - 其余固定头：bx-v / trackid / origin / referer
   行字段（已确认）：
     dimension_date(YYYY-MM-DD) / sku_outer_id(规格商家编码) / sku_properties_name(规格名)
     stock_change(数量,带符号:入库+ 出库-) / receipts_count(单据数) / inout_storage_type(_name)
   说明：报表未回填 item_outer_id（款级编码恒空），故“款式”按 SKU(sku_outer_id) 聚合。
   ==================================================================== */

const STOCKIO_URL = process.env.ERP_STOCKIO_URL || 'https://viperp.superboss.cc/kmrp/statistics/original/stockio/page';
const STOCKIO_COMPANY_ID = process.env.ERP_COMPANY_ID || '30847';
const STOCKIO_MODULE_PATH = process.env.ERP_STOCKIO_MODULE_PATH || '/report/dynamic/?reportId=68023';
const STOCKIO_BXV = process.env.ERP_STOCKIO_BXV || '2.5.11';
const STOCKIO_REPORT_ID = process.env.ERP_STOCKIO_REPORT_ID || '68023';

// 简单内存缓存（按 范围+仓库 缓存，避免每次都翻页拉全量）
const inoutCache = new Map(); // key -> { ts, result }
const INOUT_CACHE_TTL = 10 * 60 * 1000;

// 翻页拉取某时间范围内的全部出入库行
async function fetchStockIoRows(fromMs, toMs, warehouseId) {
  const cookie = process.env.ERP_COOKIE;
  if (!cookie) throw new Error('未配置 ERP_COOKIE，无法拉取出入库数据');
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    'Cookie': cookie,
    'companyid': STOCKIO_COMPANY_ID,
    'bx-v': STOCKIO_BXV,
    'module-path': STOCKIO_MODULE_PATH,
    'trackid': 'trackid' + Date.now() + '_' + Math.floor(Math.random() * 100000),
    'Origin': 'https://viperp.superboss.cc',
    'Referer': 'https://viperp.superboss.cc/index.html'
  };
  // 与库存接口一致：报表中心(kmrp 统计模块)同样需要 ERP_TOKEN / ERP_API_KEY 鉴权，
  // 仅带 cookie 会被网关判为「会话异常」，必须补上 Bearer / X-API-Key 头。
  if (process.env.ERP_TOKEN) headers['Authorization'] = `Bearer ${process.env.ERP_TOKEN}`;
  if (process.env.ERP_API_KEY) headers['X-API-Key'] = process.env.ERP_API_KEY;
  const baseForm = {
    api_name: 'kmrp_statistics_original_stockio_page',
    endTime: String(toMs),
    itemBrandIdList: '', itemCategoryIdList: '', itemCategoryQuerySetting: '',
    itemClassifyIdList: '', mainSupplierFilter: '0', operationTimeQueryType: 'operation_time',
    operationTypeList: '', operator: '', orderNumberList: '', pageId: '101203',
    pageNo: 1, pageSize: 200, platformTradeIdList: '', quickTimeSelect: '',
    skuBrandIdList: '', skuCategoryIdList: '', skuClassifyIdList: '', skuShipperIdList: '',
    startTime: String(fromMs), stockInoutTypeList: '',
    storageSectionTypeList: 'STOREHOUSE,PURCHASE,REFUND,DEFECTIVE',
    supplierCodeList: '', supplierIdList: '', systemItemIdList: '', systemItemIdQueryType: '1',
    systemOuterIdList: '', systemOuterIdQueryType: '0', systemSkuIdList: '', userIdList: '',
    warehouseIdList: warehouseId || '', reportId: STOCKIO_REPORT_ID,
    '$tradeNumType': 'platformTradeIdList'
  };
  // 单页请求（带限流退避重试）：快麦网关账户级限流会返回 result!==1 且 message 含「频繁/限流」
  async function fetchOnePage(body, attempt = 0) {
    const res = await fetch(STOCKIO_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`出入库接口 HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.result !== 1) {
      const msg = (json && json.message) || '出入库接口返回异常';
      if (/频繁|限流|429|too many|too_many/i.test(msg) && attempt < 4) {
        const wait = 3000 * Math.pow(2, attempt); // 3s,6s,12s,24s
        console.log(`[inout] 触发限流 "${msg}"，第${attempt + 1}次退避 ${wait}ms 后重试（总进度 pageNo=${body.pageNo}）`);
        await new Promise(r => setTimeout(r, wait));
        return fetchOnePage(body, attempt + 1);
      }
      throw new Error(msg);
    }
    return json;
  }

  const rows = [];
  let pageNo = 1;
  const cap = 500; // 安全阀：最多 500 页
  while (pageNo <= cap) {
    // 翻页间隔：避免触发「请求过于频繁」限流（首页除外）
    if (pageNo > 1) await new Promise(r => setTimeout(r, 700));
    const body = { ...baseForm, pageNo, pageSize: 200 };
    const json = await fetchOnePage(body);
    const list = (json.data && json.data.list) || [];
    rows.push(...list);
    const pageInfo = json.data && json.data.page;
    const hasNext = pageInfo ? pageInfo.hasNext : (list.length >= 200);
    if (!hasNext || list.length === 0) break;
    pageNo++;
  }
  return rows;
}

// 按 月份 × 款式 聚合入库/出库
//   groupBy='sku'（默认）：按 SKU 规格(sku_outer_id+规格名) 聚合，最细粒度
//   groupBy='item'：按商品标题(item_title) 聚合，归到「款」级别
function aggregateInOut(rows, groupBy = 'sku') {
  const useItem = groupBy === 'item';
  const months = {};       // month -> { inStyles:Set, outStyles:Set, inQty, outQty, inDocs, outDocs }
  const styleByMonth = {}; // month -> styleKey -> { name, inQty, outQty, inDocs, outDocs }
  for (const r of rows) {
    const date = r.dimension_date;
    if (!date) continue;
    const month = String(date).slice(0, 7); // YYYY-MM
    // 商品标题（报表里 item_title 实际==sku_outer_id，无独立款标题）；用「编码去掉末尾规格段」归到「款」
    const titleOrSku = (r.item_title && String(r.item_title).trim()) ||
      (r.sku_outer_id && String(r.sku_outer_id).trim()) || r.sys_sku_uk || '未知商品';
    const styleKey = useItem
      ? (titleOrSku.replace(/-[^-]+$/, '') || titleOrSku) // 去末尾规格段（-HS/-WTM 等），同款不同规格合并
      : ((r.sku_outer_id && String(r.sku_outer_id).trim()) || r.sys_sku_uk || ('SKU' + (r.sys_sku_uk || '')));
    const name = useItem
      ? styleKey
      : ((r.sku_properties_name && String(r.sku_properties_name).trim()) || r.sku_outer_id || styleKey);
    const qty = Number(r.stock_change) || 0;   // 带符号：入库+ 出库-
    const docs = Number(r.receipts_count) || 0; // 单据数
    if (!months[month]) months[month] = { inStyles: new Set(), outStyles: new Set(), inQty: 0, outQty: 0, inDocs: 0, outDocs: 0 };
    if (!styleByMonth[month]) styleByMonth[month] = {};
    const m = months[month];
    const sm = (styleByMonth[month][styleKey] = styleByMonth[month][styleKey] ||
      { styleKey, name, inQty: 0, outQty: 0, inDocs: 0, outDocs: 0 });
    if (qty > 0) {
      m.inQty += qty; m.inDocs += docs; m.inStyles.add(styleKey);
      sm.inQty += qty; sm.inDocs += docs;
    } else if (qty < 0) {
      m.outQty += -qty; m.outDocs += docs; m.outStyles.add(styleKey);
      sm.outQty += -qty; sm.outDocs += docs;
    }
  }
  // 月度汇总
  const monthList = Object.keys(months).sort().map(month => {
    const m = months[month];
    return {
      month,
      inStyles: m.inStyles.size, inQty: m.inQty, inDocs: m.inDocs,
      outStyles: m.outStyles.size, outQty: m.outQty, outDocs: m.outDocs,
      netQty: m.inQty - m.outQty
    };
  });
  // 款式明细：跨月汇总（每个款式在范围内总入库/出库）
  const styleTotal = {};
  for (const month of Object.keys(styleByMonth)) {
    for (const sk of Object.keys(styleByMonth[month])) {
      const s = styleByMonth[month][sk];
      const t = (styleTotal[sk] = styleTotal[sk] ||
        { styleKey: sk, name: s.name, inQty: 0, outQty: 0, inDocs: 0, outDocs: 0, monthsActive: new Set() });
      t.inQty += s.inQty; t.outQty += s.outQty; t.inDocs += s.inDocs; t.outDocs += s.outDocs;
      if (s.inQty > 0 || s.outQty > 0) t.monthsActive.add(month);
    }
  }
  const styleList = Object.values(styleTotal)
    .map(s => ({ styleKey: s.styleKey, name: s.name, inQty: s.inQty, outQty: s.outQty, inDocs: s.inDocs, outDocs: s.outDocs, monthsActive: s.monthsActive.size }))
    .sort((a, b) => (b.inQty + b.outQty) - (a.inQty + a.outQty));
  return { monthList, styleList };
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
    belowCount: inventory.filter(it => it.below).length,
    source: store.source,
    error: store.lastError
  });
});

// 报警记录（自动补全旧记录可能缺失的 warnLine 字段）
app.get('/api/alerts', (req, res) => {
  const store = readStore();
  const alerts = store.alerts || [];
  // 用当前库存快照反查补全 warnLine：修复前产生的 stock_change 记录可能缺少该字段
  const invMap = {};
  (store.lastInventory || []).forEach(it => { invMap[it.id] = it; });
  const patched = alerts.map(a => {
    if (a.warnLine == null && a.itemId && invMap[a.itemId]) {
      return { ...a, warnLine: invMap[a.itemId].warnLine ?? 0 };
    }
    // 如果库存快照里也查不到（商品已下架等），写 0 而非 undefined/—
    if (a.warnLine == null) {
      return { ...a, warnLine: 0 };
    }
    return a;
  });
  res.json({ alerts: patched });
});

// 出入库统计（按月 × 款式 聚合）
app.get('/api/inout-stats', async (req, res) => {
  try {
    let { from, to, warehouse, groupBy } = req.query;
    groupBy = (groupBy === 'item') ? 'item' : 'sku'; // 仅允许 sku / item
    // 默认：最近 6 个月
    const now = new Date();
    if (!from) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
      from = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    if (!to) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      to = `${d.getUTCFullYear()}-${String(d.getUTCMonth()).padStart(2, '0')}`;
    }
    // 支持多种写法：YYYY-MM-DD HH:mm:ss / YYYY-MM-DDTHH:mm:ss（秒）
    //               YYYY-MM-DD HH:mm（缺秒补00）/ YYYY-MM-DD（仅日期=当日0点）/ YYYY-MM（整月）
    const parseRange = (s, isTo) => {
      let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})$/);
      if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})$/);
      if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
      m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
      m = s.match(/^(\d{4})-(\d{1,2})$/);
      if (m) {
        if (isTo) return Date.UTC(+m[1], +m[2], 1, 0, 0, 0, 0) - 1; // 月末 23:59:59.999
        return Date.UTC(+m[1], +m[2] - 1, 1, 0, 0, 0, 0);            // 当月1号 00:00:00
      }
      return null;
    };
    const fromMs = parseRange(from, false);
    const toMs = parseRange(to, true);
    if (fromMs == null || toMs == null) return res.status(400).json({ ok: false, error: 'from/to 格式应为 YYYY-MM-DD HH:mm:ss 或 YYYY-MM' });
    const wh = warehouse || process.env.ERP_WAREHOUSE_IDS || '116959';
    const cacheKey = `${fromMs}|${toMs}|${wh}|${groupBy}`;
    const cached = inoutCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < INOUT_CACHE_TTL) {
      return res.json({ ok: true, ...cached.result, cached: true });
    }
    const rows = await fetchStockIoRows(fromMs, toMs, wh);
    const agg = aggregateInOut(rows, groupBy);
    const result = {
      from, to, warehouse: wh, rows: rows.length, groupBy,
      monthList: agg.monthList, styleList: agg.styleList, source: 'erp'
    };
    inoutCache.set(cacheKey, { ts: Date.now(), result });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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