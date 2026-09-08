/**
 * 平台使用的 Gemini 模型（單一來源）
 *
 * 升級模型時只改這裡。所有伺服器端呼叫（助理 agent、金鑰驗證、PDF／附件抽取、
 * 記憶庫合併、知識缺口評估、公告生成）與 Footer 的模型標示皆引用此檔。
 * 本檔不得引入任何伺服器端相依（Footer 是 client component 會一起打包）。
 *
 * 例外：scripts/backfill-attachment-knowledge.js 為獨立 CommonJS 腳本，需手動同步。
 */
export const GEMINI_MODEL = 'gemini-3.8-flash';

/** 對外顯示用名稱（Footer） */
export const GEMINI_MODEL_LABEL = 'Gemini 3.8 Flash';
