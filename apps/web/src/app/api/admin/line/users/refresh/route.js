import { NextResponse } from 'next/server';
import { verifyUserAuth, handleApiError } from '@/lib/apiMiddleware';
import { syncLineUserProfile } from '@/lib/lineProfile';

/**
 * POST /api/admin/line/users/refresh
 * 重新同步單一 LINE 好友的暱稱／頭像（前端頭像載入失敗時觸發）。
 * Body: { lineUserId }
 */
export async function POST(request) {
    try {
        const authCheck = await verifyUserAuth(request, { requireAdmin: true, endpoint: '/api/admin/line/users/refresh' });
        if (!authCheck.success) return authCheck.error;

        const { lineUserId } = await request.json();
        if (!lineUserId || typeof lineUserId !== 'string') {
            return NextResponse.json({ error: '缺少 lineUserId' }, { status: 400 });
        }

        const profile = await syncLineUserProfile(lineUserId);
        return NextResponse.json({
            success: true,
            // null 代表 LINE 端取不到資料（多半是好友已封鎖官方帳號），前端改顯示預設頭像
            profile: profile ? { display_name: profile.displayName, picture_url: profile.pictureUrl } : null,
        });
    } catch (error) {
        return handleApiError(error, '/api/admin/line/users/refresh');
    }
}
