# WSPC OAuth 給第三方網頁服務用：Worker 怎麼接

> 調查日期：2026-09-29。只看 WSPC 官方文件、官方 OpenAPI 與 OAuth metadata，每一點都附來源；找不到的標「未確認」。回答 [issue #3](https://github.com/yurenju/pebble-index-wspc/issues/3)。

**前提**：[上一份研究](pebble-index-to-wspc-drive.md)已經確定要在 Pebble app 與 WSPC Drive 中間放一支 relay（Cloudflare Worker），但當時假設 relay 用的是使用者手動建好貼進來的長期 API key。現在的設計改成：使用者在 Worker 的管理網頁上「用 WSPC 帳號登入」，Worker 拿到 OAuth token，之後逐字稿進來時（使用者多半不在線上），Worker 自己拿這組 token 去寫使用者的 Drive。所以 Worker 需要 OAuth 做到三件事：知道登入的是誰、能呼叫 Drive REST API、以及在使用者離線時靠 refresh token 自己續命。

**結論：做得到，而且不需要跟 WSPC 申請任何東西。** WSPC 支援 Dynamic Client Registration，Worker 自己打一次註冊 API 就拿到 `client_id`；它只收 public client（沒有 client secret，一律 PKCE），redirect URI 必須完全比對。scope 只有 `wspc:full`，等於整個帳號的權限，沒有「只寫 Drive」。access token 4 小時過期，refresh token 每用一次就換新（rotation），**拿已經換掉的舊 refresh token 再用一次，會讓整串 token 全部作廢、使用者被登出**，所以 Worker 對同一個使用者的 refresh 必須排隊、一次只跑一個。使用者 id 用 `GET /auth/me` 的 `user_id`，沒有 id token 也沒有 userinfo。refresh token 的有效期限、使用者從哪裡撤銷授權、撤銷後 access token 是不是立刻失效，官方都沒寫。

---

## 名詞

- **Client**：在 OAuth 裡代表「要存取使用者資料的那個應用程式」，這裡就是 Worker。WSPC 用 `client_id` 認它。
- **DCR（Dynamic Client Registration，RFC 7591）**：應用程式自己打一支 API 就能註冊成 client，不必到開發者後台手動申請。
- **Public client／confidential client**：confidential client 有一把 client secret，換 token 時要附上證明「我真的是這個 app」；public client 沒有 secret，改靠 PKCE 防止授權碼被別人拿去用。
- **PKCE**：登入前先產生一串隨機的 `code_verifier`，把它的雜湊（`code_challenge`）送去授權頁；換 token 時再附原文。中途被攔下授權碼的人沒有原文，換不到 token。
- **Resource indicator（`resource` 參數，RFC 8707）**：告訴授權伺服器「這張 token 要拿去打哪個服務」，token 會被綁在那個服務上。
- **Refresh token rotation**：每次用 refresh token 換新的 access token，伺服器同時發一把新的 refresh token，舊的那把作廢。
- **Token family**：同一次登入衍生出來的所有 access／refresh token。WSPC 發現有人重用舊 token 時，會把整個 family 一起撤銷。

---

## 1. Client 怎麼註冊

- **有 DCR**：`POST https://api.wspc.ai/auth/oauth/register`，不需要驗證，body 只要 `client_name` 與 `redirect_uris`，回傳 `client_id`（格式像 `oac_...`）。官方建議「一個 app 註冊一次，把 client_id 存起來重複用」。來源：[auth OpenAPI `oauth_client_register`](https://api.wspc.ai/auth/openapi.json)、[llms.txt](https://wspc.ai/llms.txt) 的 OAuth 段落、[OAuth metadata](https://api.wspc.ai/.well-known/oauth-authorization-server) 的 `registration_endpoint`。
- **手動後台**：文件完全沒提到能手動建 OAuth client 的開發者後台（網頁主控台只有 API key 管理頁 `app.wspc.ai/settings/api-keys`，見 [llms-full.txt](https://wspc.ai/llms-full.txt)）。有沒有這種後台：未確認。對我們來說不需要，DCR 就夠了。
- **沒有 client secret**：「WSPC only supports public PKCE clients. Client secrets are not generated or returned.」`token_endpoint_auth_method` 只能是 `none`，metadata 的 `token_endpoint_auth_methods_supported` 也只有 `["none"]`；PKCE 只支援 `S256`。來源：[auth OpenAPI](https://api.wspc.ai/auth/openapi.json)、[OAuth metadata](https://api.wspc.ai/.well-known/oauth-authorization-server)。
  - 這代表 Worker 雖然跑在伺服器上，對 WSPC 來說仍是 public client。**任何人只要拿到某個使用者的 refresh token，加上公開的 `client_id`，就能換出 token**，沒有 secret 這一道防線，所以 refresh token 在 Worker 裡要加密保存。這是推論，不是文件原話。
- **Redirect URI 限制**：註冊時列出的 `redirect_uris` 必須和授權、換 token 時送的 `redirect_uri`「exactly match」，三個步驟要一字不差。可以一次註冊多個（陣列），官方範例用的是 `https://example.com/oauth/callback` 這種一般 HTTPS 網址。來源：[auth OpenAPI](https://api.wspc.ai/auth/openapi.json)、[llms.txt](https://wspc.ai/llms.txt)。
  - 是否強制 HTTPS、能不能用萬用字元、能不能用 `*.workers.dev`：文件沒寫，未確認。
  - **沒有修改已註冊 client 的 API**（auth OpenAPI 裡只有 register，沒有 RFC 7592 的更新端點），要換網域或加 redirect URI 只能重新註冊一個新 client。這代表舊 client 發出去的 refresh token 還綁在舊 `client_id` 上（見第 3 點的 `refresh_token_client_mismatch`），換 client 等於要所有使用者重新登入。建議一開始就把正式網址與本機開發網址一起註冊。
- **限制**：DCR 有每 IP 的頻率限制（429）。來源：[auth OpenAPI](https://api.wspc.ai/auth/openapi.json)。
- 使用者在同意頁看到的名稱是註冊時的 `client_name`；同意頁上可以切換或新增帳號，所以**最後按同意的帳號不一定是一開始登入的那個**。來源：[auth OpenAPI](https://api.wspc.ai/auth/openapi.json)、[llms.txt](https://wspc.ai/llms.txt)。

<details>
<summary>註冊與登入流程的請求範例（依官方 llms.txt 整理，未實際送出）</summary>

```bash
# 1. 註冊一次，存下 client_id
curl -X POST https://api.wspc.ai/auth/oauth/register \
  -H 'content-type: application/json' \
  -d '{"client_name":"Pebble → WSPC Relay",
       "redirect_uris":["https://relay.example.com/oauth/callback","http://localhost:8787/oauth/callback"],
       "grant_types":["authorization_code","refresh_token"],
       "token_endpoint_auth_method":"none"}'

# 2. 把瀏覽器導去授權頁（每次登入都產生新的 code_verifier 與 state）
https://app.wspc.ai/authorize?response_type=code&client_id=<client_id>
  &redirect_uri=https%3A%2F%2Frelay.example.com%2Foauth%2Fcallback
  &code_challenge=<BASE64URL(SHA256(code_verifier))>&code_challenge_method=S256
  &resource=https%3A%2F%2Fapi.wspc.ai&scope=wspc%3Afull&state=<state>

# 3. callback 檢查 state 後換 token
curl -X POST https://api.wspc.ai/auth/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode 'code=<code>' \
  --data-urlencode 'code_verifier=<code_verifier>' \
  --data-urlencode 'client_id=<client_id>' \
  --data-urlencode 'redirect_uri=https://relay.example.com/oauth/callback' \
  --data-urlencode 'resource=https://api.wspc.ai'
# → {"access_token":"at_...","token_type":"Bearer","expires_in":14400,"refresh_token":"rt_...","scope":"wspc:full"}
```
</details>

## 2. Scope

- **只有 `wspc:full`**。官方說明：「Treat it as root-level access for the authenticated user across all services」，細分的 scope（例如 `todo:read`）還沒有，傳了也不會給比較小的權限。Drive 指南特別要求跟使用者講清楚「這是整個 Workspace 的權限，不是只有 Drive」。來源：[llms.txt](https://wspc.ai/llms.txt) Scopes 段、[llms-drive.txt](https://wspc.ai/llms-drive.txt)、[OAuth metadata](https://api.wspc.ai/.well-known/oauth-authorization-server) 的 `scopes_supported: ["wspc:full"]`。
- 例外：MCP 伺服器的 [protected-resource metadata](https://mcp.wspc.ai/.well-known/oauth-protected-resource) 寫的是 `scopes_supported: ["mcp"]`、`resource: "https://mcp.wspc.ai"`，跟其他文件的 `wspc:full` 不一致。那是給 MCP 用的，Worker 不走 MCP，照 REST 的 `wspc:full` 就好。

## 3. Refresh token

- **access token 4 小時**（`expires_in: 14400`）。官方建議用回應裡的 `expires_in`，不要寫死。來源：[llms.txt](https://wspc.ai/llms.txt)、[auth OpenAPI `oauth_token_exchange`](https://api.wspc.ai/auth/openapi.json)、[llms-drive.txt](https://wspc.ai/llms-drive.txt)。
- **refresh token 多久過期：未確認。** 有 `refresh_token_expired` 這個錯誤，所以確實會過期，但哪裡都沒寫天數，也沒寫是固定期限還是每次使用都會延長。
- **有 rotation**：每次 refresh 都會發一把新的 refresh token，舊的作廢。來源：[auth OpenAPI](https://api.wspc.ai/auth/openapi.json)（「Old refresh tokens are invalidated immediately upon exchange」）。
- **同一把 refresh token 用兩次會怎樣**：兩份官方文件講法有點出入。
  - [llms.txt](https://wspc.ai/llms.txt) 說得比較細：舊的 refresh token 在「它換出來的新 token 被用過」之前都還有效，所以萬一換 token 的回應在網路上掉了，可以拿手上那把舊的再試一次。但只要新的那組被用過，同一個上層衍生出的其他組就全部失效；這時再拿其中任何一組出來，會被當成重放攻擊（replay），**整個 token family 撤銷、使用者被登出**。
  - [auth OpenAPI](https://api.wspc.ai/auth/openapi.json) 則說舊 token 「立刻」失效，但又提到有一段「tolerance window」（容許時間），超過這段時間才拿已換掉的 token 回來，才會回 `refresh_token_reused` 並撤銷整個 family，而且說明這是「有東西還拿著一份過期的憑證」的訊號，不是一般的過期。
  - 兩份一起看，大意是：**剛換完的短時間內重送還救得回來，之後就會把使用者踢出去**。容許時間多長、「新 token 被用過」指的是用新的 access token 打 API 還是用新的 refresh token 再換一次：未確認。
- **refresh 失敗時的錯誤**：一律 `400 { "error": "invalid_grant" }`，原因寫在 `error_description`，可能是 `refresh_token_unknown`、`refresh_token_expired`、`refresh_token_revoked`、`refresh_token_reused`、`refresh_token_client_mismatch`、`refresh_token_resource_mismatch`。來源：[auth OpenAPI](https://api.wspc.ai/auth/openapi.json)、[llms.txt](https://wspc.ai/llms.txt)。注意 OpenAPI 另一處又說 `error_description` 「不要拿來判斷流程」，所以程式可以用它分辨要不要提醒使用者，但遇到任何 `invalid_grant` 最後都只能請使用者重新登入。
- **對 Worker 的影響**：官方 Drive 指南要求「先把新的一組 token 存好，再拿去用」、「同時有多個請求時只能跑一個共用的 refresh，不能各自 refresh」（[llms-drive.txt](https://wspc.ai/llms-drive.txt)）。Worker 上兩筆逐字稿幾乎同時進來、各自發現 token 過期而各自 refresh，就正好是會觸發 `refresh_token_reused` 的情況，所以每個使用者的 refresh 需要一個單一的協調點（例如以使用者為單位的 Durable Object）。這部分交給「token 怎麼保存與更新」那張票決定。
- `resource` 要前後一致：refresh 時帶的 `resource` 必須等於或包含原本綁定的那個，否則回 `refresh_token_resource_mismatch`。來源：[auth OpenAPI](https://api.wspc.ai/auth/openapi.json)。

<details>
<summary>refresh 的請求與錯誤範例（依官方 OpenAPI 整理）</summary>

```bash
curl -X POST https://api.wspc.ai/auth/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=refresh_token' \
  --data-urlencode 'refresh_token=rt_...' \
  --data-urlencode 'client_id=<client_id>'
# 成功 → 新的 access_token + 新的 refresh_token（舊的作廢）

# 失敗（例：重用已換掉的 refresh token）
# HTTP 400
# {"error":"invalid_grant","error_description":"refresh_token_reused"}
```
</details>

## 4. access token 能不能直接打 Drive REST API

**可以，而且有明確來源。** [Drive OpenAPI](https://api.wspc.ai/drive/openapi.json) 的 `bearerAuth` 寫著「Protected operations accept a WSPC OAuth 2.1 access token or a long-lived WSPC API key as the Bearer credential」，每個 Drive 端點都要求這個 `bearerAuth`。[llms.txt](https://wspc.ai/llms.txt) 的 API reference 段落與 [llms-drive.txt](https://wspc.ai/llms-drive.txt)（「API calls send Authorization: Bearer <access_token>」）也講一樣的事。

條件是 token 要綁在對的 resource 上：授權與換 token 時帶 `resource=https://api.wspc.ai`（[llms.txt](https://wspc.ai/llms.txt)、[llms-drive.txt](https://wspc.ai/llms-drive.txt)）。MCP 文件提到「token issued for a different resource」會被拒（[llms-full.txt](https://wspc.ai/llms-full.txt) MCP Troubleshooting），所以不要拿 MCP 流程拿到的 token 來打 REST。不帶 `resource` 時伺服器會用預設的 WSPC API audience（[auth OpenAPI](https://api.wspc.ai/auth/openapi.json)），但照官方範例明確帶上比較保險。

另外，`https://api.wspc.ai/.well-known/oauth-protected-resource` 在調查時回 `522`（Cloudflare 連不到來源伺服器），REST 這邊的 protected-resource metadata 看不到，不影響結論。

## 5. 怎麼知道登入的是誰

- **沒有 id token，也沒有 userinfo 端點。** `/.well-known/openid-configuration` 只是 OAuth metadata 的別名（內容跟 `oauth-authorization-server` 一模一樣），沒有 `userinfo_endpoint`、`jwks_uri`；`response_types_supported` 只有 `code`；token 回應裡沒有 `id_token`。來源：[openid-configuration](https://api.wspc.ai/.well-known/openid-configuration)、[auth OpenAPI](https://api.wspc.ai/auth/openapi.json)（OIDC 那一條的 summary 就叫「OIDC discovery alias」）。
- **用 `GET https://api.wspc.ai/auth/me`**：拿 access token 打它，回 `user_id`、`email`、`role`，有設定的話再加 `display_name`。`user_id`（格式像 `usr_...`）官方寫明「Stable identifier ... Same value across API keys and OAuth tokens for the same human」，可以拿來當 Worker 裡的使用者主鍵。email 不適合當主鍵（文件沒保證不會變）。來源：[auth OpenAPI `auth_me`](https://api.wspc.ai/auth/openapi.json)。
- **要注意的地方**：`user_id` 是穩定的，但使用者所在的 Workspace 可能會變。接受別人的 Workspace 邀請時，「Switches the caller's org to the invite's org ... The caller loses access to data scoped to their previous org」，而 Drive library 是綁在 Workspace 上的（[auth OpenAPI `/auth/invites/{id}/accept`](https://api.wspc.ai/auth/openapi.json)）。所以 Worker 記下來的目的地 library 有可能某天突然變成 `NOT_FOUND`（Drive 對「不存在或跨 org」都回這個，見 [Drive OpenAPI](https://api.wspc.ai/drive/openapi.json)），不要把它當成程式錯誤。需要 Workspace id 時可以打 `GET /auth/me/org` 拿 `id`。

<details>
<summary>/auth/me 範例（官方 OpenAPI 的範例值）</summary>

```bash
curl https://api.wspc.ai/auth/me -H "Authorization: Bearer at_..."
# OAuth token 的回應沒有 api_key_id
# {"user_id":"usr_01HW3K4N9V5G6Z8C2Q7B1Y0M3F","email":"alice@example.com","role":"member"}
```
</details>

## 6. 使用者撤銷授權之後

- **使用者從哪裡撤銷：未確認。** 隱私權政策說使用者可以「revoke connected clients, and sign out to clear active access」（[llms-full.txt](https://wspc.ai/llms-full.txt) 第 9 節），但沒寫是在主控台的哪一頁，auth OpenAPI 裡也沒有列出或撤銷「已授權 app」的端點。
- **Worker 自己撤銷**（例如使用者在管理網頁按「中斷連結」）：`POST /auth/oauth/revoke`，body 帶 `token`（可加 `token_type_hint`），不論 token 存不存在一律回 `200 {}`。Drive 指南建議登出時撤銷整個 token family。來源：[auth OpenAPI `oauth_token_revoke`](https://api.wspc.ai/auth/openapi.json)、[llms-drive.txt](https://wspc.ai/llms-drive.txt)。
- **撤銷後 Worker 會看到的錯誤**（依文件推斷，沒有一份文件直接描述「使用者撤銷後」這個情境）：
  - refresh 時：`400 {"error":"invalid_grant","error_description":"refresh_token_revoked"}`。這個錯誤碼列在 [auth OpenAPI](https://api.wspc.ai/auth/openapi.json) 的 refresh 失敗原因裡。
  - 打 Drive API 時：`401 {"error":{"code":"AUTH_REQUIRED",...}}`，Drive 的錯誤碼表對「Missing or invalid Bearer token」只有這一個碼（[Drive OpenAPI](https://api.wspc.ai/drive/openapi.json)）。`/auth/me` 的 401 說明也列了「has been revoked」這個情況（[auth OpenAPI](https://api.wspc.ai/auth/openapi.json)）。
  - **撤銷後已經發出去的 access token 是立刻失效，還是會撐到 4 小時到期：未確認。** Worker 不能只靠 access token 還能用就判定授權還在。
- 實務上 Worker 的處理方式都一樣：遇到 `invalid_grant`（任何原因）或 refresh 後仍然 401，就把這個使用者標成「需要重新登入」，停止寫入，等他回管理網頁重新授權。這時 Pebble 送來的逐字稿要怎麼辦（丟掉、暫存、回錯誤給 Pebble），交給後續票決定。

---

## 未確認事項

1. refresh token 的有效期限，以及是固定期限還是每次使用會延長。
2. refresh token 重用的「tolerance window」有多長；「新 token 被用過」的定義。
3. redirect URI 是否強制 HTTPS、是否接受 `*.workers.dev`。
4. 是否有手動建 OAuth client 的開發者後台。
5. 使用者在 WSPC 主控台的哪裡撤銷第三方授權；撤銷後既有 access token 是否立刻失效。
6. `api.wspc.ai/.well-known/oauth-protected-resource` 調查時回 522，內容未知。

## 本次查過的來源

- [wspc.ai/llms.txt](https://wspc.ai/llms.txt)、[wspc.ai/llms-full.txt](https://wspc.ai/llms-full.txt)、[wspc.ai/llms-drive.txt](https://wspc.ai/llms-drive.txt)、[wspc.ai/AGENTS.md](https://wspc.ai/AGENTS.md)（只講 CLI 的 device flow，與本題無關）
- [api.wspc.ai/auth/openapi.json](https://api.wspc.ai/auth/openapi.json)、[api.wspc.ai/drive/openapi.json](https://api.wspc.ai/drive/openapi.json)
- [api.wspc.ai/.well-known/oauth-authorization-server](https://api.wspc.ai/.well-known/oauth-authorization-server)、[api.wspc.ai/.well-known/openid-configuration](https://api.wspc.ai/.well-known/openid-configuration)
- [mcp.wspc.ai/.well-known/oauth-protected-resource](https://mcp.wspc.ai/.well-known/oauth-protected-resource)
- 沒有內容的：`wspc.ai/.well-known/*` 三個都是 404；`mcp.wspc.ai/.well-known/oauth-authorization-server` 與 `openid-configuration` 回 401；`api.wspc.ai/.well-known/oauth-protected-resource` 回 522。
