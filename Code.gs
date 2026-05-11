/**
 * 投資阿喵嘎哩共 推播自動化系統
 * Google Apps Script + LINE Messaging API + Google Gemini API
 *
 * 功能：
 *   1. 每日早報（08:30）
 *   2. 盤中向錢進到價提醒（每 30 分鐘）
 *   3. 定期定額扣款日提醒
 *   4. 週五收盤週報
 */

// ========== 設定區 ==========
const GEMINI_MODEL = 'gemini-2.5-flash';

// Dashboard 跟 Web App 之間的通關密語。可以在 Sheet「設定」分頁加一列
// api_key | <你自己的字串> 來覆寫；沒填就用下面的預設。
const DEFAULT_API_KEY = 'meow-cat-financial-2026';

function getApiKey_() {
  try {
    const v = getConfig().api_key;
    if (v) return String(v).trim();
  } catch(e) {}
  return DEFAULT_API_KEY;
}

/**
 * 取得綁定的 Sheet。預設用「擴充功能 → Apps Script」綁定的容器 Sheet。
 * 想用其他 Sheet 的話，在 Apps Script「專案設定 → 指令碼屬性」加一個
 *   sheet_id = <你的 Sheet ID>
 * 即可覆寫。
 */
function getSheet_() {
  const override = PropertiesService.getScriptProperties().getProperty('sheet_id');
  if (override) return SpreadsheetApp.openById(override);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('找不到綁定的 Sheet，請從 Google Sheet 進入「擴充功能 → Apps Script」建立腳本');
  return ss;
}

/**
 * 取得綁定的 Sheet。預設用「擴充功能 → Apps Script」綁定的容器 Sheet。
 * 想用其他 Sheet 的話，在 Apps Script「專案設定 → 指令碼屬性」加一個
 *   sheet_id = <你的 Sheet ID>
 * 即可覆寫。
 */
function getSheet_() {
  const override = PropertiesService.getScriptProperties().getProperty('sheet_id');
  if (override) return SpreadsheetApp.openById(override);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('找不到綁定的 Sheet，請從 Google Sheet 進入「擴充功能 → Apps Script」建立腳本');
  return ss;
}

// ========== Web API（Dashboard 用）==========

function doGet(e) {
  try {
    if ((e.parameter || {}).key !== getApiKey_()) return apiResp_({ error: 'unauthorized' }, 401);
    return apiResp_({
      holdings: getHoldings(),
      watchlist: getWatchlist(),
      dca: getDCA(),
      trades: getTrades(),
      config: getConfig(),
      morningReport: getLastMorningReport_()
    });
  } catch (err) {
    return apiResp_({ error: err.message }, 500);
  }
}

function getLastMorningReport_() {
  const props = PropertiesService.getScriptProperties();
  return {
    main: props.getProperty('last_morning_main') || '',
    sources: props.getProperty('last_morning_sources') || '',
    at: props.getProperty('last_morning_at') || ''
  };
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');

    // LINE Messaging API webhook
    if (body.events && Array.isArray(body.events)) {
      handleLineWebhook_(body);
      return apiResp_({ ok: true });
    }

    // Dashboard cloud-sync
    if (body.key !== getApiKey_()) return apiResp_({ error: 'unauthorized' }, 401);
    if (body.holdings) writeHoldings_(body.holdings);
    if (body.watchlist) writeWatchlist_(body.watchlist);
    if (body.dca) writeDCA_(body.dca);
    if (body.trades) writeTrades_(body.trades);
    if (body.config) writeConfig_(body.config);
    return apiResp_({ ok: true, saved: Object.keys(body).filter(k => k !== 'key') });
  } catch (err) {
    return apiResp_({ error: err.message }, 500);
  }
}

// ========== LINE Webhook 雙向對話 ==========

function handleLineWebhook_(body) {
  const cfg = getConfig();
  body.events.forEach(event => {
    if (event.type !== 'message' || event.message.type !== 'text') return;
    // 只回應主人
    if (cfg.line_user_id && event.source.userId !== cfg.line_user_id) {
      replyLine_(cfg.line_token, event.replyToken, '抱歉，這個 Bot 只服務主人 🙇');
      return;
    }
    const userText = event.message.text.trim();
    try {
      const reply = executeIntent_(userText, cfg);
      replyLine_(cfg.line_token, event.replyToken, reply);
    } catch (err) {
      replyLine_(cfg.line_token, event.replyToken, '❌ 處理失敗：' + err.message);
    }
  });
}

function executeIntent_(text, cfg) {
  // 快速關鍵字匹配
  const lower = text.toLowerCase();
  if (/^(說明|使用說明|help|推播時機|時機|功能|menu)$/i.test(text)) return helpText_();
  if (/^(查持倉|查詢持倉|持倉|我的持倉)$/i.test(text)) return listHoldings_();
  if (/^(查向錢進|向錢進|清單|追蹤)$/i.test(text)) return listWatchlist_();
  if (/^(現在損益|損益|我的損益|現況)$/i.test(text)) return currentPnl_();
  if (/^(今日早報|早報|生成早報)$/i.test(text)) {
    // 即時生成早報並回傳
    try { sendMorningReport(); return '☀️ 早報已生成並推送，請看下一則訊息'; }
    catch (e) { return '早報生成失敗：' + e.message; }
  }

  // 用 Gemini 解析自然語
  const parsed = parseIntent_(text, cfg.gemini_key);
  if (!parsed) return '我聽不懂這個指令 🤔 試試「說明」看可以做什麼。';

  switch (parsed.intent) {
    case 'add_trade': return doAddTrade_(parsed.data);
    case 'add_watch': return doAddWatch_(parsed.data);
    case 'list_holdings': return listHoldings_();
    case 'list_watch': return listWatchlist_();
    case 'current_pnl': return currentPnl_();
    case 'help': return helpText_();
    default: return '我聽不懂這個指令 🤔 試試「說明」看可以做什麼。';
  }
}

function parseIntent_(text, apiKey) {
  const prompt = `用戶在 LINE 傳了訊息：「${text}」

判斷意圖，**只輸出 JSON**（不要 markdown）：
{"intent": "...", "data": {...}}

intent 種類：
- add_trade: 記錄一筆交易。data: {type:"buy"|"sell", tk:"代號", nm:"名稱", shares:數字, price:數字, source:"來源", pnl:賣出損益}
- add_watch: 新增向錢進。data: {tk, nm, buy_price, take_profit, stop_loss, source}
- list_holdings | list_watch | current_pnl | help: 不需要 data
- unknown: 不能理解

範例：
"買 2330 10股 1050" → {"intent":"add_trade","data":{"type":"buy","tk":"2330","nm":"台積電","shares":10,"price":1050,"source":"自己分析"}}
"我買了聯發科 5 股 1400" → {"intent":"add_trade","data":{"type":"buy","tk":"2454","nm":"聯發科","shares":5,"price":1400,"source":"自己分析"}}
"賣 2330 5 1100 賺 2500" → {"intent":"add_trade","data":{"type":"sell","tk":"2330","nm":"台積電","shares":5,"price":1100,"pnl":2500,"source":"自己分析"}}
"新增向錢進 2454 聯發科 買1300 利1500 損1200 王同學說" → {"intent":"add_watch","data":{"tk":"2454","nm":"聯發科","buy_price":1300,"take_profit":1500,"stop_loss":1200,"source":"王同學說"}}

台股代號對照：台積電=2330、聯發科=2454、鴻海=2317、台塑=1301、富邦台50=006208、元大台灣50=0050、台達電=2308。
如果用戶只給名稱沒給代號，你補上常見對照；如果沒提來源就填「自己分析」。`;

  const out = askGemini(apiKey, prompt);
  if (!out) return null;
  try {
    const json = JSON.parse(out.replace(/```json|```/g, '').trim());
    return json;
  } catch (e) {
    Logger.log('parseIntent JSON 解析失敗：' + out);
    return null;
  }
}

function helpText_() {
  return `📅 投資阿喵共・推播時機

🌅 每天 08:30 個人化早報
💰 扣款日 08:00 定期定額提醒
🎯 盤中每 30 分 向錢進到價推播
📊 每週五 18:00 週報

📝 你可以傳這些訊息給我：
・「買 2330 10股 1050」記錄交易
・「賣 2330 5股 1100 賺 2500」
・「新增向錢進 2454 聯發科 買1300 利1500 損1200」
・「查持倉」「查向錢進」「現在損益」「說明」`;
}

function listHoldings_() {
  const list = getHoldings();
  if (!list.length) return '目前沒有持倉 📭';
  const lines = list.map(h => {
    const price = getPrice(h.stock_tk) || h.cost;
    const pnl = (price - h.cost) * h.shares;
    const pct = h.cost > 0 ? ((price - h.cost) / h.cost * 100).toFixed(1) : '0';
    return `・${h.stock_nm}(${h.stock_tk}) ${h.shares}股\n  現價 ${price} | 成本 ${h.cost} | 損益 ${pnl.toFixed(0)} (${pct}%)`;
  });
  return '📊 你的持倉\n' + lines.join('\n');
}

function listWatchlist_() {
  const list = getWatchlist();
  if (!list.length) return '向錢進清單是空的 📭';
  const lines = list.map(w => {
    const price = getPrice(w.stock_tk) || w.buy_price;
    if (w.status === 'holding') {
      const tpDist = w.take_profit ? ((w.take_profit - price) / price * 100).toFixed(1) : '?';
      return `・${w.stock_nm}(${w.stock_tk}) 💼持有\n  現價 ${price} | 距停利 ${w.take_profit} 差 ${tpDist}%`;
    } else {
      const buyDist = ((price - w.buy_price) / w.buy_price * 100).toFixed(1);
      return `・${w.stock_nm}(${w.stock_tk}) 👀追蹤 [${w.source}]\n  現價 ${price} | 買入 ${w.buy_price} (差 ${buyDist}%)`;
    }
  });
  return '🎯 向錢進清單\n' + lines.join('\n');
}

function currentPnl_() {
  const list = getHoldings();
  if (!list.length) return '沒有持倉，無法計算損益 📭';
  let totalCost = 0, totalValue = 0;
  list.forEach(h => {
    const price = getPrice(h.stock_tk) || h.cost;
    totalCost += h.cost * h.shares;
    totalValue += price * h.shares;
  });
  const pnl = totalValue - totalCost;
  const pct = totalCost > 0 ? (pnl / totalCost * 100).toFixed(2) : '0';
  const emoji = pnl >= 0 ? '📈' : '📉';
  return `${emoji} 現在損益\n總成本：${totalCost.toFixed(0)}\n總市值：${totalValue.toFixed(0)}\n未實現損益：${pnl.toFixed(0)} (${pct}%)`;
}

function doAddTrade_(d) {
  if (!d || !d.tk || !d.price || !d.shares) return '❌ 缺少必要資訊（代號、價格、股數）。範例：「買 2330 10股 1050」';
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  appendTradeRow_({
    date: today,
    type: d.type || 'buy',
    stock_tk: String(d.tk),
    stock_nm: d.nm || '',
    shares: Number(d.shares),
    price: Number(d.price),
    source: d.source || '自己分析',
    pnl: d.pnl == null ? '' : Number(d.pnl)
  });
  const typeWord = d.type === 'sell' ? '賣出' : '買進';
  let reply = `✅ 已記錄交易\n${d.nm || d.tk}(${d.tk}) ${typeWord} ${d.shares} 股 @ ${d.price}`;
  if (d.pnl != null) reply += `\n實現損益：${d.pnl}`;
  return reply;
}

function doAddWatch_(d) {
  if (!d || !d.tk || !d.buy_price) return '❌ 缺少必要資訊（代號、買入價）。範例：「新增向錢進 2454 聯發科 買1300 利1500 損1200」';
  appendWatchRow_({
    stock_tk: String(d.tk),
    stock_nm: d.nm || '',
    buy_price: Number(d.buy_price),
    take_profit: Number(d.take_profit) || 0,
    stop_loss: Number(d.stop_loss) || 0,
    source: d.source || '自己分析',
    status: 'watching'
  });
  return `🎯 已加入向錢進\n${d.nm || d.tk}(${d.tk})\n買入 ${d.buy_price} | 停利 ${d.take_profit||'—'} | 停損 ${d.stop_loss||'—'}`;
}

function appendTradeRow_(r) {
  const ss = getSheet_();
  let sh = ss.getSheetByName('交易記錄');
  if (!sh) {
    sh = ss.insertSheet('交易記錄');
    sh.appendRow(['date', 'type', 'stock_tk', 'stock_nm', 'shares', 'price', 'source', 'pnl']);
  }
  sh.appendRow([r.date, r.type, r.stock_tk, r.stock_nm, r.shares, r.price, r.source, r.pnl]);
}

function appendWatchRow_(r) {
  const ss = getSheet_();
  let sh = ss.getSheetByName('向錢進');
  if (!sh) {
    sh = ss.insertSheet('向錢進');
    sh.appendRow(['stock_tk', 'stock_nm', 'buy_price', 'take_profit', 'stop_loss', 'source', 'status']);
  }
  sh.appendRow([r.stock_tk, r.stock_nm, r.buy_price, r.take_profit, r.stop_loss, r.source, r.status]);
}

function replyLine_(token, replyToken, text) {
  const cleanToken = String(token || '').replace(/\s+/g, '');
  if (!cleanToken || !replyToken) return;
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + cleanToken },
      payload: JSON.stringify({
        replyToken: replyToken,
        messages: [{ type: 'text', text: text }]
      }),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('replyLine 失敗：' + err.message);
  }
}

function apiResp_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ========== 資料讀取 ==========

/**
 * 讀取「設定」工作表，回傳 key-value 物件
 */
function getConfig() {
  try {
    const sh = getSheet_().getSheetByName('設定');
    if (!sh) throw new Error('找不到「設定」工作表');
    const data = sh.getDataRange().getValues();
    const cfg = {};
    for (let i = 1; i < data.length; i++) {
      const [k, v] = data[i];
      if (!k) continue;
      const key = String(k).trim();
      cfg[key] = typeof v === 'string' ? v.replace(/\s+/g, '') : v;
    }
    return cfg;
  } catch (err) {
    Logger.log('getConfig 失敗：' + err.message);
    throw err;
  }
}

/**
 * 讀取「持倉」工作表
 */
function getHoldings() {
  try {
    const sh = getSheet_().getSheetByName('持倉');
    if (!sh) throw new Error('找不到「持倉」工作表');
    const data = sh.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      const [tk, nm, shares, cost, buyAlert, sellAlert] = data[i];
      if (!tk) continue;
      rows.push({
        stock_tk: String(tk).trim(),
        stock_nm: String(nm || '').trim(),
        shares: Number(shares) || 0,
        cost: Number(cost) || 0,
        buy_alert: Number(buyAlert) || 0,
        sell_alert: Number(sellAlert) || 0
      });
    }
    return rows;
  } catch (err) {
    Logger.log('getHoldings 失敗：' + err.message);
    throw err;
  }
}

/**
 * 讀取「向錢進」工作表，過濾掉已出場的（sold_profit / sold_loss）
 */
function getWatchlist() {
  try {
    const sh = getSheet_().getSheetByName('向錢進');
    if (!sh) throw new Error('找不到「向錢進」工作表');
    const data = sh.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      const [tk, nm, buy, tp, sl, source, status] = data[i];
      if (!tk) continue;
      const st = String(status || '').trim();
      if (st === 'sold_profit' || st === 'sold_loss') continue;
      rows.push({
        stock_tk: String(tk).trim(),
        stock_nm: String(nm || '').trim(),
        buy_price: Number(buy) || 0,
        take_profit: Number(tp) || 0,
        stop_loss: Number(sl) || 0,
        source: String(source || '').trim(),
        status: st || 'watching'
      });
    }
    return rows;
  } catch (err) {
    Logger.log('getWatchlist 失敗：' + err.message);
    throw err;
  }
}

/**
 * 讀取「定期定額」工作表，僅回傳 active = TRUE 的計畫
 */
function getDCA() {
  try {
    const sh = getSheet_().getSheetByName('定期定額');
    if (!sh) throw new Error('找不到「定期定額」工作表');
    const data = sh.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      const [tk, nm, day, amount, active] = data[i];
      if (!tk) continue;
      if (active !== true && String(active).toUpperCase() !== 'TRUE') continue;
      rows.push({
        stock_tk: String(tk).trim(),
        stock_nm: String(nm || '').trim(),
        deduct_day: Number(day) || 0,
        amount: Number(amount) || 0,
        active: true
      });
    }
    return rows;
  } catch (err) {
    Logger.log('getDCA 失敗：' + err.message);
    throw err;
  }
}

/**
 * 讀取「交易記錄」工作表（不存在會自動建立）
 */
function getTrades() {
  try {
    const ss = getSheet_();
    let sh = ss.getSheetByName('交易記錄');
    if (!sh) {
      sh = ss.insertSheet('交易記錄');
      sh.appendRow(['date', 'type', 'stock_tk', 'stock_nm', 'shares', 'price', 'source', 'pnl']);
    }
    const data = sh.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      const [date, type, tk, nm, shares, price, src, pnl] = data[i];
      if (!tk) continue;
      rows.push({
        date: date instanceof Date ? Utilities.formatDate(date, 'Asia/Taipei', 'yyyy-MM-dd') : String(date || ''),
        type: String(type || 'buy').trim(),
        stock_tk: String(tk).trim(),
        stock_nm: String(nm || '').trim(),
        shares: Number(shares) || 0,
        price: Number(price) || 0,
        source: String(src || '').trim(),
        pnl: pnl === '' || pnl == null ? null : Number(pnl)
      });
    }
    return rows;
  } catch (err) {
    Logger.log('getTrades 失敗：' + err.message);
    return [];
  }
}

// ========== 寫入函式（doPost 用）==========

function writeHoldings_(rows) {
  const ss = getSheet_();
  const sh = ss.getSheetByName('持倉') || ss.insertSheet('持倉');
  sh.clear();
  sh.appendRow(['stock_tk', 'stock_nm', 'shares', 'cost', 'buy_alert', 'sell_alert']);
  rows.forEach(r => sh.appendRow([
    r.stock_tk || '', r.stock_nm || '', r.shares || 0, r.cost || 0, r.buy_alert || 0, r.sell_alert || 0
  ]));
}

function writeWatchlist_(rows) {
  const ss = getSheet_();
  const sh = ss.getSheetByName('向錢進') || ss.insertSheet('向錢進');
  sh.clear();
  sh.appendRow(['stock_tk', 'stock_nm', 'buy_price', 'take_profit', 'stop_loss', 'source', 'status']);
  rows.forEach(r => sh.appendRow([
    r.stock_tk || '', r.stock_nm || '', r.buy_price || 0, r.take_profit || 0,
    r.stop_loss || 0, r.source || '', r.status || 'watching'
  ]));
}

function writeDCA_(rows) {
  const ss = getSheet_();
  const sh = ss.getSheetByName('定期定額') || ss.insertSheet('定期定額');
  sh.clear();
  sh.appendRow(['stock_tk', 'stock_nm', 'deduct_day', 'amount', 'active']);
  rows.forEach(r => sh.appendRow([
    r.stock_tk || '', r.stock_nm || '', r.deduct_day || 0, r.amount || 0,
    r.active === false ? 'FALSE' : 'TRUE'
  ]));
}

function writeTrades_(rows) {
  const ss = getSheet_();
  const sh = ss.getSheetByName('交易記錄') || ss.insertSheet('交易記錄');
  sh.clear();
  sh.appendRow(['date', 'type', 'stock_tk', 'stock_nm', 'shares', 'price', 'source', 'pnl']);
  rows.forEach(r => sh.appendRow([
    r.date || '', r.type || 'buy', r.stock_tk || '', r.stock_nm || '',
    r.shares || 0, r.price || 0, r.source || '',
    r.pnl == null ? '' : r.pnl
  ]));
}

function writeConfig_(cfg) {
  const ss = getSheet_();
  const sh = ss.getSheetByName('設定') || ss.insertSheet('設定');
  const existing = getConfig();
  const merged = Object.assign({}, existing, cfg);
  sh.clear();
  sh.appendRow(['key', 'value']);
  Object.entries(merged).forEach(([k, v]) => sh.appendRow([k, v]));
}

// ========== 外部 API ==========

/**
 * 用 Yahoo Finance 公開 API 抓台股最新收盤價（不需 token）
 * 自動處理 4 碼/6 碼台股，回傳最近一筆 regularMarketPrice
 */
function getPrice(tk) {
  const code = String(tk).trim();
  let price = fetchYahooPrice_(code);
  if (price !== null) return price;
  // Google Sheets 會把 006208 之類 ETF 代號吃掉前導 0，補回去再試一次
  if (/^\d{4}$/.test(code)) {
    price = fetchYahooPrice_('00' + code);
    if (price !== null) {
      Logger.log('getPrice ' + code + ' 補成 00' + code + ' 抓到 ' + price);
      return price;
    }
  }
  return null;
}

function fetchYahooPrice_(code) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
      + encodeURIComponent(code) + '.TW?interval=1d&range=5d';
    const res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (res.getResponseCode() !== 200) return null;
    const json = JSON.parse(res.getContentText());
    const result = json.chart && json.chart.result && json.chart.result[0];
    if (!result) return null;
    const meta = result.meta || {};
    if (meta.regularMarketPrice != null) return Number(meta.regularMarketPrice);
    const closes = result.indicators && result.indicators.quote
      && result.indicators.quote[0] && result.indicators.quote[0].close;
    if (closes && closes.length) {
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] != null) return Number(closes[i]);
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * 透過 LINE Messaging API（Push Message）推送訊息
 *   token  = Channel access token（Messaging API channel）
 *   userId = 收訊者的 LINE userId（U 開頭那串）
 */
function sendLine(token, msg, userId) {
  const cleanToken = String(token || '').replace(/\s+/g, '');
  const cleanUserId = String(userId || '').trim();
  if (!cleanToken || !cleanUserId) {
    Logger.log('sendLine 未設定 token 或 userId，跳過');
    return false;
  }
  try {
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + cleanToken },
      payload: JSON.stringify({
        to: cleanUserId,
        messages: [{ type: 'text', text: msg }]
      }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('sendLine 失敗 HTTP ' + res.getResponseCode() + '：' + res.getContentText());
      return false;
    }
    return true;
  } catch (err) {
    Logger.log('sendLine 例外：' + err.message);
    return false;
  }
}

// 最近一次 grounded 呼叫的搜尋資訊，給 sendMorningReport 等附在訊息末端
let LAST_GROUNDING = null;

/**
 * 呼叫 Google Gemini API（免費 tier），回傳純文字回覆。
 * grounded=true 會開啟 Google Search grounding，AI 會去搜當天真實資料再回答。
 * 搜尋結果（queries + sources）會存到 LAST_GROUNDING。
 */
function askGemini(apiKey, prompt, grounded) {
  LAST_GROUNDING = null;
  if (!apiKey) {
    Logger.log('askGemini 未設定 API Key');
    return '';
  }
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
      + GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: grounded ? 4000 : 800,
        temperature: 0.8,
        thinkingConfig: { thinkingBudget: 0 }
      }
    };
    if (grounded) body.tools = [{ google_search: {} }];
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('askGemini 失敗 HTTP ' + res.getResponseCode() + '：' + res.getContentText());
      return '';
    }
    const json = JSON.parse(res.getContentText());
    const cand = json.candidates && json.candidates[0];
    if (!cand) return '';
    if (grounded && cand.groundingMetadata) {
      LAST_GROUNDING = {
        queries: cand.groundingMetadata.webSearchQueries || [],
        sources: (cand.groundingMetadata.groundingChunks || [])
          .map(c => c.web).filter(Boolean)
      };
    }
    if (cand.finishReason && cand.finishReason !== 'STOP') {
      Logger.log('askGemini finishReason=' + cand.finishReason);
    }
    if (!cand.content || !cand.content.parts) return '';
    const text = cand.content.parts.map(p => p.text || '').join('').trim();
    Logger.log('askGemini output length: ' + text.length + ' chars'
      + (LAST_GROUNDING ? `, queries=${LAST_GROUNDING.queries.length}, sources=${LAST_GROUNDING.sources.length}` : ''));
    return text;
  } catch (err) {
    Logger.log('askGemini 例外：' + err.message);
    return '';
  }
}

/**
 * 把最近一次 grounded 呼叫的搜尋來源排成 LINE 友善的字串。
 * 包含真正的引用 URL（點下去會跳到實際文章，不是網站首頁）。
 */
function formatGroundingFooter_() {
  if (!LAST_GROUNDING) return '';
  const { queries, sources } = LAST_GROUNDING;
  const lines = [];
  lines.push('');
  lines.push('─────');
  lines.push('🔍 Gemini 用 Google 搜了：');
  (queries.length ? queries : ['（無搜尋記錄）']).slice(0, 5).forEach(q => lines.push('・' + q));
  if (sources.length) {
    lines.push('');
    lines.push('📰 引用來源（點 URL 看原文）：');
    sources.slice(0, 4).forEach(s => {
      const title = (s.title || '網頁').slice(0, 30);
      lines.push('・' + title);
      if (s.uri) lines.push('  ' + s.uri);
    });
  }
  const ts = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
  lines.push('');
  lines.push('⏱ 抓取時間：' + ts);
  return lines.join('\n');
}

// ========== 防重複通知 ==========

/**
 * 用 PropertiesService 紀錄當天已通知過的事件，並清除前天以前的紀錄
 */
function isNotified(tk, type) {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
  cleanupOldNotifications_(props, today);
  const key = `notified_${tk}_${type}_${today}`;
  return props.getProperty(key) === '1';
}

function markNotified(tk, type) {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
  const key = `notified_${tk}_${type}_${today}`;
  props.setProperty(key, '1');
}

function cleanupOldNotifications_(props, today) {
  const all = props.getProperties();
  Object.keys(all).forEach(k => {
    if (!k.startsWith('notified_')) return;
    const parts = k.split('_');
    const ymd = parts[parts.length - 1];
    if (ymd !== today) props.deleteProperty(k);
  });
}

// ========== 工具函式 ==========

function isTradingHours_() {
  const now = new Date();
  const tz = 'Asia/Taipei';
  const day = Number(Utilities.formatDate(now, tz, 'u')); // 1=Mon..7=Sun
  if (day < 1 || day > 5) return false;
  const hhmm = Number(Utilities.formatDate(now, tz, 'HHmm'));
  return hhmm >= 900 && hhmm <= 1335;
}

function fmtPct_(p) {
  const sign = p >= 0 ? '+' : '';
  return sign + (p * 100).toFixed(2) + '%';
}

// ========== 推播功能 1：每日早報 ==========

function shortenUrl(url) {
  try {
    const res = UrlFetchApp.fetch(
      'https://tinyurl.com/api-create.php?url=' + encodeURIComponent(url),
      { muteHttpExceptions: true }
    );
    const short = res.getContentText().trim();
    if (short.startsWith('https://tinyurl.com/')) return short;
    return url;
  } catch(e) {
    return url;
  }
}

function sendMorningReport() {
  try {
    const cfg = getConfig();
    const owner = cfg.owner_name || '朋友';
    const holdings = getHoldings();
    const watchlist = getWatchlist();
    const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy年M月d日 EEEE');

    // 算持倉損益
    let totalPnl = 0;
    const holdingLines = holdings.map(h => {
      const price = getPrice(h.stock_tk) || h.cost;
      const pnl = (price - h.cost) * h.shares;
      const pct = h.cost > 0 ? ((price - h.cost) / h.cost * 100).toFixed(1) : '0';
      totalPnl += pnl;
      return `${h.stock_nm}(${h.stock_tk}) 現價$${price} 損益${pnl>=0?'+':''}${Math.round(pnl)}(${pnl>=0?'+':''}${pct}%)`;
    }).join('\n') || '（無持倉）';

    // 算向錢進距離
    const watchLines = watchlist.map(w => {
      const price = getPrice(w.stock_tk) || w.buy_price;
      const distBuy = w.buy_price > 0 ? ((price - w.buy_price) / w.buy_price * 100).toFixed(1) : '?';
      return `${w.stock_nm}(${w.stock_tk}) 現價$${price} 買入$${w.buy_price}(距${distBuy}%) 停利$${w.take_profit||'?'} 停損$${w.stop_loss||'?'} 狀態:${w.status}`;
    }).join('\n') || '（無向錢進清單）';

    const prompt =
`你是${owner}的投資助理，今天是${today}。
請先用 Google Search 搜尋：
1. 昨日美股 S&P500 / 費城半導體收盤漲跌幅
2. 今日 USD/TWD 匯率
3. 昨日台股外資買超/賣超金額
4. 今日對台股影響的重大新聞

⚠️ 搜尋市場數據時，請優先使用以下權威來源，不要使用比價網站、部落格或不明來源：
【指定來源】
- 美股 S&P500 / Nasdaq：fred.stlouisfed.org 或 barchart.com 或 finance.yahoo.com
- 費城半導體指數(SOX)：barchart.com 或 marketwatch.com
- 台幣匯率(USD/TWD)：rate.bot.com.tw（台灣銀行官方）
- 外資買賣超：twse.com.tw（台灣證券交易所官方）
- 美國公債殖利率：home.treasury.gov（美國財政部官方）
- 台股加權指數：twse.com.tw

以上來源的數據最為權威準確，請優先引用這些網站的實際報導或數據頁面 URL。
不要引用：比價網站(biggo等)、部落格、社群媒體、論壇。

【持倉資料】
${holdingLines}

【向錢進清單】
${watchLines}

【總未實現損益】${totalPnl>=0?'+':''}${Math.round(totalPnl)} 元

輸出格式（直接輸出，不要加任何說明或來源連結，不要用 markdown **粗體**，LINE 不支援，全文 ≤ 280 字）：

☀️ 投資阿喵共・今日早報
🌅 早安 ${owner}！

【市場概況】
・美股 S&P500：（填入數字）（對台股影響一句話）
・費城半導體：（填入數字）（對科技持倉影響一句話）
・台幣匯率：（填入數字）（升/貶影響一句話）
・外資：（填入數字）（市場情緒一句話）

【你的持倉今天】
（每支一行，格式：・名稱(代號) 現價$x 損益+/-$x(+/-x%) → 今天影響 👍/⚠️）

【向錢進狀態】
（每支一行，格式：・名稱(代號) 現價$x 買入$x（距x%）🟢/🟡/🔴 一句話）
（距買入價 <5% 用 🟢接近了，5-20% 用 🟡等待，>20% 或低於買入價用 🔴）

【今天只需要做一件事】
→ 一個具體行動，不超過20字

💪 根據總損益${totalPnl>=0?'+':''}${Math.round(totalPnl)}元：賺錢稱讚${owner}眼光準，虧損溫暖鼓勵，一句話`;

    const mainMsg = askGemini(cfg.gemini_key, prompt, true) || '今日早報生成失敗，請稍後查看。';

    // 第二則：來源（取 Gemini grounding 真實 URL 縮短）
    const now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
    let sourceLines;
    if (LAST_GROUNDING && LAST_GROUNDING.sources && LAST_GROUNDING.sources.length) {
      sourceLines = LAST_GROUNDING.sources.slice(0, 5).map(s => {
        const label = (s.title || '來源').slice(0, 20);
        return `・${label}：${shortenUrl(s.uri)}`;
      }).join('\n');
    } else {
      sourceLines = [
        `・S&P500 / Nasdaq：${shortenUrl(cfg.sp500_url   || 'https://fred.stlouisfed.org/series/SP500')}`,
        `・費城半導體(SOX)：${shortenUrl(cfg.sox_url    || 'https://www.barchart.com/indices/overview/$SOX')}`,
        `・台幣匯率：${shortenUrl(cfg.twd_url           || 'https://rate.bot.com.tw/xrt?Lang=zh-TW')}`,
        `・外資動向：${shortenUrl(cfg.foreign_url       || 'https://www.twse.com.tw/zh/trading/foreign/fmtqik.html')}`,
        `・美債殖利率：${shortenUrl(cfg.bond_url        || 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/')}`
      ].join('\n');
    }
    const sourceMsg = `📰 今日資料來源\n${sourceLines}\n⏱ ${now}`;

    sendLine(cfg.line_token, mainMsg, cfg.line_user_id);
    Utilities.sleep(1000);
    sendLine(cfg.line_token, sourceMsg, cfg.line_user_id);

    // 同步給 Dashboard 顯示
    PropertiesService.getScriptProperties().setProperties({
      'last_morning_main': mainMsg,
      'last_morning_sources': sourceMsg,
      'last_morning_at': new Date().toISOString()
    });
  } catch (err) {
    Logger.log('sendMorningReport 失敗：' + err.message);
  }
}

// ========== 推播功能 2：盤中向錢進到價提醒 ==========

function checkWatchlistAlerts() {
  try {
    if (!isTradingHours_()) {
      Logger.log('非交易時間，略過 checkWatchlistAlerts');
      return;
    }
    const cfg = getConfig();
    const owner = cfg.owner_name || '朋友';
    const list = getWatchlist();

    list.forEach(w => {
      const price = getPrice(w.stock_tk);
      if (price == null) return;

      // 買入到價：watching + 現價 <= 買入價 * 1.03
      if (w.status === 'watching' && w.buy_price > 0 && price <= w.buy_price * 1.03) {
        if (!isNotified(w.stock_tk, 'buy')) {
          const prompt =
`${owner} 鎖定的「${w.stock_nm}(${w.stock_tk})」現價 ${price}，已接近預定買入價 ${w.buy_price}。
資訊來源：${w.source || '無'}。
請用繁體中文寫一段 80-120 字的買入提醒，語氣要冷靜理性、像個穩健的投資夥伴在提點，
提醒他確認資金、按原計畫分批進場，不要因為短線波動衝動加碼，適度使用 emoji。`;
          const msg = askGemini(cfg.gemini_key, prompt) || `${w.stock_nm}(${w.stock_tk}) 已到買入價，請確認後執行。`;
          sendLine(cfg.line_token, '🎯 投資阿喵共・買入到價\n' + msg, cfg.line_user_id);
          markNotified(w.stock_tk, 'buy');
        }
      }

      // 停利到價：holding + 現價 >= 停利價 * 0.97
      if (w.status === 'holding' && w.take_profit > 0 && price >= w.take_profit * 0.97) {
        if (!isNotified(w.stock_tk, 'tp')) {
          const prompt =
`${owner} 持有的「${w.stock_nm}(${w.stock_tk})」現價 ${price}，已逼近停利價 ${w.take_profit}！
請用繁體中文寫一段 80-120 字的恭喜訊息，語氣超級開心、誇張一點，
強調他眼光真的很棒，提醒他按原計畫獲利了結，不要貪心，多用 🎉🥳💰 等 emoji。`;
          const msg = askGemini(cfg.gemini_key, prompt) || `${w.stock_nm}(${w.stock_tk}) 已到停利價，恭喜！`;
          sendLine(cfg.line_token, '🎉 投資阿喵共・停利到價\n' + msg, cfg.line_user_id);
          markNotified(w.stock_tk, 'tp');
        }
      }

      // 停損到價：holding + 現價 <= 停損價 * 1.03
      if (w.status === 'holding' && w.stop_loss > 0 && price <= w.stop_loss * 1.03) {
        if (!isNotified(w.stock_tk, 'sl')) {
          const prompt =
`${owner} 持有的「${w.stock_nm}(${w.stock_tk})」現價 ${price}，已接近停損價 ${w.stop_loss}。
請用繁體中文寫一段 80-120 字的提醒，語氣沉穩、堅定、支持，
強調停損是保護本金、不是失敗，提醒他按計畫紀律執行、保留資金等下個機會，少量溫和的 emoji。`;
          const msg = askGemini(cfg.gemini_key, prompt) || `${w.stock_nm}(${w.stock_tk}) 已到停損價，請依紀律執行。`;
          sendLine(cfg.line_token, '🛡️ 投資阿喵共・停損到價\n' + msg, cfg.line_user_id);
          markNotified(w.stock_tk, 'sl');
        }
      }
    });
  } catch (err) {
    Logger.log('checkWatchlistAlerts 失敗：' + err.message);
  }
}

// ========== 推播功能 3：定期定額提醒 ==========

function checkDCAReminder() {
  try {
    const cfg = getConfig();
    const owner = cfg.owner_name || '朋友';
    const today = Number(Utilities.formatDate(new Date(), 'Asia/Taipei', 'd'));
    const list = getDCA().filter(d => d.deduct_day === today);
    if (!list.length) {
      Logger.log('今日無定期定額扣款');
      return;
    }
    const lines = list.map(d => `・${d.stock_nm}(${d.stock_tk})：${d.amount} 元`);
    const total = list.reduce((s, d) => s + d.amount, 0);

    const prompt =
`${owner} 今天是定期定額扣款日，要扣的標的：
${lines.join('\n')}
總扣款金額：${total} 元

請用繁體中文寫一段 100-150 字的提醒，語氣要溫暖、可愛、像為他驕傲的朋友，
要點：
- 提醒今天會扣款
- 用力稱讚他能持續定期定額的紀律，這就是長期致富的關鍵
- 鼓勵不論市場漲跌都要相信複利
- 適度使用 emoji`;

    const msg = askGemini(cfg.gemini_key, prompt) || '今天是定期定額扣款日，記得確認帳戶餘額喔！';
    sendLine(cfg.line_token, '💰 投資阿喵共・定期定額提醒\n' + msg, cfg.line_user_id);
  } catch (err) {
    Logger.log('checkDCAReminder 失敗：' + err.message);
  }
}

// ========== 推播功能 4：週五週報 ==========

function sendWeeklyReport() {
  try {
    const dow = new Date().getDay(); // 0=Sun..6=Sat
    if (dow !== 5) {
      Logger.log('非週五，略過週報');
      return;
    }
    const cfg = getConfig();
    const owner = cfg.owner_name || '朋友';
    const holdings = getHoldings();

    let totalCost = 0;
    let totalValue = 0;
    const lines = [];
    holdings.forEach(h => {
      const price = getPrice(h.stock_tk);
      if (price == null) return;
      const cost = h.cost * h.shares;
      const value = price * h.shares;
      const pl = value - cost;
      const plPct = cost > 0 ? pl / cost : 0;
      totalCost += cost;
      totalValue += value;
      lines.push(`${h.stock_nm}(${h.stock_tk}) 損益 ${pl.toFixed(0)}（${fmtPct_(plPct)}）`);
    });
    const totalPL = totalValue - totalCost;
    const totalPct = totalCost > 0 ? totalPL / totalCost : 0;

    const prompt =
`${owner} 本週收盤了，請寫一封週報。
【本週持倉狀況】
總成本：${totalCost.toFixed(0)}
總市值：${totalValue.toFixed(0)}
總未實現損益：${totalPL.toFixed(0)}（${fmtPct_(totalPct)}）
明細：
${lines.join('\n') || '（無持倉）'}

請用繁體中文寫一段 120-180 字的週報，要求：
- 開頭祝他週末快樂
- 回顧本週整體表現（不論賺賠都要正向）
- 鼓勵繼續按計畫執行、不要被一週的波動影響
- 提醒週末好好休息、陪家人朋友
- 適當 emoji，溫暖可愛`;

    const msg = askGemini(cfg.gemini_key, prompt) || '本週辛苦了，週末愉快！';
    sendLine(cfg.line_token, '📊 投資阿喵共・週五週報\n' + msg, cfg.line_user_id);
  } catch (err) {
    Logger.log('sendWeeklyReport 失敗：' + err.message);
  }
}

// ========== 觸發器設定 ==========

function setupTriggers() {
  // 先刪除所有現有觸發器
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // 每日早報 08:30
  ScriptApp.newTrigger('sendMorningReport')
    .timeBased().everyDays(1).atHour(8).nearMinute(30).create();

  // 盤中每 30 分鐘檢查向錢進
  ScriptApp.newTrigger('checkWatchlistAlerts')
    .timeBased().everyMinutes(30).create();

  // 每日 08:00 檢查定期定額
  ScriptApp.newTrigger('checkDCAReminder')
    .timeBased().everyDays(1).atHour(8).create();

  // 每週五 18:00 週報
  ScriptApp.newTrigger('sendWeeklyReport')
    .timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(18).create();

  Logger.log('所有觸發器設定完成！');
}

// ========== 測試函式 ==========

function testAll() {
  // 1. 讀取設定
  let cfg;
  try {
    cfg = getConfig();
    Logger.log('[1/4] 設定讀取成功，共 ' + Object.keys(cfg).length + ' 項');
    Logger.log('     owner_name = ' + cfg.owner_name);
  } catch (err) {
    Logger.log('[1/4] 設定讀取失敗：' + err.message);
    return;
  }

  // 2. 讀取持倉
  try {
    const h = getHoldings();
    Logger.log('[2/4] 持倉讀取成功，共 ' + h.length + ' 筆');
    h.forEach(x => Logger.log('     ' + x.stock_nm + '(' + x.stock_tk + ') ' + x.shares + ' 股'));
  } catch (err) {
    Logger.log('[2/4] 持倉讀取失敗：' + err.message);
    return;
  }

  // 3. 抓股價測試（006208）
  const price = getPrice('006208');
  if (price != null) {
    Logger.log('[3/4] Finmind 測試成功，006208 收盤價 = ' + price);
  } else {
    Logger.log('[3/4] Finmind 測試失敗，無法取得 006208 報價');
  }

  // 4. 發 LINE 測試訊息（Messaging API push）
  const ok = sendLine(cfg.line_token, '投資阿喵嘎哩共 連線測試成功 ✅', cfg.line_user_id);
  Logger.log('[4/4] LINE 發送 ' + (ok ? '成功' : '失敗'));
}

// ========== LINE Rich Menu ==========

/**
 * 一次設定 Rich Menu：建立 / 上傳圖片 / 設為全使用者預設。
 * 改下面的 RICH_MENU_IMAGE_URL 為你 catbox 上的圖網址，然後執行這個函式一次即可。
 */
// Kate 的圖原本 1527x1030 又超過 1MB，透過 images.weserv.nl 即時 resize 到 LINE 規格
const RICH_MENU_IMAGE_URL = 'https://images.weserv.nl/?url=files.catbox.moe/6f0drw.png&w=2500&h=1686&fit=cover&output=jpg&q=88';

function setupRichMenu() {
  const cfg = getConfig();
  const token = String(cfg.line_token || '').replace(/\s+/g, '');
  if (!token) { Logger.log('❌ 未設定 line_token'); return; }
  if (RICH_MENU_IMAGE_URL.indexOf('CHANGE_ME') >= 0) {
    Logger.log('❌ 請先把 RICH_MENU_IMAGE_URL 改成你的圖網址');
    return;
  }

  // 1. 刪除舊的 rich menu
  try {
    const listRes = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/list', {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (listRes.getResponseCode() === 200) {
      const list = JSON.parse(listRes.getContentText()).richmenus || [];
      list.forEach(m => {
        UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/' + m.richMenuId, {
          method: 'delete',
          headers: { Authorization: 'Bearer ' + token },
          muteHttpExceptions: true
        });
      });
      Logger.log('清掉舊 richmenu ' + list.length + ' 個');
    }
  } catch (e) { Logger.log('清舊 menu 失敗：' + e.message); }

  // 2. 建立新 rich menu（2 列 × 3 行，6 個按鈕）
  const menuDef = {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: '投資阿喵嘎哩共主選單',
    chatBarText: '📋 選單',
    areas: [
      { bounds: { x: 0,    y: 0,    width: 833, height: 843 }, action: { type: 'message', text: '查詢持倉' } },
      { bounds: { x: 833,  y: 0,    width: 834, height: 843 }, action: { type: 'message', text: '查向錢進' } },
      { bounds: { x: 1667, y: 0,    width: 833, height: 843 }, action: { type: 'message', text: '現在損益' } },
      { bounds: { x: 0,    y: 843,  width: 833, height: 843 }, action: { type: 'message', text: '今日早報' } },
      { bounds: { x: 833,  y: 843,  width: 834, height: 843 }, action: { type: 'message', text: '推播時機' } },
      { bounds: { x: 1667, y: 843,  width: 833, height: 843 }, action: { type: 'message', text: '使用說明' } }
    ]
  };

  const createRes = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(menuDef),
    muteHttpExceptions: true
  });
  if (createRes.getResponseCode() !== 200) {
    Logger.log('❌ 建立 richmenu 失敗: ' + createRes.getContentText());
    return;
  }
  const richMenuId = JSON.parse(createRes.getContentText()).richMenuId;
  Logger.log('✅ 建立 richmenu: ' + richMenuId);

  // 3. 下載圖片
  const imgRes = UrlFetchApp.fetch(RICH_MENU_IMAGE_URL, { muteHttpExceptions: true });
  if (imgRes.getResponseCode() !== 200) {
    Logger.log('❌ 下載圖片失敗: HTTP ' + imgRes.getResponseCode());
    return;
  }
  const imageBytes = imgRes.getContent();
  const isJpeg = /\.(jpe?g)$/i.test(RICH_MENU_IMAGE_URL);
  Logger.log('圖片下載成功，' + imageBytes.length + ' bytes');

  // 4. 上傳圖片到 LINE
  const uploadRes = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/richmenu/' + richMenuId + '/content', {
    method: 'post',
    contentType: isJpeg ? 'image/jpeg' : 'image/png',
    headers: { Authorization: 'Bearer ' + token },
    payload: imageBytes,
    muteHttpExceptions: true
  });
  if (uploadRes.getResponseCode() !== 200) {
    Logger.log('❌ 上傳圖片失敗: ' + uploadRes.getContentText());
    return;
  }
  Logger.log('✅ 上傳圖片成功');

  // 5. 設為全使用者預設
  const defaultRes = UrlFetchApp.fetch('https://api.line.me/v2/bot/user/all/richmenu/' + richMenuId, {
    method: 'post',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (defaultRes.getResponseCode() === 200) {
    Logger.log('🎉 Rich Menu 設定完成！打開 LINE 應該看到底部選單');
  } else {
    Logger.log('❌ 設為預設失敗: ' + defaultRes.getContentText());
  }
}

/**
 * 移除所有 Rich Menu（如果想關閉的話）
 */
function removeRichMenu() {
  const cfg = getConfig();
  const token = String(cfg.line_token || '').replace(/\s+/g, '');
  const listRes = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/list', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  const list = JSON.parse(listRes.getContentText()).richmenus || [];
  list.forEach(m => {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/' + m.richMenuId, {
      method: 'delete',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
  });
  Logger.log('已刪除 ' + list.length + ' 個 Rich Menu');
}

/**
 * 強制測試向錢進推播：忽略交易時間和門檻檢查，
 * 把每一筆 watching/holding 都當作到價推一次，
 * 也忽略「當天已推過」的記錄。
 */
function testForceAlert() {
  const cfg = getConfig();
  const owner = cfg.owner_name || '朋友';
  const list = getWatchlist();
  Logger.log('testForceAlert: ' + list.length + ' 筆向錢進');

  list.forEach(w => {
    const price = getPrice(w.stock_tk) || w.buy_price;
    let title, prompt;

    if (w.status === 'watching') {
      title = '🎯 投資阿喵共・買入到價（測試）';
      prompt = `${owner} 鎖定的「${w.stock_nm}(${w.stock_tk})」現價 ${price}，預定買入價 ${w.buy_price}。資訊來源：${w.source || '無'}。請用繁體中文寫 80-120 字買入提醒，冷靜理性、提醒按計畫分批進場，適度 emoji。`;
    } else if (w.status === 'holding') {
      title = '🎉 投資阿喵共・停利到價（測試）';
      prompt = `${owner} 持有的「${w.stock_nm}(${w.stock_tk})」現價 ${price}，停利價 ${w.take_profit}。請用繁體中文寫 80-120 字超開心恭喜訊息，多用 🎉🥳💰。`;
    } else {
      return; // sold_profit / sold_loss 不推
    }

    const msg = askGemini(cfg.gemini_key, prompt) || `${w.stock_nm}(${w.stock_tk}) 測試訊息`;
    const ok = sendLine(cfg.line_token, title + '\n' + msg, cfg.line_user_id);
    Logger.log(`  ${w.stock_tk} 推播 ${ok ? '成功' : '失敗'}`);
  });
}
