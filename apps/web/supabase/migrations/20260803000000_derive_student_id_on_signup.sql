-- 校內信箱（@mail / @gm.ncue.edu.tw）註冊時自動寫入學號（信箱前綴轉大寫）
--
-- 背景：原 handle_new_user 建檔時未寫 student_id，而校內信箱登入者因閘門
-- 以 email 即時推導視為已驗證、不會經過綁定流程，導致管理端學號顯示「-」。
-- 應用層 /api/auth/profile-sync 亦有相同的補寫邏輯（雙保險，並自我修復既有帳號）。
--
-- 只認「信箱所有權已被證明」的註冊：本 trigger 對任何 auth.users INSERT 都會觸發，
-- 含未確認的 email/password 註冊（GoTrue /auth/v1/signup 目前對外開放，anon key 也在
-- 前端 bundle 內）。若不設限，攻擊者可用 s1354032@gm.ncue.edu.tw 註冊幽靈帳號搶走學號，
-- 該生日後以 @mail 信箱登入將永遠無法綁定（兩網域推導出同一前綴，而 trigger、
-- profile-sync、verify-school-email 三條寫入路徑都會因 UNIQUE 占用而跳過）。
--
-- 條件用 OR 而非單看 email_confirmed_at：OAuth 帳號在 GoTrue 內是先 INSERT、再 UPDATE
-- 標記確認，AFTER INSERT 當下 email_confirmed_at 可能仍為 NULL，只看它會讓 Google 登入
-- （本平台唯一的登入方式）完全不推導。provider 則在 INSERT 前就寫入且由伺服器端決定，
-- 公開 /signup 一律是 'email'。真有漏網的帳號，登入時 profile-sync 會補寫。

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  derived_id text;
BEGIN
  -- 與 packages/core/src/studentId.ts 的 SCHOOL_EMAIL_PATTERN 一致
  IF new.email_confirmed_at IS NOT NULL
     OR COALESCE(new.raw_app_meta_data->>'provider', 'email') NOT IN ('email', 'phone') THEN
    derived_id := upper((regexp_match(
      lower(trim(new.email)),
      '^([a-z0-9][a-z0-9._-]{0,63})@(?:mail|gm)\.ncue\.edu\.tw$'
    ))[1]);
  END IF;

  -- student_id 有 UNIQUE 限制：已被其他帳號占用時放棄自動寫入，不能讓註冊失敗
  IF derived_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles WHERE student_id = derived_id AND id <> new.id
  ) THEN
    derived_id := NULL;
  END IF;

  INSERT INTO public.profiles (id, username, avatar_url, email, role, has_agreed_to_terms, student_id)
  VALUES (
    new.id,
    COALESCE(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'User'),
    COALESCE(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
    new.email,
    'user',
    false,
    derived_id
  )
  ON CONFLICT (id) DO UPDATE
  SET
    username = EXCLUDED.username,
    avatar_url = EXCLUDED.avatar_url,
    email = EXCLUDED.email,
    student_id = COALESCE(public.profiles.student_id, EXCLUDED.student_id);
  RETURN new;
EXCEPTION WHEN unique_violation THEN
  -- 併發下極罕見的學號撞號：退回不含學號的建檔，待登入後由 profile-sync 補寫
  INSERT INTO public.profiles (id, username, avatar_url, email, role, has_agreed_to_terms)
  VALUES (
    new.id,
    COALESCE(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'User'),
    COALESCE(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
    new.email,
    'user',
    false
  )
  ON CONFLICT (id) DO UPDATE
  SET
    username = EXCLUDED.username,
    avatar_url = EXCLUDED.avatar_url,
    email = EXCLUDED.email;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
