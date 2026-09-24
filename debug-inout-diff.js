'use strict';
// 调试：对比本地拉取的出入库原始行 与 快麦网页数据（用后即删）
const fs = require('fs');
const path = require('path');

// 读取 .env
const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const STOCKIO_URL = 'https://viperp.superboss.cc/kmrp/statistics/original/stockio/page';
const SKU = process.argv[2] || 'SYKKH-3J-FH';
const fromMs = Date.parse('2026-09-01T00:00:00+08:00');
const toMs = Date.parse('2026-09-23T23:59:59+08:00');

(async () => {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    'Cookie': process.env.ERP_COOKIE || '',
    'companyid': '30847',
    'bx-v': '2.5.11',
    'module-path': '/report/dynamic/?reportId=68023',
    'trackid': 'trackid' + Date.now() + '_debug',
    'Origin': 'https://viperp.superboss.cc',
    'Referer': 'https://viperp.superboss.cc/index.html'
  };
  const baseForm = {
    api_name: 'kmrp_statistics_original_stockio_page',
    endTime: String(toMs), itemBrandIdList: '', itemCategoryIdList: '', itemCategoryQuerySetting: '',
    itemClassifyIdList: '', mainSupplierFilter: '0', operationTimeQueryType: 'operation_time',
    operationTypeList: '', operator: '', orderNumberList: '', pageId: '101203',
    pageNo: 1, pageSize: 2000, platformTradeIdList: '', quickTimeSelect: '',
    skuBrandIdList: '', skuCategoryIdList: '', skuClassifyIdList: '', skuShipperIdList: '',
    startTime: String(fromMs), stockInoutTypeList: '',
    storageSectionTypeList: 'STOREHOUSE,PURCHASE,REFUND,DEFECTIVE',
    supplierCodeList: '', supplierIdList: '', systemItemIdList: '', systemItemIdQueryType: '1',
    systemOuterIdList: '', systemOuterIdQueryType: '0', systemSkuIdList: '', userIdList: '',
    warehouseIdList: '116959', reportId: '68023',
    '$tradeNumType': 'platformTradeIdList'
  };

  const rows = [];
  let pageNo = 1, total = null;
  while (pageNo <= 100) {
    const res = await fetch(STOCKIO_URL, { method: 'POST', headers, body: JSON.stringify({ ...baseForm, pageNo }), signal: AbortSignal.timeout(20000) });
    const json = await res.json();
    if (json.result !== 1) { console.error('API 返回异常:', json.message || JSON.stringify(json).slice(0, 200)); process.exit(1); }
    const list = (json.data && json.data.list) || [];
    if (json.data && json.data.page && json.data.page.total != null) total = json.data.page.total;
    rows.push(...list);
    const hasNext = json.data && json.data.page ? json.data.page.hasNext : list.length >= 200;
    if (!hasNext || !list.length) break;
    pageNo++;
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`接口共返回 ${rows.length} 行${total != null ? `（page.total=${total}）` : ''}`);

  const mine = rows.filter(r => String(r.sku_outer_id || '').trim() === SKU);
  console.log(`\nSKU ${SKU} 命中 ${mine.length} 行（pageNo 原始顺序）:`);
  // 按快麦网页的口径聚合：日期+类型
  const g = {};
  for (const r of mine) {
    const k = r.dimension_date + ' | ' + (r.inout_storage_type_name || r.inout_storage_type);
    g[k] = g[k] || { docs: 0, qty: 0 };
    const n = Number(String(r.stock_change).replace(/,/g, '')) || 0;
    g[k].docs += Number(String(r.receipts_count).replace(/,/g, '')) || 0;
    g[k].qty += n;
  }
  Object.keys(g).sort().reverse().forEach(k => {
    console.log(`  ${k}  单据数=${g[k].docs}  数量=${g[k].qty}`);
  });
  const inQ = mine.reduce((s, r) => { const n = Number(String(r.stock_change).replace(/,/g, '')) || 0; return n > 0 ? s + n : s; }, 0);
  const outQ = mine.reduce((s, r) => { const n = Number(String(r.stock_change).replace(/,/g, '')) || 0; return n < 0 ? s - n : s; }, 0);
  console.log(`\n汇总: 入库=${inQ}  出库=${outQ}  净=${inQ - outQ}  （快麦网页: 入库 8400 出库 7455 净 945）`);
  console.log('\n原始行明细（stock_change 原始值）:');
  mine.forEach(r => console.log(`  ${r.dimension_date} | ${r.inout_storage_type_name || r.inout_storage_type} | stock_change=${JSON.stringify(r.stock_change)} | receipts=${JSON.stringify(r.receipts_count)}`));
})();
