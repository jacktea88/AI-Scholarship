import { supabaseServer } from '@/lib/supabase/server';
import { getLineProfile } from '@/lib/line';

/**
 * 重新向 LINE Messaging API 抓取好友公開資料（暱稱／頭像／狀態訊息）並寫回 line_users。
 *
 * LINE 的頭像 URL（profile.line-scdn.net/…）會在使用者更換頭像後失效，
 * 因此除了加好友當下，也需在來訊時定期同步、或於前端頭像載入失敗時觸發同步。
 *
 * @param {string} lineUserId
 * @returns {Promise<{displayName: string|null, pictureUrl: string|null, statusMessage: string|null}|null>}
 *          抓取失敗（例如使用者已封鎖官方帳號）回傳 null，DB 內容維持不變。
 */
export async function syncLineUserProfile(lineUserId) {
    if (!lineUserId) return null;
    const profile = await getLineProfile(lineUserId);
    if (!profile) return null;

    const fresh = {
        display_name: profile.displayName || null,
        picture_url: profile.pictureUrl || null,
        status_message: profile.statusMessage || null,
    };
    const { error } = await supabaseServer
        .from('line_users')
        .update({ ...fresh, updated_at: new Date().toISOString() })
        .eq('line_user_id', lineUserId);
    if (error) console.warn('[LINE] Profile sync write failed:', error.message);

    return { displayName: fresh.display_name, pictureUrl: fresh.picture_url, statusMessage: fresh.status_message };
}
