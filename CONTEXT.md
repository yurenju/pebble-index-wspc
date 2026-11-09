# Pebble Index → WSPC Drive

把 Pebble Index 01 錄音戒指產生的逐字稿，轉送進擁有者自己的 WSPC Drive 裡的一個檔案。只給一個人用。

## Language

**擁有者（Owner）**:
部署並使用這個服務的那一個人。服務只寫進擁有者的 WSPC Drive，沒有其他使用者，也沒有登入。
_Avoid_: 使用者、帳號、member

**Webhook**:
Relay 對外的那一個網址加驗證 secret，由擁有者貼進 Pebble app；Pebble app 的兩種手勢都可以指向它，逐字稿全部送到同一個目的地。
_Avoid_: endpoint、hook、trigger

**目的地（Destination）**:
逐字稿要接上去的那一個 WSPC Drive 檔案，由 library 加上檔案路徑決定，寫在部署設定裡。
_Avoid_: target、output

**逐字稿（Transcript）**:
Pebble app 對一次錄音轉出的一段純文字，一次 webhook 請求帶一段。
_Avoid_: transcription、note、memo

**Relay**:
這個服務本身在 Pebble 與 WSPC 之間扮演的角色：收 Pebble 的請求、轉成 WSPC 要的格式再寫進去。
_Avoid_: proxy、bridge
