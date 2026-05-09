# INVEST OS 設定說明

本系統由 Google Apps Script + LINE Messaging API + Anthropic API 組成，所有資料來源都在同一個 Google Sheets。

> 推播使用 LINE Messaging API 的 Push Message（LINE Notify 已於 2025/03 停服，故不採用）。需要一個 Messaging API channel 的 access token，以及收訊者的 LINE userId。

## 一、Google Sheets 結構

請建立一個新 Google Sheets，**工作表名稱必須完全一致**（包含中文）。

### 工作表 ①：持倉

| stock_tk | stock_nm | shares | cost | buy_alert | sell_alert |
|----------|----------|--------|------|-----------|------------|
| 006208   | 富邦台50 | 500    | 105  | 110       | 135        |

| 欄位 | 說明 |
|------|------|
| stock_tk   | 股票代號（純文字，避免 0050 變 50） |
| stock_nm   | 股票名稱 |
| shares     | 持有股數 |
| cost       | 平均成本 |
| buy_alert  | 加碼提醒價（保留欄位） |
| sell_alert | 出場提醒價（保留欄位） |

### 工作表 ②：定期定額

| stock_tk | stock_nm | deduct_day | amount | active |
|----------|----------|------------|--------|--------|
| 006208   | 富邦台50 | 15         | 10000  | TRUE   |

| 欄位 | 說明 |
|------|------|
| stock_tk   | 股票代號 |
| stock_nm   | 股票名稱 |
| deduct_day | 每月扣款日（1-31） |
| amount     | 每次扣款金額 |
| active     | TRUE 才會被讀取，FALSE 自動略過 |

### 工作表 ③：向錢進

| stock_tk | stock_nm | buy_price | take_profit | stop_loss | source     | status   |
|----------|----------|-----------|-------------|-----------|------------|----------|
| 2330     | 台積電   | 1000      | 1200        | 950       | 大安區王同學 | watching |

| 欄位 | 說明 |
|------|------|
| stock_tk    | 股票代號 |
| stock_nm    | 股票名稱 |
| buy_price   | 預定買入價 |
| take_profit | 停利價 |
| stop_loss   | 停損價 |
| source      | 資訊來源（自由填寫） |
| status      | watching / holding / sold_profit / sold_loss |

`status` 為 `sold_profit` 或 `sold_loss` 時系統會自動忽略。

### 工作表 ④：設定

| key           | value                                  |
|---------------|----------------------------------------|
| total_assets  | 600000                                 |
| line_token    | LINE Messaging API 的 Channel access token |
| line_user_id  | 收訊者的 LINE userId（U 開頭那串）      |
| claude_key    | 你的 Anthropic API Key                 |
| owner_name    | Kate                                   |

第一列為標題列（key、value），第二列開始才是資料。

## 二、取得必要金鑰

1. **LINE Messaging API Channel access token**：
   - 到 <https://developers.line.biz/console/> 建立一個 Provider，再建立 `Messaging API` channel。
   - 進入 channel 的 `Messaging API` 分頁，捲到「Channel access token (long-lived)」按 Issue 取得。
   - 用手機 LINE 加入該 channel 的 Bot 為好友（掃 QR code），否則 push 會被拒絕。
2. **取得自己的 LINE userId**：
   - 在 channel 的 `Messaging API` 設定頁有 `Your user ID` 欄位（U 開頭，35 字元）。
   - 或在 webhook 接收任一則訊息中讀取 `events[0].source.userId`。
3. **Anthropic API Key**：前往 <https://console.anthropic.com/> 建立 API Key。
4. **Google Sheets ID**：開啟試算表後從網址複製 `/d/` 後面那一段。

## 三、部署步驟（5 步）

1. **建立試算表**：依上方四個工作表結構建立 Google Sheets，把金鑰填入「設定」工作表。
2. **建立 Apps Script**：在 Sheets 選 `擴充功能 → Apps Script`，把 `Code.gs` 內容整份貼上。
3. **填入 SHEET_ID**：把檔案頂端的 `SHEET_ID` 改成你試算表的 ID。
4. **執行 `testAll`**：在 Apps Script 編輯器選擇函式 `testAll` → 執行。第一次會要求授權（Sheets / 外部 API）。看到 LINE 收到 `INVEST OS 連線測試成功 ✅` 即代表 OK。
5. **執行 `setupTriggers`**：再次執行函式 `setupTriggers`，自動建立四個排程。完成後在「觸發條件」頁可看到 4 筆。

## 四、排程一覽

| 函式 | 頻率 | 時間 |
|------|------|------|
| sendMorningReport     | 每天 | 08:30 |
| checkWatchlistAlerts  | 每 30 分鐘 | 全天（內部會檢查交易時段） |
| checkDCAReminder      | 每天 | 08:00（僅當天 = deduct_day 才發送） |
| sendWeeklyReport      | 每週 | 週五 18:00 |

## 五、防重複通知

向錢進到價提醒會用 `PropertiesService` 紀錄當天已發送過的事件，key 格式：

```
notified_{stock_tk}_{type}_{yyyyMMdd}
```

`type` 為 `buy` / `tp` / `sl`。每天執行時自動清掉非今日的舊紀錄。

## 六、常見問題

- **股價抓不到**：Finmind 公開端點有流量限制，少量自用通常沒問題，必要時可申請免費 token 在 `getPrice` 中加上 `&token=` 參數。
- **LINE 沒收到**：依序檢查（1）Channel access token 是否正確、未過期；（2）你的帳號是否已加 Bot 為好友（Push 給沒加好友的 userId 會 403）；（3）`line_user_id` 是 `U` 開頭的 35 字元字串，不是 Display Name。Messaging API 免費方案每月 200 則訊息以內。
- **Claude 訊息空白**：API Key 沒額度或 model 名稱錯誤；先在 `testAll` 中加一行 `Logger.log(askClaude(cfg.claude_key, '說個哈囉'))` 排查。
