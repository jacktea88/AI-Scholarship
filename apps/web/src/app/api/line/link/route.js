import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { verifyUserAuth, handleApiError, logSuccessAction } from '@/lib/apiMiddleware';
import { syncLineUserProfile } from '@/lib/lineProfile';

/**
 * LINE 帳號綁定（使用者自助）
 * GET    /api/line/link  查詢自己的綁定狀態（含 OAuth 是否可用）；?refresh=1 會先向 LINE 重新同步暱稱／頭像
 * DELETE /api/line/link  解除綁定
 * 綁定後：LINE 對話與網頁版 AI 獎學金助理雙向共享上下文。
 */
export async function GET(request) {
    try {
        const authCheck = await verifyUserAuth(request, { requireAdmin: false, endpoint: '/api/line/link' });
        if (!authCheck.success) return authCheck.error;

        const { data } = await supabaseServer
            .from('line_users')
            .select('line_user_id, display_name, picture_url')
            .eq('bound_user_id', authCheck.user.id)
            .maybeSingle();

        let binding = data ? { displayName: data.display_name, pictureUrl: data.picture_url } : null;

        // 頭像載入失敗時前端會帶 refresh=1 重新同步（LINE 頭像 URL 在使用者更換頭像後會失效）
        const wantsRefresh = new URL(request.url).searchParams.get('refresh') === '1';
        if (binding && wantsRefresh) {
            const fresh = await syncLineUserProfile(data.line_user_id);
            if (fresh) binding = { displayName: fresh.displayName, pictureUrl: fresh.pictureUrl };
        }

        return NextResponse.json({
            success: true,
            binding,
            oauthAvailable: Boolean(process.env.LINE_LOGIN_CHANNEL_ID && process.env.LINE_LOGIN_CHANNEL_SECRET),
        });
    } catch (error) {
        return handleApiError(error, '/api/line/link');
    }
}

export async function DELETE(request) {
    try {
        const authCheck = await verifyUserAuth(request, { requireAdmin: false, endpoint: '/api/line/link' });
        if (!authCheck.success) return authCheck.error;

        const { error } = await supabaseServer
            .from('line_users')
            .update({ bound_user_id: null, updated_at: new Date().toISOString() })
            .eq('bound_user_id', authCheck.user.id);
        if (error) throw error;

        logSuccessAction('LINE_SELF_UNBIND', '/api/line/link', { userId: authCheck.user.id });
        return NextResponse.json({ success: true });
    } catch (error) {
        return handleApiError(error, '/api/line/link');
    }
}
