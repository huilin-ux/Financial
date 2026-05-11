# 投資阿喵共・朋友 Setup 教學

從零開始把這套系統建起來，全程**免費**。

整套架構：

```
Google Sheet（你的資料）
       ↑↓
   Apps Script（每天自動跑 + 提供 API）
   ┌────┴────┐
   ↓         ↓
LINE Bot   Dashboard（手機/電腦看板）
```

完成後你會有：
- 📱 LINE Bot 每天早報 + 到價推播
- 💬 跟 LINE Bot 對話記錄交易
- 🖥 Dashboard 看板，手機加桌面 icon

---

## 你要準備

| 帳號 | 用途 | 已有？ |
|------|------|-------|
| Google 帳號 | Sheets + Apps Script | 一定有 |
| LINE 帳號 | 收推播訊息 | 一定有 |
| 5 分鐘耐心 | LINE Bot 申請 | — |

**完全免費**，不用信用卡。

---

## STEP 1：建 Google Sheet（5 分鐘）

### 1-1 建立試算表

1. 開 <https://sheets.new>（會建一個新的 Google Sheet）
2. 改名「**INVEST OS**」（左上點檔名修改）
3. **建立 4 個分頁**，名字必須一字不差：
   - `持倉`
   - `定期定額`
   - `向錢進`
   - `設定`

底部 + 按鈕新增分頁，雙擊頁籤改名。

### 1-2 填入欄位（每個分頁第一列複製貼上）

**持倉**（一行貼進去）：
```
stock_tk	stock_nm	shares	cost	buy_alert	sell_alert
006208	富邦台50	500	105	110	135
```

**定期定額**：
```
stock_tk	stock_nm	deduct_day	amount	active
006208	富邦台50	15	10000	TRUE
```

**向錢進**：
```
stock_tk	stock_nm	buy_price	take_profit	stop_loss	source	status
2330	台積電	1000	1200	950	大安區王同學	watching
```

**設定**（先填佔位符，後面會回來補上）：
```
key	value
total_assets	600000
line_token	待填
line_user_id	待填
gemini_key	待填
owner_name	你的名字
```

⚠️ **重要**：`持倉` 分頁的 `stock_tk` 那一欄，如果是 ETF（如 006208），Google Sheet 會吃掉前面的 0。解法：
- 選 A 欄整列
- 格式 → 數字 → **純文字**
- 重新打 `006208`

### 1-3 複製 SHEET_ID

網址列看到 `https://docs.google.com/spreadsheets/d/【這一串】/edit`，**那串就是 SHEET_ID**，先記在筆記本。

---

## STEP 2：申請 Gemini API Key（2 分鐘、免費）

1. 開 <https://aistudio.google.com/apikey>
2. 用 Google 帳號登入
3. 點 **「Create API key」**
4. 選一個 Google Cloud 專案（沒有就讓它幫你建）
5. 複製 `AIzaSy...` 那一串

⚠️ **不用綁信用卡**。每天 1500 次免費，你一天用不到 10 次。

回到 Google Sheet 「設定」分頁，把 `gemini_key` 那欄的「待填」改成你拿到的 key。

---

## STEP 3：建 LINE Bot（10 分鐘、最複雜的部分）

### 3-1 建 LINE 官方帳號（不是個人帳號）

1. 開 <https://entry.line.biz/start/tw>
2. 用你的 LINE 帳號登入
3. 選 **建立未認證帳號**（不要選認證帳號，那要審核）
4. 填：
   - 帳號名稱：隨便取，例如「我的投資 Bot」
   - 業種：個人 → 其他
   - Email：你的信箱
5. 完成

### 3-2 關掉自動回應 + 設定隱私

1. 進 LINE Official Account Manager
2. **設定 → 帳號設定** → 點頭像旁「**編輯基本檔案與公開設定**」
3. **「公開網頁版基本檔案」關掉** ← 別人就搜不到
4. 回 **設定 → 回應設定**：
   - 加入好友的歡迎訊息 → **關**
   - 自動回應訊息 → **關**

### 3-3 啟用 Messaging API

1. **設定 → Messaging API → 啟用 Messaging API**
2. 選擇服務提供者（建一個新的，名字隨便）
3. 隱私權政策 / 服務條款：兩欄都留空，按 OK
4. 完成後會看到 Channel ID、Channel secret，**不用管它們**

### 3-4 拿 Channel Access Token

1. 開 <https://developers.line.biz/console/>
2. 進你剛建的 Provider → 點你的 channel
3. 切到 **「Messaging API」** 分頁
4. 滑到底找 **「Channel access token」** 區塊
5. 按 **「Issue」** → 跑出一長串 token（170+ 字元）
6. **完整複製**

回 Google Sheet 「設定」分頁，把 `line_token` 那欄改成這串 token。

### 3-5 拿你的 LINE User ID

1. 同一個 channel，切到 **「Basic settings」** 分頁
2. 滑到最底找 **「Your user ID」**
3. 複製那串 `U...`（U 開頭 33 字元）

回 Google Sheet 「設定」分頁，`line_user_id` 改成這串。

### 3-6 加 Bot 為好友 ⚠️ 絕對不能漏

1. 切回 **Messaging API** 分頁
2. 找到 **QR code**
3. **手機 LINE 掃 QR code → 加為好友**

⚠️ 沒加好友的話 Bot 推訊息會 403 失敗，整個系統會無法運作。

---

## STEP 4：部署 Apps Script（10 分鐘）

### 4-1 開 Apps Script

1. 回到你的 Google Sheet
2. 上方 **擴充功能 → Apps Script**
3. 會跳出新分頁

### 4-2 貼程式碼

1. 把編輯區裡預設的 `function myFunction(){}` **全選刪掉**
2. 開這個連結，整個頁面內容**全選複製**：
   <https://raw.githubusercontent.com/huilin-ux/Financial/main/Code.gs>
3. 貼回 Apps Script 編輯區
4. **找到第一行 `const SHEET_ID = '...'`，把單引號裡那串改成你的 SHEET_ID**（Step 1-3 記的那串）
5. 按 💾 儲存

### 4-3 跑測試

1. 編輯區上方函式下拉選單，選 **`testAll`**
2. 按 **▶ 執行**
3. 第一次跳「需要授權」→ 檢視權限 → 選你的帳號 → 進階 → 移至 → **允許**
4. 看「執行記錄」應該顯示：
   ```
   [1/4] 設定 OK
   [2/4] 持倉 OK
   [3/4] Yahoo OK
   [4/4] LINE 成功
   ```
5. **手機 LINE 應該收到「INVEST OS 連線測試成功 ✅」**

如果 LINE 沒收到 → 你 Bot 還沒加好友（回 Step 3-6）。

### 4-4 設定自動排程

1. 函式選單選 **`setupTriggers`** → ▶ 執行
2. 完成後左側 ⏰ **觸發條件** 頁面會看到 4 個排程

🎉 **LINE Bot 已經完成，明天 08:30 就會收到第一封早報。**

### 4-5 部署成 Web App（給 Dashboard 用）

1. 編輯器右上 **「部署」→ 新增部署**
2. 左側齒輪 ⚙ → 選 **「網頁應用程式」**
3. 填：
   - 說明：`API`
   - 執行身分：**我**
   - 誰可以存取：**任何人**
4. 按 **「部署」** → 再次授權
5. 完成後會給你一個網址 `https://script.google.com/macros/s/.../exec`
6. **完整複製這個 URL**

---

## STEP 5：啟用 LINE 對話功能

1. 開 <https://developers.line.biz/console/>
2. 進你的 channel → **Messaging API** 分頁
3. 找 **Webhook settings** → **Webhook URL**：
   - 點 **Edit** → **貼上你的 Web App URL**（Step 4-5）→ Update
   - 按 **Verify**（會跳 302 錯誤是正常的，可忽略）
   - **Use webhook** 開關 → 打開 ✅

完成！現在你可以在 LINE 傳訊息給 Bot 互動：
- 「說明」→ 看到所有指令
- 「查持倉」→ 列出持倉
- 「買 2330 10股 1050」→ Bot 自動寫進 Sheet

---

## STEP 6：使用 Dashboard 看板

### 你的專屬一鍵連結

```
https://huilin-ux.github.io/Financial/?api=【你的 Web App URL】
```

把 `【你的 Web App URL】` 換成 Step 4-5 那串，例如：

```
https://huilin-ux.github.io/Financial/?api=https://script.google.com/macros/s/AKfycbz.../exec
```

### 加桌面 icon

1. 手機 Safari 開上面那條長連結
2. 等載入完（設定頁應該顯示 🟢 已連動 Google Sheet）
3. 下方 **分享 ⬆️ → 加入主畫面** → 命名「INVEST OS」
4. 桌面就有 icon 可以直接點開

### 換新裝置

開那條**長連結**（含 `?api=`），系統自動記住，之後開 icon 就可以。

---

## 系統運作後

### LINE Bot 自動推播

| 時機 | 內容 |
|------|------|
| 每天 08:30 | 個人化早報（Gemini + Google Search 真實數據）|
| 扣款日 08:00 | 定期定額提醒 |
| 盤中每 30 分 | 向錢進到價推播（買入/停利/停損 ±3% 內）|
| 每週五 18:00 | 週報 |

### LINE 對話互動

你可以隨時傳訊息給 Bot：
- 「買 2330 10股 1050」記錄交易
- 「賣 2454 5股 1400 賺 2000」
- 「新增向錢進 2603 長榮 買100 利130 損90」
- 「查持倉」「查向錢進」「現在損益」「今日早報」「說明」

### Dashboard 看板

- 任何時候編輯持倉 / 向錢進 / 交易 / 設定
- 自動同步到 Google Sheet → LINE Bot 自動讀新資料
- 三邊（Sheet / LINE / Dashboard）共用一份資料源

---

## 常見問題

### Q1：可以跟 Kate 共用 Bot 嗎？
不行。LINE Bot 跟 Google Sheet 都是各自的。但 **Dashboard 程式可以共用**——我們是同一個網址，只是 `?api=` 後面接的是各自的 Apps Script。

### Q2：股價來源要錢嗎？
不要。用 Yahoo Finance 公開 API，免費無限。

### Q3：Gemini 要錢嗎？
不要。免費版每天 1500 次，個人用永遠用不完。

### Q4：LINE 推播要錢嗎？
LINE Messaging API 免費版每月 200 則訊息。
- 早報 + 週報 = 每月 ~31 則
- 定期定額（每月 1 次）= 1 則
- 向錢進到價（看你設多少）= 0~30 則
- 你跟 Bot 對話（Reply）= **不算入 200 則限制**

正常使用每月用 50-100 則，**遠低於 200 上限**，永遠免費。

### Q5：LINE Bot 別人會看到嗎？
不會。
- 你的 LINE 官方帳號**不公開搜尋**（Step 3-2 已關閉）
- 只有你加了 Bot 為好友才能用
- Bot 程式碼有 user ID 過濾，**陌生人傳訊息 Bot 不回**

### Q6：朋友還想做這個我可以教嗎？
直接把這份文件給他。資料完全分開，每個人的 Bot / Sheet / 設定都是獨立的。

### Q7：Dashboard 上 UX 我覺得很奇怪 / 想改某個功能
找 Kate 跟她說，她會請 Claude 改 GitHub 上的 dashboard。改完所有人下次刷新就會看到新版（**因為我們共用同一個 GitHub Pages**）。

### Q8：我可以自己改 Code.gs 加新功能嗎？
完全可以！每個人的 Apps Script 都是自己的副本，你怎麼改都不影響別人。但**改完要重新貼到 Apps Script + 重新部署**才會生效。

### Q9：手機沒收到推播？
依序檢查：
1. Bot 加好友了沒？（Step 3-6）
2. Sheet「設定」分頁的 `line_token` / `line_user_id` 有沒有空格？
3. Apps Script 跑 `testAll` 看執行記錄哪一步失敗

### Q10：資料安全嗎？
- Google Sheet 預設只有你看得到
- Apps Script Web App URL 雖然公開，但需要 API_KEY（程式裡 `meow-cat-financial-2026`）
- 想更嚴的話可以改 API_KEY 變成你自己的字串
- LINE token 只存在 Sheet「設定」分頁，Google Drive 受 Google 保護

---

## 你完成的標誌

- [ ] Google Sheet 4 個分頁建好
- [ ] Gemini API Key 已填到 Sheet
- [ ] LINE Bot 建好，加為好友
- [ ] Apps Script 貼好程式碼 + SHEET_ID 改好
- [ ] 跑 `testAll` LINE 收到測試訊息
- [ ] 跑 `setupTriggers` 看到 4 個排程
- [ ] Web App 部署完，URL 拿到手
- [ ] LINE Channel Webhook URL 設好
- [ ] 傳「說明」給 Bot 收到回覆
- [ ] Dashboard 連結加到手機桌面

10 個 ✅ 全勾完 → 你的「投資阿喵共」上線了 🎉

有問題隨時找 Kate 或開 GitHub issue。
