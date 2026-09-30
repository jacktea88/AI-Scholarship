# AI 品質回饋循環

## 目的

找出「AI 答不好或找不到資料的問題」，讓管理員審核後轉成正式 FAQ，形成「使用者提問 → 缺口 → FAQ → AI 下次能答」的改善循環。

## 流程

```mermaid
flowchart TD
    subgraph 訊號來源
      A["使用者對回答按倒讚：POST /api/chat/feedback"] --> DB1["ai_message_feedback"]
      B["Agent 找不到資料時呼叫 report_knowledge_gap"] --> DB2["ai_knowledge_gaps"]
      C["chat_history、line_messages 的近期提問"]
    end
    D["後台 KnowledgeGapTab：立即評估"] --> E["POST /api/admin/knowledge-gaps {action:'evaluate'}"]
    E --> F["runQualityEvaluation({days:30})：彙整提問、回饋、現有 FAQ、既有缺口"]
    DB1 --> F
    C --> F
    F --> G["LLM 歸納缺口，依 topic_key 合併，新增或更新 ai_knowledge_gaps"]
    G --> H["管理員檢視缺口"]
    H --> I["draft：generateFaqDraft 產生 FAQ 草稿，status=drafted"]
    H --> J["dismiss / restore：忽略或還原"]
    I --> K["審核並修改後 publish"]
    K --> L["validateFaqBlocks 驗證，寫入 faqs（display_order = 目前最大值 + 10）"]
    L --> M["缺口 status=published，記 created_faq_id"]
    M --> N["AI 工具 search_faq 之後可查到"]
```

## 涉及檔案

| 檔案 | 用途 |
|---|---|
| `apps/web/src/lib/ai/qualityEval.js` | `runQualityEvaluation`、`generateFaqDraft`、`normalizeTopicKey` |
| `apps/web/src/app/api/admin/knowledge-gaps/route.js` | `GET` 列表；`POST` 動作 `evaluate`／`draft`／`dismiss`／`restore`／`publish`；`DELETE` |
| `apps/web/src/components/admin/KnowledgeGapTab.jsx` | 後台介面 |
| `apps/web/src/app/api/chat/feedback/route.js` | 使用者回饋 |
| `apps/web/src/lib/ai/tools.js` | `report_knowledge_gap` 工具 |
| `apps/web/src/lib/faqBlocks.js` | 發佈時驗證 FAQ 內容 |
| `apps/web/supabase/migrations/20260723010000_ai_quality_loop.sql` | 相關資料表 |

## 資料表

| 表 | 用途 |
|---|---|
| `ai_message_feedback` | 使用者對單則回答的評價 |
| `ai_knowledge_gaps` | `topic_key`、`frequency`、`sample_questions`、`status`（`pending` / `drafted` / `dismissed` / `published`）、`created_faq_id` |
| `faqs` | 發佈目標（見 [常見問答FAQ.md](常見問答FAQ.md)） |
| `system_settings` | `AI_QUALITY_LAST_EVAL_AT`：增量評估游標 |

## 評估參數（`qualityEval.js`）

| 常數 | 值 | 意義 |
|---|---|---|
| `MAX_QUESTIONS` | 400 | 送進 LLM 的提問上限（成本控制） |
| `MAX_GAPS` | 12 | 單次歸納的缺口數上限 |
| `SAMPLE_CAP` | 6 | 每個缺口保留的樣本提問數 |

## 容易忽略的行為

- 評估會用 Gemini，需要平台金鑰並產生費用；只在管理員按下「立即評估」時執行。
- 資料來源同時包含網頁（`chat_history`）與 LINE（`line_messages`）。
- 已存在於 FAQ 的問題會被納入比對，避免重複建議。
- 缺口以 `normalizeTopicKey` 正規化後合併，同主題會累加 `frequency`。
- `publish` 需要管理員送出審核後的問題與答案，AI 草稿不會自動上線。
