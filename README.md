# newdoor2026｜精簡門禁系統

單門、單接待主機的本機 Docker 原型。門口瀏覽器模擬設備，按鈴才開啟影音，接聽後雙向通話，開門時先終止影音，再送出獨立的限時開鎖命令。

**目前採用電腦＋手機方案**：電腦跑 Docker 與接聽網頁，Android Chrome／iPhone Safari 當門口端。已提供區網 HTTPS、一次性 6 位配對碼、前後鏡頭選擇與螢幕保持功能。完整步驟見 [手機設定](docs/phone-setup.md)。

測試時可在 `.env` 設定 `TEST_NO_AUTH=true`，重新啟動 Docker 後，主機／手機網頁會直接連線，不必輸入金鑰或配對碼。此模式讓可連到服務的人直接使用主機操作與查閱記錄；測試完改回 `false` 並重啟即可恢復驗證。版本庫範本預設為 `false`。

## 啟動

需要 Docker Desktop（Linux containers）。在 PowerShell 執行：

```powershell
Copy-Item .env.example .env
# 編輯 .env，設定不同的 HOST_TOKEN、DOOR_TOKEN（各至少 24 字元），填入聯絡方式。
docker compose up -d --build
docker compose ps
```

- 首頁：<http://localhost:3900/>
- 主機端：<http://localhost:3900/host>，輸入 HOST_TOKEN。
- 門口模擬端：<http://localhost:3900/door>，輸入 DOOR_TOKEN。

兩端各開一個瀏覽器分頁。先連線主機，再連線門口，門口按鈴並允許攝影機與麥克風。主機可先看畫面，按「接聽通話」才允許麥克風並進行雙向通話。測試請戴耳機，兩頁同處一室會發生聲音回授。每個角色同時只允許一個連線。

預設 `RELAY_MODE=mock`，**不會操作任何實體電鎖**。測試連線金鑰保存在記憶體，不寫入網址、localStorage 或 Git。這是簡化的共享金鑰授權，尚未包含多使用者帳號與權限管理。

基本模式只綁定 `127.0.0.1`，手機請執行 `./scripts/start-phone.ps1` 啟動 Caddy 區網 HTTPS（TCP 3443），再依手機設定說明安裝公開根憑證與配對。攝影機需要 localhost 或受信任 HTTPS，HTTP 區網 IP 無法測試攝影機。手機須保持頁面前景，切換 App／鎖屏即斷線；這版不提供背景常駐。

## 已實作

- 門口按鈴、主機待接畫面、接聽後雙向聲音。
- 門口麥克風在接聽前停用；主機麥克風只在點接聽後取得。
- WebRTC 點對點影音，WebSocket 僅處理狀態與協商；沒有常駐預覽、影音轉碼或長期影音錄製。
- 開門、掛斷、無人接聽、通話逾時、任一端斷線都會結束通話並釋放媒體；不自動重撥或重送開鎖命令。
- 按鈴後約第 0、1、2 秒，由門口擷取 JPEG 上傳主機，容器 `/door_photo/` 對映本機 `./door_photo/`。
- SQLite WAL 記錄按鈴、連線、接聽、掛斷、逾時、照片、開門請求、繼電器結果與診斷。記錄存於 `./data/door.sqlite`。
- 主機端可查閱最新 100 筆事件及最近 12 張照片；API 支援 `GET /api/events?before=<event_id>` 向前分頁。
- 同一通話的重複開門被拒絕；門口憑證無權開門及讀取照片。

「前三秒」目前定義為**按鈴後**前三秒。按鈴前預錄必須常駐鏡頭，與這版的按需啟動不同。若兩秒內掛斷／開門、權限拒絕或斷線，照片可能不足三張，會記錄 `photos_incomplete` 或 `diagnostic`，不會以舊照片補數。正式設備若需無條件保留三張，需由設備端獨立完成快照任務；開門不應等待拍照。

## 操作指令

```powershell
docker compose logs -f app
docker compose stop
docker compose up -d
docker run --rm --mount "type=bind,source=$($PWD.Path),target=/app" -w /app node:24-alpine sh -c 'npm ci && npm test'
```

備份需同時包含 `data` 和 `door_photo`；最簡單方式是 `docker compose stop` 後複製兩個目錄，再 `docker compose up -d`。目前不自動刪除照片，請依實際容量與所需追溯時間規劃保留週期。

## 架構與硬體

詳見 [架構與硬體建議](docs/architecture.md) 與 [驗收清單](docs/acceptance.md)。尚未整合 SIP 門口機、GPIO 或廠牌專屬 relay API；generic HTTP adapter 只是明確的擴充契約，不能直接當作 Axis／2N 的 API 使用。
