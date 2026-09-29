# Pebble Index → WSPC Drive

把 Pebble Index 01 錄音戒指產生的逐字稿，轉送進使用者自己的 WSPC Drive 檔案。

## Language

**使用者（User）**:
用自己的 WSPC 帳號登入這個服務的人；任何有 WSPC 帳號的人都可以成為使用者。每個使用者只會寫進自己的 WSPC Drive。
_Avoid_: 帳號、member

**Webhook**:
使用者建立的一組專屬網址加驗證 secret，貼進 Pebble app 後，逐字稿會送到這裡；每個 Webhook 對應剛好一個目的地。
_Avoid_: endpoint、hook、trigger

**目的地（Destination）**:
Webhook 收到的逐字稿要寫進的那個 WSPC Drive 檔案，由 library 加上檔案路徑決定。
_Avoid_: target、output

**逐字稿（Transcript）**:
Pebble app 對一次錄音轉出的一段純文字，一次 webhook 請求帶一段。
_Avoid_: transcription、note、memo

**Relay**:
這個服務本身在 Pebble 與 WSPC 之間扮演的角色：收 Pebble 的請求、轉成 WSPC 要的格式再寫進去。
_Avoid_: proxy、bridge
