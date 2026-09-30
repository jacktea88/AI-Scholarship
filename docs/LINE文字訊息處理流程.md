# LINE 文字訊息處理流程

依 [webhook route.js](../apps/web/src/app/api/line/webhook/route.js) 與 [agent.js](../apps/web/src/lib/ai/agent.js) 整理，說明使用者在 LINE 對官方帳號傳送文字後，系統如何處理。

## 流程圖

```mermaid
flowchart TD
    A[使用者在 LINE 傳文字] --> B[POST /api/line/webhook]
    B --> C{驗證 x-line-signature<br/>HMAC-SHA256}
    C -- 失敗 --> C1[回 403]
    C -- 通過 --> D[立即回 200 給 LINE<br/>事件交給 after 背景處理]
    D --> E[upsertLineUser<br/>同步暱稱與頭像，6 小時節流]
    E --> F[寫入 line_messages<br/>role=user, type=text]
    F --> G{文字完全等於<br/>帳號綁定 / 綁定帳號 / 綁定}
    G -- 是 --> G1{已綁定?}
    G1 -- 是 --> G2[回覆已綁定的帳號]
    G1 -- 否 --> G3[產生 6 位數驗證碼<br/>寫入 line_bind_codes，10 分鐘有效<br/>回覆驗證碼與 /profile 連結]
    G -- 否 --> H{line_users.bound_user_id<br/>是否有值}
    H -- 否 --> H1[回覆綁定引導，不呼叫 AI]
    H -- 是 --> I{每分鐘 AI 請求<br/>是否超過 5 次}
    I -- 超過 --> I1[回覆訊息太頻繁]
    I -- 未超過 --> J{LINE_AI_AUTO_REPLY_ENABLED<br/>是否為 false}
    J -- 是 --> J1[靜默結束，僅保留聊天紀錄<br/>供管理員手動回覆]
    J -- 否 --> K{是否在回應時段內<br/>LINE_AI_REPLY_SCHEDULE}
    K -- 否 --> K1[有設離峰訊息就回覆，否則靜默]
    K -- 是 --> L[handleAiReply]
    L --> M[組合上下文]
    M --> N[解析 Gemini 金鑰]
    N -- 失敗 --> N1[回覆金鑰提示]
    N -- 成功 --> O[Agent 工具迴圈]
    O --> P[清理輸出並附免責聲明]
    P --> Q{replyMessage}
    Q -- 失敗或逾時 --> Q1[改用 pushMessage]
    Q -- 成功 --> R[寫入 line_messages<br/>role=ai]
    Q1 --> R
```

## 各階段說明

| 階段 | 處理內容 |
| :--- | :--- |
| 驗證 | 用 Channel Secret 驗證簽章，失敗回 403。 |
| 非同步 | 先回 200，避免 LINE 重送，再用 `after` 逐一處理事件。 |
| 記錄 | 先更新 `line_users`，再把使用者訊息存進 `line_messages`，此時後台就看得到。 |
| 綁定指令 | 只有整句完全符合關鍵字才觸發，否則一律當一般提問。 |
| 閘門 | 依序為綁定檢查、每分鐘 5 次限流（程序內記憶）、AI 開關、回應時段。 |
| 上下文 | 近 10 則 LINE 文字。若已綁定，再加上網頁版最近 10 則 `chat_history` 與 `profiles.ai_background`。 |
| 金鑰 | 彰師大學生用平台金鑰；校外使用者用自備金鑰，且必須存於雲端。 |
| Agent | 系統提示詞 `channel='line'`，最多 6 輪工具呼叫，可用公告搜尋、FAQ、訂閱、比較等工具。 |
| 輸出 | 移除卡片標記、HTML 與 Markdown，結尾附 AI 免責聲明。 |
| 回覆 | 先用 reply token，失敗才用 push，最後把 AI 回覆存進 `line_messages`。 |

## 涉及的資料表與設定

| 名稱 | 用途 |
| :--- | :--- |
| `line_users` | LINE 好友資料與 `bound_user_id`（綁定的平台帳號） |
| `line_messages` | 使用者、AI、管理員的所有 LINE 訊息 |
| `line_bind_codes` | 綁定驗證碼，10 分鐘有效 |
| `chat_history` | 網頁版對話，綁定後併入 LINE 的上下文 |
| `profiles.ai_background` | 使用者自填的背景資料 |
| `system_settings` | `LINE_AI_AUTO_REPLY_ENABLED`、`LINE_AI_REPLY_SCHEDULE`、Gemini 與 LINE 金鑰 |

## 容易忽略的行為

- 未綁定、限流、AI 關閉、時段外，這幾種情況都不會呼叫 Gemini，不產生費用。
- AI 關閉或時段外沒有離峰訊息時，使用者不會收到任何回覆。
- 上下文只取文字，圖片與貼圖不會帶入。
- 「確認訂閱」、「同意」這類同意語句，是靠模型讀對話歷史判斷，沒有獨立的狀態機。
- 限流計數存在程序記憶體中，重啟或多實例部署時不會共用。
