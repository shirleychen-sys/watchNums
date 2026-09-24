// 用网页真实 payload 对照测试：仓库过滤 / 编码过滤 / 查询类型 的影响
const fs = require('fs');
const path = require('path');

const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const cookie = (env.match(/^ERP_COOKIE=(.*)$/m) || [])[1] || '';
const SKU = 'SYKH-3J-FH';

const headers = {
  'Content-Type': 'application/json',
  'Cookie': cookie,
  'companyid': '30847',
  'bx-v': '2.5.11',
  'module-path': '/report/dynamic/?reportId=68023',
  'trackid': 'trackid' + Date.now() + '_d',
  'Origin': 'https://viperp.superboss.cc',
  'Referer': 'https://viperp.superboss.cc/index.html',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0'
};

const base = {
  api_name: 'kmrp_statistics_original_stockio_page',
  endTime: '1790179199999',
  goodsAllocationList: '',
  goodsAllocationQueryType: 1,
  itemBrandIdList: '', itemCategoryIdList: '', itemCategoryQuerySetting: '', itemClassifyIdList: '',
  mainSupplierFilter: '0',
  operationTimeQueryType: 'operation_time', operationTypeList: '', operator: '', orderNumberList: '',
  pageId: '101203', pageNo: 1, pageSize: 50, platformTradeIdList: '', quickTimeSelect: '',
  skuBrandIdList: '', skuCategoryIdList: '', skuClassifyIdList: '', skuShipperIdList: '',
  startTime: '1788192000000',
  stockInoutTypeList: '',
  storageSectionTypeList: 'STOREHOUSE,PURCHASE,REFUND,DEFECTIVE',
  supplierCodeList: '', supplierIdList: '',
  systemItemIdList: '', systemItemIdQueryType: '1',
  systemOuterIdList: '', systemOuterIdQueryType: '0',
  systemSkuIdList: '', userIdList: '', warehouseIdList: '',
  reportId: '68023',
  $tradeNumType: 'platformTradeIdList'
};

const toNum = (v) => Number(String(v == null ? '' : v).replace(/,/g, '')) || 0;

async function fetchAll(extra, label) {
  const rows = [];
  for (let p = 1; p <= 60; p++) {
    const body = Object.assign({}, base, extra, { pageNo: p });
    const r = await fetch('https://viperp.superboss.cc/kmrp/statistics/original/stockio/page', {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(25000)
    });
    const j = await r.json();
    if (j.result !== 1) { console.log(`[${label}] API err page ${p}:`, j.message); break; }
    const list = (j.data && j.data.list) || [];
    rows.push(...list);
    const pg = j.data && j.data.page;
    const hasNext = pg ? pg.hasNext : (list.length >= (extra.pageSize || base.pageSize));
    if (!hasNext || !list.length) break;
    await new Promise(r => setTimeout(r, 250));
  }
  return rows;
}

function summarize(rows, label) {
  const inQ = rows.reduce((s, x) => { const n = toNum(x.stock_change); return n > 0 ? s + n : s; }, 0);
  const outQ = rows.reduce((s, x) => { const n = toNum(x.stock_change); return n < 0 ? s - n : s; }, 0);
  console.log(`\n===== ${label} =====`);
  console.log(`  rows=${rows.length}  入库=${inQ}  出库=${outQ}  净=${inQ - outQ}`);
  rows.sort((a, b) => String(b.dimension_date).localeCompare(String(a.dimension_date)));
  for (const x of rows) {
    console.log(`   ${x.dimension_date} | ${x.inout_storage_type_name || x.inout_storage_type} | 数量=${x.stock_change} | 单据=${x.receipts_count} | 仓=${x.warehouse_name || x.warehouse_id || ''} | ${x.sku_outer_id}`);
  }
  return { inQ, outQ, n: rows.length };
}

(async () => {
  console.log('startTime =', new Date(Number(base.startTime)).toLocaleString('zh-CN'));
  console.log('endTime   =', new Date(Number(base.endTime)).toLocaleString('zh-CN'));

  // A: 完全照抄网页 payload（无仓库过滤 + 编码过滤）
  const A = await fetchAll({ systemOuterIdList: SKU }, 'A 网页payload(无仓库+编码过滤)');
  summarize(A, 'A 网页payload(无仓库+编码过滤)');

  // B: 同上但锁定仓库 116959（我们本地现在的方式）
  const B = await fetchAll({ systemOuterIdList: SKU, warehouseIdList: '116959' }, 'B 锁仓库116959+编码过滤');
  summarize(B, 'B 锁仓库116959+编码过滤');

  // C: 不按编码过滤、无仓库限制（全量），再看这个SKU
  const C = await fetchAll({}, 'C 无任何过滤(全量)');
  const ch = C.filter(x => String(x.sku_outer_id || '').trim() === SKU);
  summarize(ch, `C 全量里筛 ${SKU}`);

  // D: 不按编码过滤 + 锁仓库（我们本地出/入库统计的实际请求方式）
  const D = await fetchAll({ warehouseIdList: '116959' }, 'D 锁仓库116959(全量)');
  const dh = D.filter(x => String(x.sku_outer_id || '').trim() === SKU);
  summarize(dh, `D 锁仓库116959 里筛 ${SKU}`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
