# 開發指南：讓管理者透過 LINE 新增公告（自動進入知識庫）

## 1. 目標與結論

管理者在 LINE 對官方帳號貼上一段公告資訊，AI 整理成欄位、預覽並取得確認後，**建立成正式公告**。公告建立後立即同步到 `ai_knowledge`，日後在 LINE 或網頁詢問 AI 就能查到。

做法是**新增一個管理者專用的 AI 工具 `create_announcement`**，不需要改 webhook，也不需要新的 migration。

## 2. 為什麼「建立成公告」而不是直接寫知識庫

| 原因 | 說明 |
| :--- | :--- |
| 資料表限制 | `ai_knowledge.announcement_id` 是 `NOT NULL UNIQUE` 且外鍵連到 `announcements`（見 [migration](../apps/web/supabase/migrations/20260722000000_ai_knowledge_and_line.sql)）。沒有公告就無法寫入知識庫。 |
| 避免被清掉 | `reconcileKnowledge` 會刪除「不在上架公告中」的知識條目（[knowledge.js](../apps/web/src/lib/ai/knowledge.js)）。獨立條目會被當成孤兒資料刪除。 |
| 改動最小 | 公告建立後只要呼叫既有的 `syncAnnouncementKnowledge`，就會產生 AI 易讀內容與向量，檢索、推薦、比較、行事曆等工具都會直接支援。 |
| 網頁同步可見 | 資料只有一份，前台、訂閱提醒、RSS 都能使用，不會出現兩套資料。 |

代價：**新增的內容會公開顯示在前台**（`is_active = true` 才會進知識庫）。若需要「只給 AI 看、不公開」的內部資訊，這個做法不適用，需另建獨立資料表。

## 3. 為什麼不需要改 webhook

[webhook route.js](../apps/web/src/app/api/line/webhook/route.js) 已經做到：

1. 用 `line_users.bound_user_id` 取得綁定的平台帳號。
2. 呼叫 `runScholarshipAgentText({ channel: 'line', userId: boundUserId })`。
3. 這兩個值會原樣傳到工具的 `context`（[agent.js](../apps/web/src/lib/ai/agent.js) 的 `executeTool(..., { userId, channel, apiKey })`）。

所以工具內只要用 `context.userId` 查 `profiles.role` 就能判斷是否為管理員。

## 4. 要修改的檔案

| 檔案 | 修改內容 | 原因 |
| :--- | :--- | :--- |
| [apps/web/src/lib/ai/tools.js](../apps/web/src/lib/ai/tools.js) | 新增 `toolDeclarations` 宣告、`executors.create_announcement`、`describeToolCall` 的 case，並更新檔頭分類註解 | 專案規定新增工具三處都要加 |
| [apps/web/src/lib/ai/agent.js](../apps/web/src/lib/ai/agent.js) | `TOOL_CALL_LIMITS` 加 `create_announcement: 1`；`buildSystemPrompt` 加使用規則 | 限制每輪只能建立一筆，並讓模型先預覽、取得同意才呼叫 |

不需要修改：webhook、資料庫 schema、`knowledge.js`。

## 5. 實作步驟

### 步驟 1：`tools.js` 匯入同步函式

```js
import { searchKnowledge, listKnowledge, cleanContent, syncAnnouncementKnowledge } from './knowledge';
```

### 步驟 2：新增工具宣告（放進 `toolDeclarations` 陣列）

```js
{
    name: 'create_announcement',
    description: '【僅限管理員】將管理員提供的獎助學金資訊建立為正式公告並上架，建立後會自動同步到知識庫。必須先向管理員預覽所有欄位並取得明確同意才可呼叫。',
    parameters: {
        type: Type.OBJECT,
        properties: {
            title: { type: Type.STRING, description: '公告標題' },
            summary: { type: Type.STRING, description: '公告內文（純文字，可換行）' },
            category: { type: Type.STRING, description: '分類代碼 A-G' },
            application_start_date: { type: Type.STRING, description: 'YYYY-MM-DD，未知則省略' },
            application_end_date: { type: Type.STRING, description: 'YYYY-MM-DD，未知則省略' },
            target_audience: { type: Type.STRING, description: '適用對象' },
            application_limitations: { type: Type.STRING, description: '兼領限制：Y 可兼領、N 不可兼領' },
            submission_method: { type: Type.STRING, description: '送件方式' },
            external_urls: { type: Type.ARRAY, items: { type: Type.STRING }, description: '相關連結' },
            confirmed: { type: Type.BOOLEAN, description: '管理員是否已看過預覽並明確同意發布。未取得同意時不可傳 true。' },
        },
        required: ['title', 'summary', 'category', 'confirmed'],
    },
},
```

### 步驟 3：新增執行器（放進 `executors`）

權限判斷必須在伺服器端做，不能只靠提示詞。角色判斷與 [apiMiddleware.js](../apps/web/src/lib/apiMiddleware.js) 的 `verifyUserAuth` 一致（`admin`、`super_admin`）。

```js
async create_announcement(args, context = {}) {
    if (!context.userId) return notSignedIn(context, '新增公告');

    const { data: profile } = await supabaseServer
        .from('profiles').select('role').eq('id', context.userId).maybeSingle();
    if (!['admin', 'super_admin'].includes(profile?.role)) {
        return { success: false, message: '此功能僅限管理員使用。' };
    }
    if (args.confirmed !== true) {
        return { success: false, message: '尚未取得管理員同意。請先預覽所有欄位，管理員明確同意後再呼叫。' };
    }

    const title = String(args.title || '').trim();
    const summary = String(args.summary || '').trim();
    if (!title || !summary) return { success: false, message: '標題與內文不可為空。' };
    if (!CATEGORY_NAMES[args.category]) return { success: false, message: '分類代碼必須是 A-G。' };

    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const start = isDate(args.application_start_date) ? args.application_start_date : null;
    const end = isDate(args.application_end_date) ? args.application_end_date : null;
    if (start && end && start > end) return { success: false, message: '開始日期不可晚於截止日期。' };

    const urls = (args.external_urls || []).filter((u) => /^https?:\/\//i.test(u)).map((url) => ({ url }));
    const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const toHtml = (s) => escapeHtml(s).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');

    const { data: ann, error } = await supabaseServer
        .from('announcements')
        .insert({
            title,
            summary: toHtml(summary),
            category: args.category,
            application_start_date: start,
            application_end_date: end,
            target_audience: args.target_audience ? toHtml(String(args.target_audience)) : null,
            application_limitations: ['Y', 'N'].includes(args.application_limitations) ? args.application_limitations : null,
            submission_method: args.submission_method || null,
            external_urls: JSON.stringify(urls),
            is_active: true,
        })
        .select('id, title')
        .single();
    if (error) return { success: false, message: `建立公告失敗：${error.message}` };

    const sync = await syncAnnouncementKnowledge(ann.id);
    return {
        success: true,
        id: ann.id,
        title: ann.title,
        url: getAnnouncementUrl(ann.id),
        knowledge_synced: sync.success,
        message: sync.success
            ? '公告已建立並同步到知識庫。'
            : '公告已建立，但知識庫同步失敗，請到後台按「同步知識庫」。',
    };
},
```

說明：

- `summary` 與 `target_audience` 在前台當 HTML 顯示，LINE 傳來的是純文字，所以要先跳脫再轉成段落，避免 HTML 注入。
- `external_urls` 沿用既有格式：`JSON.stringify([{ url }])`（與 [CreateAnnouncementModal.jsx](../apps/web/src/components/CreateAnnouncementModal.jsx) 相同）。
- 分類代碼 A-G 來自 `CATEGORY_NAMES`，`tools.js` 已匯入。
- `getAnnouncementUrl(id)` 已在 `tools.js` 從 `../siteConfig` 匯入，可直接使用。
- 不呼叫推播：網頁建立公告後會另外呼叫 `/api/admin/notifications/broadcast`，此工具預設不做，避免 LINE 誤操作直接推播給全體使用者。若要支援，需另外加確認步驟。

### 步驟 4：`describeToolCall` 加顯示文字

```js
case 'create_announcement':
    return `建立公告：${args.title || ''}`;
```

### 步驟 5：`agent.js` 加上限與規則

`TOOL_CALL_LIMITS` 加一行：

```js
create_announcement: 1,
```

`buildSystemPrompt` 的規則清單（參考第 10 條訂閱規則的寫法）加一條：

> 建立公告（create_announcement）僅限管理員。管理員貼上公告資訊時，先整理成標題、分類、日期、對象、送件方式、連結並逐項預覽，提醒「發布後會公開顯示在前台」，等管理員明確回覆「確認發布」才可呼叫；未經同意嚴禁呼叫。缺少必要資訊時先詢問，不可自行編造日期或連結。

## 6. 安全考量

- 權限在執行器內以資料庫角色判斷，不信任模型自行宣稱的身分。
- `confirmed` 由模型填寫，不是強保證。工具每輪最多一次，並有預覽與同意規則，風險可接受；若要更嚴格，改成「兩段式」：工具先把草稿存進暫存表，webhook 收到「確認發布」關鍵字時才由程式碼寫入公告。
- 提示詞注入：管理員貼入的文字可能包含惡意指令。已用寫入前跳脫、欄位驗證、每輪一次的限制降低風險。
- 一般使用者也會看到這個工具宣告。若要完全隱藏，可在 `runScholarshipAgent` 依角色過濾 `toolDeclarations`，這是選配。
- 網頁 AI 助理共用同一份工具，管理員在網頁也能使用。若只想限 LINE，在執行器加 `context.channel !== 'line'` 判斷即可。

## 7. 限制

- LINE 端只處理文字，無法上傳附件。附件仍需在後台編輯公告時補上。
- 只支援新增，不支援修改或下架。
- 全部欄位由 AI 從貼文中抽取，管理員必須確認預覽內容。

## 8. 測試步驟

1. 準備兩個已綁定 LINE 的帳號：一個 `profiles.role = 'admin'`，一個是一般使用者。
2. 一般使用者貼公告文字並要求建立，應回覆僅限管理員。
3. 管理員貼公告文字，確認 AI 先預覽且不會直接建立。
4. 回覆「確認發布」，確認回傳公告連結。
5. 到前台確認公告內容、日期與連結正確，換行沒有跑掉。
6. 到後台公告管理，以「檢視知識庫內容」確認 `ai_knowledge` 已有該筆。
7. 用另一個帳號在 LINE 詢問該公告的關鍵字，確認 AI 查得到。
8. 執行 `npm run build` 與 `npm run lint`。
