// 探测：库存列表接口「限定仓库 116959」vs「不限仓库」的规模差异
const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1] || '';

const base = get('ERP_API_URL');
const countUrl = get('ERP_COUNT_URL') || base.replace(/\/stock\/query\/warehouseStockList$/, '/stock/queryWarehouseStockCount');
const cid = get('ERP_CID');
const headers = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0',
  'X-Requested-With': 'XMLHttpRequest',
  'Cookie': get('ERP_COOKIE'),
  'Content-Type': 'application/x-www-form-urlencoded'
};

async function count(wh) {
  const body = new URLSearchParams({
    api_name: 'stock_queryWarehouseStockCount', cId: cid, warehouseIds: wh, pageNo: 1, pageSize: 1
  }).toString();
  const r = await fetch(countUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  return j && j.data && j.data.total;
}

async function listPage(wh, pageNo = 1, pageSize = 500) {
  const params = {
    api_name: 'stock_query_warehouseStockList',
    autoUpload: '', catIds: '', brands: '', cId: cid, flag: 0,
    mainOuterId: '', skuOuterId: '', stockLabelIds: '', stockStatuses: '',
    supplierIds: '', tileSupplierItemOuterId: '', tilePropertiesName: '',
    warehouseIds: wh, warnStatuses: '',
    minTotalAvailableStock: '', maxTotalAvailableStock: '',
    minTotalAvailableStockSum: '', maxTotalAvailableStockSum: '',
    minAvailableStock: '', maxAvailableStock: '',
    minAvailableStockSum: '', maxAvailableStockSum: '',
    minLockStock: '', maxLockStock: '',
    minStockWarnDiff: '', maxStockWarnDiff: '',
    minDefectiveStock: '', maxDefectiveStock: '',
    minVirtualStock: '', maxVirtualStock: '',
    minPurchaseNum: '', maxPurchaseNum: '',
    skuLevelStockWarnDiff: true, activeStatus: '', text: '',
    queryType: 'itemName', searchType: 0,
    itemTagIds: '', tagQueryType: 0,
    selectedItems: '', userId: -1, shipper: '', skuBrands: '',
    pageNo, pageSize
  };
  const body = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const r = await fetch(base, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  return j;
}

(async () => {
  console.log('--- 总条数对比 ---');
  const c1 = await count('116959');
  console.log('限定 116959 :', c1);
  await new Promise(r => setTimeout(r, 1200));
  const c2 = await count('');
  console.log('不限仓库    :', c2);
  await new Promise(r => setTimeout(r, 1200));

  console.log('\n--- 不限仓库 第1页样本（看仓库分布） ---');
  const j = await listPage('', 1, 500);
  const list = (j && j.data && (j.data.list || j.data.rows || j.data.data)) || [];
  console.log('返回条数:', list.length, '| data keys:', j && j.data ? Object.keys(j.data).join(',') : 'none');
  const names = {};
  for (const x of list) {
    const n = x.warehouseName || x.warehouse || x.wareHouseName || x.warehouseId || '(空)';
    names[n] = (names[n] || 0) + 1;
  }
  console.log('仓库分布:', JSON.stringify(names, null, 1));
  if (list[0]) console.log('样例字段:', Object.keys(list[0]).join(','));
})().catch(e => { console.error('FAIL', e); process.exit(1); });
