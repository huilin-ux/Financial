# 投資阿喵嘎哩共

投資推播自動化系統，由 Google Apps Script + LINE Messaging API + Google Gemini API（免費 tier）組成。

## 檔案

- `Code.gs` — Apps Script 主程式（直接貼進 Apps Script 編輯器）
- `SETUP.md` — 試算表結構、金鑰取得、部署步驟詳解

## 部署快速指引（5 步）

1. 依 [`SETUP.md`](./SETUP.md) 建立 Google Sheets 與四個工作表（持倉 / 定期定額 / 向錢進 / 設定）。
2. 在試算表 `擴充功能 → Apps Script`，整份貼上 `Code.gs`。
3. 修改檔案頂端的 `SHEET_ID` 為你的試算表 ID。
4. 執行 `testAll` 完成授權，並確認 LINE 收到測試訊息。
5. 執行 `setupTriggers`，自動掛上四組排程（早報 / 盤中 / 定期定額 / 週報）。

## 功能總覽

| 函式 | 用途 | 排程 |
|------|------|------|
| `sendMorningReport`    | Claude 生成的每日早報 | 每天 08:30 |
| `checkWatchlistAlerts` | 向錢進到價提醒（買入 / 停利 / 停損） | 每 30 分鐘（僅交易時段運作） |
| `checkDCAReminder`     | 定期定額扣款日提醒 | 每天 08:00 |
| `sendWeeklyReport`     | 週五收盤週報 | 每週五 18:00 |
| `setupTriggers`        | 一鍵建立所有觸發器 | — |
| `testAll`              | 連線測試 | — |
