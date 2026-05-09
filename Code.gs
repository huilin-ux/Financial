/**
 * INVEST OS 投資推播自動化系統
 * Google Apps Script + LINE Notify + Anthropic API
 *
 * 功能：
 *   1. 每日早報（08:30）
 *   2. 盤中向錢進到價提醒（每 30 分鐘）
 *   3. 定期定額扣款日提醒
 *   4. 週五收盤週報
 */

// ========== 設定區 ==========
const SHEET_ID = '【請填入你的 Google Sheets ID】';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_VERSION = '2023-06-01';
const FINMIND_BASE = 'https://api.finmindtrade.com/api/v4/data';

// ========== 資料讀取 ==========

/**
 * 讀取「設定」工作表，回傳 key-value 物件
 */
function getConfig() {
  try {
    const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('設定');
    if (!sh) throw new Error('找不到「設定」工作表');
    const data = sh.getDataRange().getValues();
    const cfg = {};
    for (let i = 1; i < data.length; i++) {
      const [k, v] = data[i];
      if (k) cfg[String(k).trim()] = v;
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
    const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('持倉');
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
    const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('向錢進');
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
    const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('定期定額');
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

// ========== 外部 API ==========

/**
 * 用 Finmind 公開 API 抓台股最新收盤價（不需 token）
 * 取最近 7 天資料中最後一筆收盤價，避免假日或停機抓不到
 */
function getPrice(tk) {
  try {
    const today = new Date();
    const start = new Date();
    start.setDate(today.getDate() - 7);
    const fmt = d => Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd');
    const url = FINMIND_BASE
      + '?dataset=TaiwanStockPrice'
      + '&data_id=' + encodeURIComponent(tk)
      + '&start_date=' + fmt(start)
      + '&end_date=' + fmt(today);
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      Logger.log('getPrice ' + tk + ' HTTP ' + res.getResponseCode());
      return null;
    }
    const json = JSON.parse(res.getContentText());
    if (!json.data || json.data.length === 0) return null;
    const last = json.data[json.data.length - 1];
    return Number(last.close);
  } catch (err) {
    Logger.log('getPrice ' + tk + ' 失敗：' + err.message);
    return null;
  }
}

/**
 * 透過 LINE Messaging API（Push Message）推送訊息
 *   token  = Channel access token（Messaging API channel）
 *   userId = 收訊者的 LINE userId（U 開頭那串）
 */
function sendLine(token, msg, userId) {
  if (!token || !userId) {
    Logger.log('sendLine 未設定 token 或 userId，跳過');
    return false;
  }
  try {
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({
        to: userId,
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

/**
 * 呼叫 Anthropic API，回傳 Claude 的純文字回覆
 */
function askClaude(apiKey, prompt) {
  if (!apiKey) {
    Logger.log('askClaude 未設定 API Key');
    return '';
  }
  try {
    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      payload: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('askClaude 失敗 HTTP ' + res.getResponseCode() + '：' + res.getContentText());
      return '';
    }
    const json = JSON.parse(res.getContentText());
    if (!json.content || !json.content.length) return '';
    return json.content.map(c => c.text || '').join('').trim();
  } catch (err) {
    Logger.log('askClaude 例外：' + err.message);
    return '';
  }
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

function sendMorningReport() {
  try {
    const cfg = getConfig();
    const owner = cfg.owner_name || '朋友';
    const holdings = getHoldings();
    const watchlist = getWatchlist();

    let totalCost = 0;
    let totalValue = 0;
    const holdingLines = [];
    holdings.forEach(h => {
      const price = getPrice(h.stock_tk);
      if (price == null) {
        holdingLines.push(`${h.stock_nm}(${h.stock_tk})：抓價失敗`);
        return;
      }
      const cost = h.cost * h.shares;
      const value = price * h.shares;
      const pl = value - cost;
      const plPct = cost > 0 ? pl / cost : 0;
      totalCost += cost;
      totalValue += value;
      holdingLines.push(
        `${h.stock_nm}(${h.stock_tk}) 現價 ${price}，未實現損益 ${pl.toFixed(0)}（${fmtPct_(plPct)}）`
      );
    });
    const totalPL = totalValue - totalCost;
    const totalPct = totalCost > 0 ? totalPL / totalCost : 0;

    const watchAlerts = [];
    watchlist.forEach(w => {
      const price = getPrice(w.stock_tk);
      if (price == null) return;
      if (w.status === 'watching' && w.buy_price > 0) {
        const diff = Math.abs(price - w.buy_price) / w.buy_price;
        if (diff <= 0.05) {
          watchAlerts.push(`${w.stock_nm}(${w.stock_tk}) 接近買入價 ${w.buy_price}（現價 ${price}）`);
        }
      }
      if (w.status === 'holding' && w.take_profit > 0) {
        const diff = Math.abs(price - w.take_profit) / w.take_profit;
        if (diff <= 0.05) {
          watchAlerts.push(`${w.stock_nm}(${w.stock_tk}) 接近停利價 ${w.take_profit}（現價 ${price}）`);
        }
      }
    });

    const prompt =
`你是 ${owner} 的投資小助手，請寫一封今日投資早報。

【持倉狀況】
總成本：${totalCost.toFixed(0)}
總市值：${totalValue.toFixed(0)}
總未實現損益：${totalPL.toFixed(0)}（${fmtPct_(totalPct)}）
明細：
${holdingLines.join('\n') || '（目前無持倉）'}

【向錢進到價狀況】
${watchAlerts.length ? watchAlerts.join('\n') : '目前沒有接近價位的標的'}

請用繁體中文寫一段 100-150 字的早報，要求：
- 開頭親切稱呼「${owner}」
- 溫暖、可愛、像朋友般的口吻
- 適當使用 emoji
- 賺錢時稱讚他眼光好
- 虧損時溫柔安慰、鼓勵長期視角
- 若有向錢進到價，提醒他按計畫執行、不要追高殺低
- 結尾給一句正能量祝福`;

    const msg = askClaude(cfg.claude_key, prompt) || '今日早報生成失敗，請稍後查看。';
    sendLine(cfg.line_token, '☀️ INVEST OS 今日早報\n' + msg, cfg.line_user_id);
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
          const msg = askClaude(cfg.claude_key, prompt) || `${w.stock_nm}(${w.stock_tk}) 已到買入價，請確認後執行。`;
          sendLine(cfg.line_token, '🎯 向錢進・買入到價\n' + msg, cfg.line_user_id);
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
          const msg = askClaude(cfg.claude_key, prompt) || `${w.stock_nm}(${w.stock_tk}) 已到停利價，恭喜！`;
          sendLine(cfg.line_token, '🎉 向錢進・停利到價\n' + msg, cfg.line_user_id);
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
          const msg = askClaude(cfg.claude_key, prompt) || `${w.stock_nm}(${w.stock_tk}) 已到停損價，請依紀律執行。`;
          sendLine(cfg.line_token, '🛡️ 向錢進・停損到價\n' + msg, cfg.line_user_id);
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

    const msg = askClaude(cfg.claude_key, prompt) || '今天是定期定額扣款日，記得確認帳戶餘額喔！';
    sendLine(cfg.line_token, '💰 INVEST OS 定期定額提醒\n' + msg, cfg.line_user_id);
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

    const msg = askClaude(cfg.claude_key, prompt) || '本週辛苦了，週末愉快！';
    sendLine(cfg.line_token, '📊 INVEST OS 週五週報\n' + msg, cfg.line_user_id);
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
  const ok = sendLine(cfg.line_token, 'INVEST OS 連線測試成功 ✅', cfg.line_user_id);
  Logger.log('[4/4] LINE 發送 ' + (ok ? '成功' : '失敗'));
}
