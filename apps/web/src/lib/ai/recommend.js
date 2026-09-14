/**
 * 個人化推薦的結構化初篩（純函式，無伺服器相依，可獨立測試）
 *
 * 把使用者條件（身分別、戶籍縣市、系所、學制…）展開為同義詞組，
 * 逐一比對公告的標題／適用對象／摘要，計算命中條件。
 * 這只是「初篩」：最終是否符合資格仍須由模型對照公告原文說明，並提醒使用者查證。
 */

const norm = (s) => String(s || '').replace(/臺/g, '台').replace(/\s+/g, '').toLowerCase();

/** 去除 HTML 與多餘空白（recommend 模組保持純函式，不引用 knowledge.js） */
export function stripHtml(html) {
    return String(html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
        .replace(/<[^>]*>?/gm, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n')
        .trim();
}

export const COUNTIES = [
    '台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市',
    '基隆市', '新竹市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣',
    '嘉義市', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣',
    '澎湖縣', '金門縣', '連江縣',
];

/**
 * 身分別／學制同義詞組：
 * - trigger：使用者的條件或背景文字出現什麼寫法時，視為這個身分（比對已正規化的文字：臺→台、小寫、無空白）
 * - variants：公告中出現哪些寫法算命中
 * 注意方向性：使用者是「中低收入戶」不代表符合只收「低收入戶」的公告，
 * 因此 中低收入戶 的 variants 不含「低收入戶」，而 低收入戶 的 trigger 排除「中低收」。
 */
export const SYNONYM_GROUPS = {
    低收入戶: { trigger: /(?<!中)低收(入戶)?/, variants: ['低收入戶', '低收', '清寒', '經濟弱勢', '弱勢', '家境清寒', '家境困難', '經濟困難', '中低收入戶', '中低收'] },
    中低收入戶: { trigger: /中低收(入戶)?/, variants: ['中低收入戶', '中低收', '清寒', '經濟弱勢', '弱勢', '家境困難', '經濟困難'] },
    清寒: { trigger: /清寒|經濟弱勢|家境困難|經濟困難|家境不佳|弱勢/, variants: ['清寒', '經濟弱勢', '弱勢', '家境清寒', '家境困難', '經濟困難', '低收入戶', '低收', '中低收入戶', '中低收'] },
    特殊境遇: { trigger: /特殊境遇|特境|單親|隔代教養|家庭變故|突遭變故|失親/, variants: ['特殊境遇', '特境', '單親', '隔代教養', '家庭變故', '突遭變故', '失親', '家遭變故'] },
    原住民: { trigger: /原住民|原民/, variants: ['原住民', '原民', '原住民族'] },
    新住民: { trigger: /新住民|新移民|外籍配偶/, variants: ['新住民', '新移民', '外籍配偶', '移民署', '新住民子女'] },
    僑生: { trigger: /僑生|港澳/, variants: ['僑生', '港澳生', '海外僑生', '港澳'] },
    身心障礙: { trigger: /身心障礙|身障|殘障/, variants: ['身心障礙', '身障', '殘障', '身心障礙者', '身障生'] },
    客家: { trigger: /客家|客籍/, variants: ['客家', '客籍', '客家子弟'] },
    農漁民: { trigger: /農漁民|農民|漁民|農會|漁會/, variants: ['農漁民', '農民', '漁民', '農會', '漁會', '農漁民子女'] },
    勞工: { trigger: /勞工|工會/, variants: ['勞工', '工會', '勞工子女'] },
    軍公教: { trigger: /軍人|軍公教|榮民|遺族|警察|消防|軍眷/, variants: ['軍人', '軍公教', '榮民', '遺族', '警察', '消防', '公務人員子女', '軍眷'] },
    研究生: { trigger: /研究生|碩士|博士|碩博|研究所|碩[一二]|博[一二三四]/, variants: ['研究生', '碩士', '博士', '碩博', '碩士班', '博士班', '研究所'] },
    大學部: { trigger: /大學部|大學生|學士班|大專生/, variants: ['大學部', '大學生', '學士班', '大專生', '大專院校學生', '日間部'] },
    新生: { trigger: /新生|大一|一年級/, variants: ['新生', '大一新生', '入學新生', '一年級新生', '含新生'] },
    成績優異: { trigger: /成績優|優秀學生|學業優異|品學兼優/, variants: ['成績優秀', '優秀學生', '學業優異', '品學兼優', '成績優異'] },
};

// 判斷公告是否「有指定身分」時使用的關鍵字（排除學制類，學制不算身分限制）
const IDENTITY_KEYS = Object.keys(SYNONYM_GROUPS).filter(k => !['研究生', '大學部', '新生', '成績優異'].includes(k));
const IDENTITY_TOKENS = [...new Set(IDENTITY_KEYS.flatMap(k => [k, ...SYNONYM_GROUPS[k].variants]).map(norm))];

const BROAD_RE = /全校|不限|各系|所有學生|全體|本校學生|各學制|皆可申請|均可申請|不分系/;

/** 常見系所全名↔簡稱（公告常只寫簡稱，例如「限資工、資管相關科系」） */
export const DEPT_ALIASES = [
    ['資訊工程', '資工'], ['資訊管理', '資管'], ['企業管理', '企管'], ['電機工程', '電機'],
    ['機械工程', '機械'], ['電子工程', '電子'], ['機電工程', '機電'], ['財務金融', '財金'],
    ['國際企業', '國企'], ['特殊教育', '特教'], ['輔導與諮商', '輔諮'], ['工業教育與技術', '工教'],
    ['光電科技', '光電'], ['車輛科技', '車輛'], ['統計資訊', '統資'], ['人力資源', '人資'],
    ['公共事務與公民教育', '公民'], ['行銷與流通', '行銷'], ['英語', '英文'], ['運動學', '運動'],
    ['化學工程', '化工'], ['土木工程', '土木'], ['環境工程', '環工'], ['生物科技', '生科'],
];

// 背景描述常見的前導詞（「就讀資工系」→「資工系」）
const DEPT_LEAD_RE = /^(目前|現在|我是|我|是|就讀|於|在|本校|讀|念|唸|畢業於)+/;

/**
 * 把單一條件字串展開為比對用同義詞組。
 * @returns {{label:string, kind:'county'|'department'|'identity'|'text', variants:string[]}|null}
 */
export function expandCriterion(raw) {
    const text = norm(raw);
    if (text.length < 2) return null;
    const variants = new Set([text]);
    let kind = 'text';
    let label = String(raw).trim();

    for (const [key, group] of Object.entries(SYNONYM_GROUPS)) {
        if (group.trigger.test(text)) {
            [norm(key), ...group.variants.map(norm)].forEach(v => variants.add(v));
            if (kind === 'text') { kind = 'identity'; label = key; }
        }
    }

    // 縣市：先比對全名（嘉義市／嘉義縣要分清楚），只寫「嘉義」則兩者都算
    const fullCounty = COUNTIES.find(county => text.includes(norm(county)));
    const prefixCounty = fullCounty ? null : COUNTIES.find(county => text.includes(norm(county).slice(0, 2)));
    if (fullCounty) {
        variants.add(norm(fullCounty));
        kind = 'county';
        label = fullCounty;
    } else if (prefixCounty) {
        const prefix = norm(prefixCounty).slice(0, 2);
        variants.add(prefix); // 「花蓮」也能對上「花蓮縣」
        kind = 'county';
        label = prefix;
    }

    // 系所：去掉「學系／系／研究所／所」尾綴保留短名（「資工系」→「資工」），並補上全名↔簡稱
    const dept = text.replace(DEPT_LEAD_RE, '').match(/^(.{2,12}?)(學系|系|研究所|所)$/);
    if (dept && kind === 'text') {
        const stem = dept[1];
        variants.add(stem);
        for (const [full, short] of DEPT_ALIASES) {
            if (stem.includes(norm(full)) || stem === norm(short)) { variants.add(norm(full)); variants.add(norm(short)); }
        }
        kind = 'department';
        label = `${stem}${dept[2]}`;
    }

    return { label, kind, variants: [...variants].filter(v => v.length >= 2) };
}

/** 從記憶庫背景文字擷取可用條件（身分別、縣市、系所、新生） */
export function extractCriteriaFromBackground(text) {
    const t = norm(text);
    if (!t) return [];
    const found = [];

    for (const [key, group] of Object.entries(SYNONYM_GROUPS)) {
        if (group.trigger.test(t)) found.push(key);
    }
    // 已有明確的低收／中低收身分時，「清寒」泛稱不必再重複列出
    if (found.includes('清寒') && (found.includes('低收入戶') || found.includes('中低收入戶'))) {
        found.splice(found.indexOf('清寒'), 1);
    }

    for (const county of COUNTIES) {
        if (t.includes(norm(county))) found.push(county);
    }

    const dept = t.match(/([一-龥]{2,12}?)(學系|系)(?![統列])/);
    if (dept && !/體系|關係|科系|學系別/.test(dept[0])) {
        const stem = dept[1].replace(DEPT_LEAD_RE, '');
        if (stem.length >= 2) found.push(`${stem}系`);
    }

    if (/大一|一年級|新生/.test(t) && !found.includes('新生')) found.push('新生');

    return [...new Set(found)];
}

/** 合併並去重條件（同一標準名稱只保留一個） */
export function buildCriteria(rawList = []) {
    const out = [];
    const seen = new Set();
    for (const raw of rawList) {
        const c = expandCriterion(raw);
        if (!c) continue;
        const key = `${c.kind}:${norm(c.label)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
    }
    return out;
}

/**
 * 對公告清單做初篩。
 * @param {Array} announcements 需含 id/title/category/application_end_date/target_audience/summary
 * @param {Array} criteria buildCriteria() 的結果
 * @returns {{matched:Array, general:Array, excludedByCounty:number}}
 */
export function scoreAnnouncements(announcements = [], criteria = [], { limit = 8, generalLimit = 5 } = {}) {
    const userCounties = criteria.filter(c => c.kind === 'county');
    const matched = [];
    const general = [];
    let excludedByCounty = 0;

    for (const ann of announcements) {
        const title = stripHtml(ann.title);
        const target = stripHtml(ann.target_audience);
        const summary = stripHtml(ann.summary).slice(0, 3000);
        const head = norm(`${title}\n${target}`);
        const hay = norm(`${title}\n${target}\n${summary}`);

        // 縣市限定（標題／適用對象出現縣市名）且與使用者戶籍不符 → 排除
        const annCounties = COUNTIES.map(norm).filter(c => head.includes(c));
        if (annCounties.length > 0 && userCounties.length > 0) {
            // 使用者只寫「嘉義」時，嘉義市／嘉義縣皆視為相符
            const ok = annCounties.some(c => userCounties.some(u => u.variants.some(v => c.startsWith(v))));
            if (!ok) { excludedByCounty++; continue; }
        }

        const hits = criteria.filter(c => c.variants.some(v => hay.includes(v)));
        const hasIdentityLimit = IDENTITY_TOKENS.some(tok => head.includes(tok)) || annCounties.length > 0;
        const isBroad = !hasIdentityLimit && (BROAD_RE.test(`${title}${target}`) || !target);

        const entry = {
            announcement_id: ann.id,
            title,
            category: ann.category || null,
            application_end_date: ann.application_end_date || null,
            target_audience: target.slice(0, 300),
            matched_criteria: hits.map(h => h.label),
        };
        if (hits.length > 0) matched.push({ ...entry, score: hits.length + (isBroad ? 0 : 0.5) });
        else if (isBroad) general.push(entry);
    }

    const byDeadline = (a, b) => (a.application_end_date || '9999-12-31').localeCompare(b.application_end_date || '9999-12-31');
    matched.sort((a, b) => b.score - a.score || byDeadline(a, b));
    general.sort(byDeadline);

    return {
        matched: matched.slice(0, limit).map(({ score, ...rest }) => rest),
        general: general.slice(0, generalLimit),
        excludedByCounty,
    };
}
