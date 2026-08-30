-- ============================================================
-- 學號搶註稽核與復原(單次執行腳本)
--
-- 背景:GoTrue 的 /auth/v1/signup 目前對外開放 email/password 註冊
--       (anon key 就在前端 bundle 內),但平台本身只有 Google 登入、
--       沒有任何密碼介面。任何人都能用他人的校內信箱註冊一個永不確認
--       的帳號。單靠信箱字串綁定學號的邏輯會把學號發給這種帳號,
--       且學號有 UNIQUE 限制 → 真正的學生從此無法綁定。
--
-- 程式面已修:trigger 與 profile-sync 都改為只在「信箱所有權已證明」
--       (email_confirmed_at 非空,或 provider 非 email/phone)時才寫學號。
--       本腳本用於清查既有資料,並在必要時釋放被錯誤占用的學號。
-- ============================================================


-- ── 第 1 段:可疑帳號清查 ────────────────────────────────────
-- 用校內信箱註冊、但從未證明信箱所有權的帳號。
-- 正常情況應為 0 筆:平台只走 Google 登入,這類帳號一律不是從本站產生的。
SELECT u.id,
       u.email,
       u.created_at,
       u.raw_app_meta_data->>'provider'  AS provider,
       u.email_confirmed_at,
       u.last_sign_in_at,
       p.student_id                       AS 目前占用的學號
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE u.deleted_at IS NULL
  AND lower(u.email) ~ '@(?:mail|gm)\.ncue\.edu\.tw$'
  AND u.email_confirmed_at IS NULL
  AND COALESCE(u.raw_app_meta_data->>'provider', 'email') IN ('email', 'phone')
ORDER BY u.created_at DESC;


-- ── 第 2 段:被錯誤占用的學號 ────────────────────────────────
-- 有學號、卻不符合「信箱所有權已證明」標準的帳號。
-- 這些列會讓真正的持有者無法綁定,需人工確認後以第 3 段釋放。
SELECT p.id,
       u.email,
       p.username,
       p.student_id,
       u.raw_app_meta_data->>'provider' AS provider,
       u.email_confirmed_at,
       u.last_sign_in_at,
       p.created_at
FROM public.profiles p
JOIN auth.users u ON u.id = p.id
WHERE p.student_id IS NOT NULL
  AND u.deleted_at IS NULL
  AND u.email_confirmed_at IS NULL
  AND COALESCE(u.raw_app_meta_data->>'provider', 'email') IN ('email', 'phone')
ORDER BY p.created_at;


-- ── 第 3 段:釋放被占用的學號(人工確認後,逐筆執行)──────────
-- 只清空 student_id,不刪除帳號(保留稽核軌跡)。
-- 執行後該學號即可由真正的持有者透過「個資管理」的校信箱驗證流程綁定。
--
-- UPDATE public.profiles
-- SET student_id = NULL
-- WHERE id = '<貼上第 2 段查到的 profile id>'
--   AND student_id = '<貼上要釋放的學號,雙重確認避免誤刪>'
-- RETURNING id, email, student_id;


-- ── 第 4 段:確認同一學號沒有重複綁定 ────────────────────────
-- student_id 有 UNIQUE 限制,正常應為 0 筆;若有結果代表限制未建立,需另行處理。
SELECT student_id, count(*) AS 帳號數, array_agg(id) AS profile_ids
FROM public.profiles
WHERE student_id IS NOT NULL
GROUP BY student_id
HAVING count(*) > 1;
