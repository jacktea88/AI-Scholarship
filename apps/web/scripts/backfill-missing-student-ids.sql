-- ============================================================
-- 補齊缺失學號(單次執行腳本)
--
-- 對象:profiles.student_id 為 NULL、且 auth.users 信箱為校內網域
--       (@mail.ncue.edu.tw / @gm.ncue.edu.tw)的帳號。
-- 規則:信箱前綴轉大寫,與 packages/core/src/studentId.ts 一致;
--       教職員/別名信箱同樣以前綴作為識別碼。
-- 安全:student_id 有 UNIQUE 限制——已被其他帳號占用者自動跳過、
--       不覆蓋任何既有值;整個 UPDATE 是單一交易,失敗即全部回滾。
--       另只處理 email_confirmed_at 非空的帳號,避免把學號補給未經確認、
--       可能是搶註用的 email/password 幽靈帳號。
--
-- 用法:先跑【第 1 段】預覽,確認清單無誤後跑【第 2 段】實際寫入,
--       最後用【第 3 段】檢查剩下未補齊的帳號(非校內信箱,需人工判斷)。
-- ============================================================


-- ── 第 1 段:預覽(唯讀,不寫入)──────────────────────────────
WITH candidates AS (
    SELECT p.id,
           p.created_at,
           u.email,
           upper((regexp_match(
               lower(trim(u.email)),
               '^([a-z0-9][a-z0-9._-]{0,63})@(?:mail|gm)\.ncue\.edu\.tw$'
           ))[1]) AS derived_id
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id AND u.deleted_at IS NULL
    -- 只補信箱已確認的帳號：未確認的 email/password 註冊可能是搶註學號的幽靈帳號
    WHERE p.student_id IS NULL
      AND u.email_confirmed_at IS NOT NULL
)
SELECT DISTINCT ON (derived_id)
       id, email, derived_id AS 將補寫的學號
FROM candidates
WHERE derived_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.profiles t WHERE t.student_id = candidates.derived_id)
ORDER BY derived_id, created_at ASC, id;


-- ── 第 2 段:實際寫入(確認預覽無誤後執行)────────────────────
WITH candidates AS (
    SELECT p.id,
           p.created_at,
           u.email,
           upper((regexp_match(
               lower(trim(u.email)),
               '^([a-z0-9][a-z0-9._-]{0,63})@(?:mail|gm)\.ncue\.edu\.tw$'
           ))[1]) AS derived_id
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id AND u.deleted_at IS NULL
    -- 只補信箱已確認的帳號：未確認的 email/password 註冊可能是搶註學號的幽靈帳號
    WHERE p.student_id IS NULL
      AND u.email_confirmed_at IS NOT NULL
),
eligible AS (
    -- 同一前綴若同時出現在 mail 與 gm 兩個帳號(撞號),只補最早建立者
    SELECT DISTINCT ON (derived_id) id, email, derived_id
    FROM candidates
    WHERE derived_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.profiles t WHERE t.student_id = candidates.derived_id)
    ORDER BY derived_id, created_at ASC, id
)
UPDATE public.profiles p
SET student_id = e.derived_id
FROM eligible e
WHERE p.id = e.id
RETURNING p.id, e.email, p.student_id AS 已補寫學號;


-- ── 第 3 段:檢查仍未補齊的帳號(非校內信箱,需人工判斷)──────
SELECT p.id,
       u.email,
       p.username,
       p.account_type,
       p.created_at::date AS 建立日期
FROM public.profiles p
LEFT JOIN auth.users u ON u.id = p.id
WHERE p.student_id IS NULL
ORDER BY p.created_at;
