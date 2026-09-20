/**
 * 节点分类管理模块（UIIIAIII Toolkit）
 *
 * 在 ComfyUI 新版 UI 的节点库树（侧边栏）上直接管理混乱的分类：
 * - 右键分类文件夹：新建子分类 / 新建主分类 / 重命名 / 删除 / 隐藏 / 恢复默认名称 / 恢复所有分类
 * - Alt + 右键拖拽：把节点或整个分类拖到目标分类下（松开即生效）
 * - 新建的主/子分类均为「空分类」，直接显示在分类树末尾；把节点或分类拖入后自动转为普通分类
 *
 * 热更新架构（无需刷新页面）：
 * 通过 pinia 的 nodeDef store 直接读写节点定义：
 * - 修改 nodeDef.category → nodeTree 自动重算 → 节点树立即更新
 * - 隐藏分类用官方 registerNodeDefFilter 注册过滤器实现
 * - 规则变更后调用 reapply() 重算全部节点并写回 store
 *
 * 基准值说明：
 * store 中的 category 已是「显示路径」（翻译后的中文，与树上显示一致）。
 * 首次 reapply 时记录各节点的基准 category（此时未被任何规则污染），
 * 之后每次 reapply 都从基准 + 规则重算，保证多轮编辑不累积误差。
 *
 * 规则存储：插件目录 category_overrides.json（经后端端点读写）
 *   {
 *     "category_rename": { "显示路径": "新路径" },
 *     "hidden_categories": ["显示路径", ...],
 *     "node_move": { "comfyClass": "目标路径" },
 *     "empty_categories": ["显示路径", ...],  // 自建空分类
 *     "hidden_nodes": ["comfyClass", ...],    // 单独隐藏的节点
 *     "order_rules": [ { type: "cat"|"node", key, before } ],  // 排序：key 排在 before 前
 *     "drag_trigger": { "mouse": "left"|"right", "modifier": "ctrl+alt+shift" 或 "" }
 *   }
 */

// 翻译开关（未启用翻译时无需等字典，规则可立即应用）
import { isTranslationEnabled } from "./utils.js";

const CM_NAMESPACE = "UIIIAIII Toolkit-CategoryManager";

const CM = {
    rules: { category_rename: {}, hidden_categories: [], node_move: {}, empty_categories: [], hidden_nodes: [], order_rules: [], drag_trigger: { mouse: "right", modifier: "alt" } },
    baseCategory: new Map(),   // comfyClass -> 英文基准 category（与界面语言无关）
    finalBase: new Map(),      // comfyClass -> 应用规则后的英文基准 category（排序/隐藏匹配用）
    baseByDisp: new Map(),     // 显示路径 -> 英文基准路径（把树上的中文路径反查回基准）
    rawCategory: new Map(),    // comfyClass -> 后端原始 category（纯英文，基准的权威来源）
    rawFetched: false,         // 是否已从后端拉取原始分类
    catIndex: new Map(),       // 显示路径 -> 显示路径（树右键反查用）
    nodeIndex: new Map(),      // 叶子显示文本 -> [{ name, dispPath }]
    classIndex: new Map(),     // comfyClass -> [{ name, dispPath }]
    emptySet: new Set(),       // 自建空分类（尚未放入任何内容，显示在树面板顶部区块）
    ready: false,              // 首次 reapply 完成
    // 启动耗时打点（毫秒，相对页面加载；诊断加载慢时可在控制台查看 window.__CM__.perf）
    perf: { startedAt: performance.now(), storeReadyAt: 0, interactionAt: 0, dictReadyAt: 0, appliedAt: 0, calibratedAt: 0, lastChanged: 0 },
};

const FILTER_ID = "uiiiaiii.hiddenCategories";

// ============================================================
// 界面文案翻译（英文为源文案，命中字典后显示当前语言）
// ============================================================

/**
 * 按翻译字典翻译界面文案（模板法）。
 * 字典键为含 {name} 占位符的完整英文模板字符串，命中后用 params 替换占位符；
 * 未命中 / 翻译未启用时回退英文模板。
 * 注意：模板键必须与 locales/zh-CN/Menus/UIIIAIII_Toolkit.json 中的键逐字符一致。
 */
function tr(template, params) {
    const menuT = window.__UiTranslated?.Menu || {};
    let text = menuT[template] || template;
    if (params) {
        for (const key of Object.keys(params)) {
            text = text.split(`{${key}}`).join(String(params[key]));
        }
    }
    return text;
}

// ============================================================
// store 接入
// ============================================================

/** 获取前端的 nodeDef store（pinia），不可用时返回 null */
function getNodeDefStore() {
    try {
        const app = document.querySelector("#vue-app")?.__vue_app__;
        const pinia = app?.config?.globalProperties?.$pinia;
        return pinia?._s?.get("nodeDef") || null;
    } catch (e) {
        return null;
    }
}

// ============================================================
// 规则应用
// ============================================================

/**
 * 计算节点的最终 category（基准显示路径 + 规则链式叠加）
 *
 * 规则会「链式」生效，保证整体移动符合直觉：
 *   例：X -> A/X（X 移进 A）且 A -> B/A（A 移进 B）
 *       => X 的最终路径为 B/A/X（整个分类一起进入 B）
 *   例：节点 N 移到 A，之后 A 移进 B => N 的最终路径为 B/A
 *
 * 链式顺序：node_move 作为起点 → 反复套用 category_rename（精确 > 最长前缀）直到稳定
 * 最多迭代 6 次防止规则环（A->B 且 B->A）。
 */
function applyRulesTo(name, base) {
    const move = CM.rules.node_move || {};
    const rename = CM.rules.category_rename || {};
    const renameKeys = Object.keys(rename).filter(Boolean);

    let cur = (move[name] !== undefined && move[name]) ? String(move[name]) : base;
    for (let i = 0; i < 6; i++) {
        let next = cur;
        if (rename[cur]) {
            next = String(rename[cur]); // 精确命中（分类整体改名/移动）
        } else {
            // 最长前缀命中：父级分类被移动时，子路径整体跟随
            let bestKey = "";
            for (const k of renameKeys) {
                if (cur.startsWith(k + "/") && k.length > bestKey.length) bestKey = k;
            }
            if (bestKey) next = String(rename[bestKey]) + cur.slice(bestKey.length);
        }
        if (next === cur) break; // 稳定
        cur = next;
    }
    return cur;
}

/** 分类（英文基准路径）是否被隐藏：精确命中或位于被隐藏文件夹内 */
function isHiddenBasePath(basePath) {
    const hidden = CM.rules.hidden_categories || [];
    if (!basePath) return false;
    if (hidden.includes(basePath)) return true;
    return hidden.some((h) => h && basePath.startsWith(h + "/"));
}

/** 单个节点（comfyClass）是否被隐藏 */
function isHiddenNode(name) {
    return (CM.rules.hidden_nodes || []).includes(name);
}

// ============================================================
// 拖拽排序（重排 nodeDefsByName 字典 key 顺序 → 树按 original 策略实时重排）
// ============================================================

/** 添加/更新排序规则：key（组路径或类名）排在 before 之前（save=false 时由调用方统一保存） */
function addOrderRule(type, key, before, save = true) {
    if (!key || !before) return;
    // 分类排序规则以英文基准路径记录（与界面语言无关）；节点排序用类名，无需转换
    const k = type === "cat" ? (baseOfDispPath(key) || key) : key;
    const b = type === "cat" ? (baseOfDispPath(before) || before) : before;
    if (!k || !b || k === b) return;
    if (!CM.rules.order_rules) CM.rules.order_rules = [];
    const i = CM.rules.order_rules.findIndex((r) => r.type === type && r.key === k);
    if (i >= 0) CM.rules.order_rules.splice(i, 1);
    CM.rules.order_rules.push({ type, key: k, before: b });
    if (save) saveRules();
}

/** 清除与指定分类相关的排序规则（src 为该分类/其子分类/其内节点，或锚点在其中） */
function removeOrderRulesForCategory(key) {
    if (!CM.rules.order_rules) return 0;
    const store = getNodeDefStore();
    const dict = store?.nodeDefsByName || null;
    const inCat = (k, isCat) => {
        if (isCat) return k === key || k.startsWith(key + "/");
        const fb = CM.finalBase.get(k);
        const c = fb !== undefined
            ? fb
            : (dict ? String(CM.rawCategory.get(k) ?? dict[k]?._original_category ?? dict[k]?.category ?? "") : null);
        return c ? (c === key || c.startsWith(key + "/")) : false;
    };
    const before = CM.rules.order_rules;
    CM.rules.order_rules = before.filter((r) => {
        const srcHit = inCat(r.key, r.type === "cat");
        const dstHit = r.type === "cat" && (r.before === key || r.before.startsWith(key + "/"));
        return !(srcHit || dstHit);
    });
    return before.length - CM.rules.order_rules.length;
}

/** 分类移动/重命名后，同步排序规则中的路径引用（排序规则以当前显示路径为键） */
function syncOrderRulesForRename(oldPath, newPath) {
    if (!CM.rules.order_rules || oldPath === newPath) return;
    for (const r of CM.rules.order_rules) {
        if (r.type !== "cat") continue;
        if (r.key === oldPath) r.key = newPath;
        else if (r.key.startsWith(oldPath + "/")) r.key = newPath + r.key.slice(oldPath.length);
        if (r.before === oldPath) r.before = newPath;
        else if (r.before.startsWith(oldPath + "/")) r.before = newPath + r.before.slice(oldPath.length);
    }
}

/**
 * 英文基准路径 → 当前语言显示路径（用分类翻译字典逐段映射）。
 * 翻译未启用 / 字典不可用时为恒等映射（显示英文原文）。
 * 用户自定义的中文分类名不在字典键中，会原样保留。
 */
function toDisplayPath(basePath) {
    const catsT = window.__UiTranslated?.NodeCategory || {};
    if (!basePath || !Object.keys(catsT).length) return String(basePath || "");
    return String(basePath).split("/").map((seg) => catsT[seg] || seg).join("/");
}

/**
 * 当前显示路径 → 英文基准路径。
 *
 * 规则以英文基准路径为准（界面语言切换不影响规则），因此把树上拿到的
 * 显示路径（可能是中文）反查回基准：
 * 1. 优先用节点数据反查（最可靠，能覆盖用户重命名后的自定义分类名）
 * 2. 其次用规则逆向回溯（兼容历史规则）
 */
function baseOfDispPath(dispPath) {
    if (!dispPath) return "";
    // 1) 节点数据反查
    const exact = CM.baseByDisp.get(dispPath);
    if (exact) return exact;
    // 2) 父级前缀反查：dispPath 是某个已知显示路径的祖先
    let best = null;
    let bestLen = -1;
    for (const [disp, base] of CM.baseByDisp) {
        if (disp.startsWith(dispPath + "/") && dispPath.length > bestLen) {
            const rest = disp.slice(dispPath.length);
            bestLen = dispPath.length;
            best = base.slice(0, base.length - rest.length);
        }
    }
    if (best) return best;
    // 3) 规则逆向回溯（历史规则兼容）
    return baseOfDispPathByRules(dispPath);
}

/** 沿 category_rename 规则逆向回溯：显示路径 → 基准路径 */
function baseOfDispPathByRules(dispPath) {
    const rename = CM.rules.category_rename || {};
    const entries = Object.entries(rename).filter(([k, v]) => k && v);
    let cur = dispPath;
    for (let i = 0; i < 6; i++) {
        let next = null;
        // 精确：某规则的值正好是当前路径
        for (const [k, v] of entries) {
            if (v === cur && k.split("/").pop() === cur.split("/").pop()) { next = k; break; }
        }
        // 最长前缀：某规则的值是当前路径的父级
        if (!next) {
            let bestLen = 0;
            for (const [k, v] of entries) {
                if (cur.startsWith(v + "/") && v.length > bestLen) {
                    bestLen = v.length;
                    next = k + cur.slice(v.length);
                }
            }
        }
        if (!next || next === cur) break;
        cur = next;
    }
    return cur;
}

/** 取路径的父级（顶层返回空串） */
function parentOfPath(p) {
    return String(p || "").split("/").slice(0, -1).join("/");
}

/**
 * 把分类（显示路径）移动到新的显示路径。
 * - 自建空分类：直接更新 empty_categories 中的路径（其下空子分类跟随）
 * - 普通分类：写 category_rename 规则（键 = 基准路径，值 = 目标位置的基准语义路径）
 *   → 保证之后的链式应用能把该分类及其所有子分类/内部节点整体带过去
 * @param {string} dispPath 源分类当前显示路径
 * @param {string} newDispPath 目标显示路径
 * @param {string} [nameOverride] 新末段名（重命名时使用，默认沿用原名）
 * @returns {boolean} 是否产生了变化
 */
function moveCategoryTo(dispPath, newDispPath, nameOverride) {
    if (!dispPath || !newDispPath || dispPath === newDispPath) return false;
    // 规则一律记录英文基准路径：末段名取基准路径的末段，
    // 避免把中文显示名（翻译结果）写进规则导致关闭翻译后错位。
    const srcBase = baseOfDispPath(dispPath);
    const name = nameOverride || srcBase.split("/").pop();

    // 自建空分类（尚未包含真实节点）
    if (CM.emptySet && CM.emptySet.has(dispPath)) {
        const empties = CM.rules.empty_categories || [];
        CM.rules.empty_categories = empties.map((p) =>
            p === dispPath ? newDispPath
                : (p.startsWith(dispPath + "/") ? newDispPath + p.slice(dispPath.length) : p)
        );
        syncOrderRulesForRename(dispPath, newDispPath);
        return true;
    }

    // 普通分类：构造「基准语义」的目标值
    const parentDisp = parentOfPath(newDispPath);
    const parentBase = parentDisp ? baseOfDispPath(parentDisp) : "";
    const ruleValue = parentBase ? parentBase + "/" + name : name;

    const rename = CM.rules.category_rename || (CM.rules.category_rename = {});
    if (ruleValue === srcBase) {
        delete rename[srcBase]; // 移回原位 = 清除规则
    } else {
        rename[srcBase] = ruleValue;
    }
    if (srcBase !== dispPath && rename[dispPath] !== undefined) delete rename[dispPath]; // 清理历史遗留键
    syncOrderRulesForRename(srcBase, ruleValue); // 排序规则同样以基准路径记录
    return true;
}

/**
 * 应用排序规则：按规则链重排 nodeDefsByName 字典的 key 顺序。
 * 依赖 ComfyUI 节点库默认 original 排序策略（按数组原序渲染树）。
 * 内部实现 hack，全程保护：任何异常只跳过排序，不影响其他功能。
 */
function applyOrderRules() {
    try {
        const store = getNodeDefStore();
        const dict = store?.nodeDefsByName;
        const rules = CM.rules.order_rules || [];
        if (!dict || !rules.length) return;
        let keys = Object.keys(dict);
        let moved = false;
        for (const rule of rules) {
            if (!rule?.key || !rule.before) continue;
            const isCat = rule.type === "cat";
            // 排序规则以英文基准路径记录，用节点应用规则后的基准路径匹配
            const catOf = (k) => {
                const fb = CM.finalBase.get(k);
                if (fb !== undefined) return fb;
                const nd = dict[k];
                return String(CM.rawCategory.get(k) ?? nd?._original_category ?? nd?.category ?? "");
            };
            const nameOf = (k) => String(dict[k]?.name || "");
            const hit = (k, path) =>
                isCat ? (catOf(k) === path || catOf(k).startsWith(path + "/")) : nameOf(k) === path;
            const srcKeys = keys.filter((k) => hit(k, rule.key));
            if (!srcKeys.length) continue;
            const dstKey = keys.find((k) => hit(k, rule.before));
            if (!dstKey || srcKeys.includes(dstKey)) continue;
            const nk = [];
            for (const k of keys) {
                if (k === dstKey) for (const s of srcKeys) nk.push(s);
                if (!srcKeys.includes(k)) nk.push(k);
            }
            keys = nk;
            moved = true;
        }
        if (!moved) return; // 规则未命中：不重排，避免触发无意义的树重建
        const nd = {};
        for (const k of keys) nd[k] = dict[k];
        if (Object.keys(nd).length === Object.keys(dict).length) store.nodeDefsByName = nd;
    } catch (e) {
        console.warn(`[${CM_NAMESPACE}] 应用排序规则失败（已跳过）：`, e);
    }
}

// ============================================================
// 拖拽触发方式（鼠标键 + 任意修饰键组合，支持无修饰键直接拖拽）
// ============================================================

/** 规范化触发配置（容错） */
function normalizeTrigger(t) {
    const mouse = t && t.mouse === "left" ? "left" : "right";
    let modifier = String((t && t.modifier) || "").toLowerCase();
    const parts = modifier.split("+").map((s) => s.trim()).filter((p) => p === "alt" || p === "ctrl" || p === "shift");
    // 去重并按固定顺序排列
    const order = ["ctrl", "alt", "shift"];
    modifier = order.filter((k) => parts.includes(k)).join("+");
    return { mouse, modifier };
}

/** 事件是否命中当前配置的拖拽触发方式 */
function matchTrigger(e) {
    const t = normalizeTrigger(CM.rules.drag_trigger);
    const wantBtn = t.mouse === "left" ? 0 : 2;
    if (e.button !== wantBtn) return false;
    const need = { alt: false, ctrl: false, shift: false };
    if (t.modifier) for (const p of t.modifier.split("+")) if (p in need) need[p] = true;
    return e.altKey === need.alt && e.ctrlKey === need.ctrl && e.shiftKey === need.shift;
}

/** 触发方式的显示文案（如 "Ctrl+Shift + Right"、"Left"） */
function triggerLabelOf(t) {
    const btn = tr(t.mouse === "left" ? "Left" : "Right");
    if (!t.modifier) return btn;
    const mod = t.modifier.split("+").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("+");
    return `${mod} + ${btn}`;
}

/** 拖拽触发键的显示文案 */
function triggerLabel() {
    return triggerLabelOf(normalizeTrigger(CM.rules.drag_trigger));
}

/** 管理菜单触发配置：拖拽键含修饰键时沿用；纯鼠标键时回退 Alt+右键（保护原生菜单） */
function menuTriggerConfig() {
    const t = normalizeTrigger(CM.rules.drag_trigger);
    return t.modifier ? t : { mouse: "right", modifier: "alt" };
}

/** 管理菜单触发键的显示文案（可能与拖拽键不同） */
function menuTriggerLabel() {
    return triggerLabelOf(menuTriggerConfig());
}

// ============================================================
// 索引构建（从 store 读，供树交互反查）
// ============================================================

function rebuildIndex(store) {
    CM.catIndex.clear();
    CM.nodeIndex.clear();
    CM.classIndex.clear();
    CM.baseByDisp.clear();
    for (const nd of store.nodeDefs) {
        if (!nd || !nd.name) continue;
        const dispPath = String(nd.category || "");
        if (!dispPath) continue;

        CM.catIndex.set(dispPath, dispPath);

        // 显示路径 → 英文基准路径（把树上的路径反查回与语言无关的基准）
        if (!CM.baseByDisp.has(dispPath)) {
            CM.baseByDisp.set(dispPath, String(CM.rawCategory.get(nd.name) ?? nd._original_category ?? nd.category ?? ""));
        }

        const entry = { name: nd.name, dispPath };
        const label = nd.display_name || nd.name;
        let arr = CM.nodeIndex.get(label);
        if (!arr) { arr = []; CM.nodeIndex.set(label, arr); }
        if (!arr.some((e) => e.name === nd.name && e.dispPath === dispPath)) arr.push(entry);

        let clsArr = CM.classIndex.get(nd.name);
        if (!clsArr) { clsArr = []; CM.classIndex.set(nd.name, clsArr); }
        if (!clsArr.some((e) => e.dispPath === dispPath)) clsArr.push(entry);
    }

    // 自建空分类：尚未放入任何内容 → 加入索引集合（可显示/可拖入），放入内容后自动转正
    CM.emptySet.clear();
    const kept = [];
    for (const p of CM.rules.empty_categories || []) {
        let hasReal = CM.catIndex.has(p);
        if (!hasReal) {
            for (const k of CM.catIndex.keys()) {
                if (k.startsWith(p + "/")) { hasReal = true; break; }
            }
        }
        if (hasReal) continue; // 已在树中真实存在 → 转为普通分类
        kept.push(p);
        CM.emptySet.add(p);
        CM.catIndex.set(p, p);
    }
    if (kept.length !== (CM.rules.empty_categories || []).length) CM.rules.empty_categories = kept;

    renderEmptyRows();
}

/**
 * 拉取后端原始分类（/object_info 的 category 是纯英文原文）。
 *
 * 前端 i18n 会在插件钩子执行前就改写 nodeDef.category（可能只翻译其中一部分，
 * 例如 "conditioning/video_models" → "条件/video_models"），因此节点自带的
 * category 不能作为与语言无关的基准。后端数据才是权威来源。
 */
async function fetchRawCategories() {
    if (CM.rawFetched) return;
    CM.rawFetched = true;
    try {
        const resp = await fetch("./object_info");
        if (!resp.ok) return;
        const info = await resp.json();
        let n = 0;
        for (const cls of Object.keys(info)) {
            const c = info[cls]?.category;
            if (typeof c === "string" && c) { CM.rawCategory.set(cls, c); n++; }
        }
        if (!n) return;
        // 用后端原始分类重建基准，再重新应用规则（交互早已就绪，不影响使用）
        CM.ready = false;
        CM.baseCategory.clear();
        reapply();
        applyOrderRules();
        console.log(`[${CM_NAMESPACE}] 已载入后端原始分类 ${n} 条（基准与界面语言无关）`);
    } catch (e) {
        console.warn(`[${CM_NAMESPACE}] 载入后端原始分类失败，回退到节点自带分类：`, e);
    }
}

// ============================================================
// 热更新核心
// ============================================================

/** 重新注册隐藏过滤器（unregister + register 触发可见节点重算） */
function refreshHiddenFilter(store) {
    if (typeof store.unregisterNodeDefFilter === "function") {
        try { store.unregisterNodeDefFilter(FILTER_ID); } catch (e) { /* 未注册时忽略 */ }
    }
    if (typeof store.registerNodeDefFilter === "function") {
        store.registerNodeDefFilter({
            id: FILTER_ID,
            name: "UIIIAIII Hidden Categories",
            description: tr("Hide categories and nodes according to the Node Category Manager rules"),
            predicate: (nodeDef) => {
                // 隐藏规则以英文基准路径记录，这里查节点应用规则后的基准路径
                const cls = String(nodeDef?.name || "");
                const base = CM.finalBase.get(cls)
                    ?? CM.rawCategory.get(cls)
                    ?? String(nodeDef?._original_category ?? nodeDef?.category ?? "");
                return !isHiddenBasePath(base) && !isHiddenNode(cls);
            },
        });
    }
}

/**
 * 热更新：把当前规则应用到全部节点并写回 store（树立即刷新，无需重启页面）
 * @returns {boolean} 是否成功
 */
function reapply() {
    const store = getNodeDefStore();
    if (!store || !Array.isArray(store.nodeDefs)) return false;

    // 首次：记录英文基准（优先后端原始分类，与界面语言无关）
    if (!CM.ready) {
        for (const nd of store.nodeDefs) {
            if (nd && nd.name && !CM.baseCategory.has(nd.name)) {
                CM.baseCategory.set(nd.name, String(CM.rawCategory.get(nd.name) ?? nd._original_category ?? nd.category ?? ""));
            }
        }
        CM.ready = true;
    }

    // 从基准 + 规则重算每个节点的基准路径，再按当前语言翻译为显示路径
    CM.finalBase.clear();
    let changed = 0;
    for (const nd of store.nodeDefs) {
        if (!nd || !nd.name) continue;
        const base = CM.baseCategory.get(nd.name);
        if (base === undefined) continue;
        const finalBase = applyRulesTo(nd.name, base);
        CM.finalBase.set(nd.name, finalBase);
        const disp = toDisplayPath(finalBase);
        if (nd.category !== disp) { nd.category = disp; changed++; }
    }
    CM.perf.lastChanged = changed;

    refreshHiddenFilter(store);
    rebuildIndex(store);
    return true;
}

/** 保存规则到后端（保存后热更新，不再需要刷新） */
async function saveRules() {
    try {
        reapply();
        applyOrderRules(); // 排序规则：重排字典 key 序（树实时更新）
    } catch (e) {
        console.error(`[${CM_NAMESPACE}] 热更新失败：`, e);
    }
    try {
        const resp = await fetch("./uiiiaiii/category-overrides", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(CM.rules),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        showToast(tr("Category rules applied"));
    } catch (e) {
        console.error(`[${CM_NAMESPACE}] 保存分类规则失败：`, e);
        showToast(tr("Failed to save category rules: {msg}", { msg: e.message }), true);
    }
}

/** 轻量提示（右上角浮层，自动消失） */
function showToast(text, isError) {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText =
        "position:fixed;top:70px;right:20px;z-index:100003;padding:8px 14px;border-radius:6px;" +
        `background:${isError ? "#a33" : "#2a2a2a"};color:#eee;font-size:13px;` +
        "border:1px solid #444;box-shadow:0 4px 12px rgba(0,0,0,.4);";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
}

// ============================================================
// 树 DOM 适配（虚拟平铺列表）
// ============================================================

const ROW_SEL = 'div[class*="group/tree-node"]';

/** 当前虚拟列表中渲染的可见行（按视觉顺序） */
function visibleRows() {
    return Array.from(document.querySelectorAll(ROW_SEL))
        .map((el) => ({
            el,
            label: (el.querySelector("span")?.textContent || "").trim(),
            level: parseInt(el.getAttribute("aria-level") || "1", 10),
            isFolder: el.hasAttribute("aria-expanded"),
            top: parseFloat((el.style.top || "0").replace("px", "")) || 0,
        }))
        .filter((r) => r.label)
        .sort((a, b) => a.top - b.top);
}

/** 用 aria-level 栈重建每个可见行的局部路径（滚出视口的祖先以 "?" 占位） */
function visibleRowsWithPaths() {
    const stack = [];
    return visibleRows().map((r) => {
        stack.length = Math.max(0, r.level - 1);
        stack[r.level - 1] = r.label;
        const parts = [];
        for (let i = 0; i < r.level; i++) parts.push(stack[i] || "?");
        r.localPath = parts.join("/");
        return r;
    });
}

/** 段级后缀匹配：catKey 的尾部段序列等于 localPath 的段序列 */
function suffixMatch(catKey, localPath) {
    const a = catKey.split("/");
    const b = localPath.split("/");
    if (b.length > a.length) return false;
    for (let i = 0; i < b.length; i++) {
        if (a[a.length - b.length + i] !== b[i]) return false;
    }
    return true;
}

/**
 * 分类行的候选完整路径
 * - 路径完整：精确或前缀命中（自身或其子路径），且段数不少于行层级
 * - 路径截断（含 "?"）：段级后缀匹配
 */
function categoryCandidates(localPath, level) {
    if (!localPath) return [];
    const lv = level || localPath.split("/").length;
    const truncated = localPath.includes("?");
    const out = [];
    for (const k of CM.catIndex.keys()) {
        if (k.split("/").length < lv) continue;
        if (truncated) {
            if (suffixMatch(k, localPath)) out.push(k);
        } else if (k === localPath || k.startsWith(localPath + "/")) {
            out.push(k);
        }
    }
    return out;
}

/** 叶子行的候选条目（显示名索引 + 路径后缀过滤） */
function leafCandidates(row) {
    const arr = CM.nodeIndex.get(row.label) || [];
    const filtered = arr.filter((e) => suffixMatch(e.dispPath, row.localPath));
    return filtered.length ? filtered : arr;
}

/** 收集某显示路径下（含子路径）的所有节点；sourcePath 为空 = 全部 */
function nodesUnderPath(dispPath) {
    const out = [];
    const prefix = dispPath ? dispPath + "/" : "";
    for (const arr of CM.classIndex.values()) {
        for (const e of arr) {
            if (!dispPath || e.dispPath === dispPath || e.dispPath.startsWith(prefix)) {
                if (!out.some((x) => x.name === e.name)) out.push({ name: e.name, dispPath: e.dispPath });
            }
        }
    }
    return out;
}

/** 目标文件夹行是否可接收拖放（路径完整且确实存在节点路径） */
function droppableFolder(row) {
    if (!row.localPath || row.localPath.includes("?")) return false;
    return categoryCandidates(row.localPath, row.level).length > 0;
}

/**
 * 解析虚拟滚动截断的行路径（含 "?"）。
 * 借助分类索引做后缀匹配：唯一命中 → 返回完整路径；无法确定 → null。
 */
function resolveTruncatedPath(row) {
    const lp = row.localPath || "";
    if (!lp.includes("?")) return lp;
    const cands = categoryCandidates(lp, row.level);
    return cands.length === 1 ? cands[0] : null;
}

// ============================================================
// 自建空分类行（插入到分类树末尾，外观与普通分类一致）
// ============================================================

let cmEmptyWrap = null;
let cmEmptyObserver = null;
let cmEmptyObservedHost = null;

/** 宿主容器变化时毫秒级重插（面板重开/树重渲染后不出现延迟闪烁） */
function ensureEmptyRowsObserver(host) {
    if (cmEmptyObserver && cmEmptyObservedHost === host) return;
    if (cmEmptyObserver) { cmEmptyObserver.disconnect(); cmEmptyObserver = null; }
    cmEmptyObservedHost = host;
    cmEmptyObserver = new MutationObserver(() => { renderEmptyRows(); });
    cmEmptyObserver.observe(host, { childList: true });
}

/** 渲染/刷新空分类行（紧跟分类树最后一行之后，外观与普通分类一致） */
function renderEmptyRows() {
    const list = [...CM.emptySet].filter((p) => !isHiddenBasePath(p)).sort();
    const rowsList = list.length ? visibleRows() : [];
    const anchor = rowsList.length ? rowsList[rowsList.length - 1].el : null; // 视觉最后一行
    const seg = anchor ? anchor.parentElement : null;                          // 其所在段落容器
    if (!list.length || !seg || !seg.parentElement) {
        if (cmEmptyWrap) { cmEmptyWrap.remove(); cmEmptyWrap = null; }
        return;
    }
    const host = seg.parentElement;

    const sig = list.join("|");
    if (!cmEmptyWrap || !cmEmptyWrap.isConnected || cmEmptyWrap.dataset.sig !== sig) {
        // 内容变化 → 重建行
        cmEmptyWrap = document.createElement("div");
        cmEmptyWrap.dataset.cmEmptyWrap = "1";
        cmEmptyWrap.dataset.sig = sig;
        cmEmptyWrap.style.cssText = "position:relative;width:100%;";
        for (const p of list) {
            const row = document.createElement("div");
            row.dataset.cmEmptyCat = p;
            row.textContent = p;
            row.style.cssText =
                "display:flex;align-items:center;height:36px;padding:0 12px 0 28px;border-radius:4px;cursor:pointer;" +
                "color:#ddd;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
            row.addEventListener("mouseenter", () => { row.style.background = "#3a3a3a"; });
            row.addEventListener("mouseleave", () => { row.style.background = ""; });
            row.title = tr("Custom category: {name} (empty)\nRight-click to manage; drag nodes or categories here to drop in", { name: p });
            cmEmptyWrap.appendChild(row);
        }
    }
    // 位置修正：仅移动元素，不重建（避免闪烁）
    if (cmEmptyWrap.parentElement !== host || cmEmptyWrap.previousElementSibling !== seg) {
        seg.insertAdjacentElement("afterend", cmEmptyWrap);
    }
    ensureEmptyRowsObserver(host);
}

// ============================================================
// 菜单 UI
// ============================================================

let cmMenuEl = null;
function closeMenu() {
    if (cmMenuEl) { cmMenuEl.remove(); cmMenuEl = null; }
}

/** 读取 ComfyUI 主题 CSS 变量（缺省回退旧配色） */
function themeColor(name, fallback) {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    } catch (e) {
        return fallback;
    }
}

function showMenu(x, y, items) {
    closeMenu();
    cmMenuEl = document.createElement("div");
    const bg = themeColor("--color-charcoal-800", "#2a2a2a");
    const border = themeColor("--border-default", "#444");
    const fg = themeColor("--color-white", "#ddd");
    const hoverBg = themeColor("--color-charcoal-700", "#3a3a3a");
    cmMenuEl.dataset.cmMenu = "1";
    cmMenuEl.style.cssText =
        `position:fixed;z-index:100000;min-width:180px;background:${bg};border:1px solid ${border};` +
        `border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.5);padding:4px;font-size:13px;color:${fg};`;
    for (const it of items) {
        if (!it) continue;
        const b = document.createElement("div");
        if (it.header) {
            b.textContent = it.header;
            b.style.cssText = "padding:4px 12px;color:#888;font-size:11px;border-bottom:1px solid " + border + ";margin-bottom:2px;white-space:nowrap;";
        } else if (it.sep) {
            b.style.cssText = "height:1px;background:" + border + ";margin:4px 6px;";
        } else {
            b.textContent = it.label;
            b.style.cssText =
                "padding:6px 12px;border-radius:4px;cursor:pointer;white-space:nowrap;" +
                (it.danger ? "color:#e05555;" : "");
            b.addEventListener("mouseenter", () => (b.style.background = hoverBg));
            b.addEventListener("mouseleave", () => (b.style.background = ""));
            b.addEventListener("click", () => { closeMenu(); it.onclick(); });
        }
        cmMenuEl.appendChild(b);
    }
    document.body.appendChild(cmMenuEl);
    const rect = cmMenuEl.getBoundingClientRect();
    cmMenuEl.style.left = Math.min(x, window.innerWidth - rect.width - 8) + "px";
    cmMenuEl.style.top = Math.min(y, window.innerHeight - rect.height - 8) + "px";
}

// 菜单外点击关闭：capture 阶段监听（组件内部 stopPropagation 也能收到）
let cmDismissInstalled = false;
function setupGlobalMenuDismiss() {
    if (cmDismissInstalled) return;
    cmDismissInstalled = true;
    document.addEventListener("mousedown", (e) => {
        if (cmMenuEl && !cmMenuEl.contains(e.target)) closeMenu();
    }, true);
    // 画布工作区用 pointerdown（mousedown 覆盖不到的场景），点击外部统一关闭
    document.addEventListener("pointerdown", (e) => {
        if (cmMenuEl && !cmMenuEl.contains(e.target)) closeMenu();
    }, true);
    document.addEventListener("contextmenu", (e) => {
        if (cmMenuEl && !cmMenuEl.contains(e.target)) closeMenu();
    }, true);
    // 滚动会导致 fixed 定位的菜单与目标错位，直接关闭
    document.addEventListener("wheel", () => { if (cmMenuEl) closeMenu(); }, true);
    // Esc 关闭
    document.addEventListener("keydown", (e) => {
        if (cmMenuEl && (e.key === "Escape" || e.key === "Esc")) closeMenu();
    }, true);
}

/** 通用输入对话框（替代原生 prompt，可控且样式一致） */
function showInputDialog(opt) {
    // opt: { title, desc, defaultValue, placeholder, confirmText, onConfirm(value) }
    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100001;display:flex;align-items:center;justify-content:center;";
    const dlg = document.createElement("div");
    dlg.style.cssText =
        "background:#2a2a2a;color:#ddd;border-radius:8px;padding:16px;min-width:360px;box-shadow:0 8px 32px rgba(0,0,0,.5);font-size:13px;";
    dlg.innerHTML =
        `<div style="font-weight:bold;margin-bottom:6px;">${opt.title}</div>` +
        (opt.desc ? `<div style="margin-bottom:8px;color:#aaa;word-break:break-all;white-space:pre-line;">${opt.desc}</div>` : "") +
        `<input id="cm-input-value" placeholder="${opt.placeholder || ""}" value="${opt.defaultValue || ""}"` +
        ` style="width:100%;box-sizing:border-box;padding:6px 8px;margin-bottom:12px;border:1px solid #555;border-radius:4px;background:#1e1e1e;color:#ddd;outline:none;" />` +
        `<div style="display:flex;justify-content:flex-end;gap:8px;">` +
        `<button id="cm-input-cancel" style="padding:5px 14px;background:#444;color:#ddd;border:none;border-radius:4px;cursor:pointer;">${tr("Cancel")}</button>` +
        `<button id="cm-input-ok" style="padding:5px 14px;background:#4a9eff;color:#fff;border:none;border-radius:4px;cursor:pointer;">${opt.confirmText || tr("OK")}</button></div>`;
    overlay.appendChild(dlg);
    document.body.appendChild(overlay);

    const input = dlg.querySelector("#cm-input-value");
    const close = () => overlay.remove();
    dlg.querySelector("#cm-input-cancel").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    const submit = () => {
        const v = input.value.trim();
        if (!v) { input.focus(); return; }
        close();
        opt.onConfirm(v);
    };
    dlg.querySelector("#cm-input-ok").addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    input.focus();
    input.select();
}

/** 通用确认对话框 */
function showConfirmDialog(opt) {
    // opt: { title, desc, confirmText, danger, onConfirm() }
    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100001;display:flex;align-items:center;justify-content:center;";
    const dlg = document.createElement("div");
    dlg.style.cssText =
        "background:#2a2a2a;color:#ddd;border-radius:8px;padding:16px;min-width:340px;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,.5);font-size:13px;";
    dlg.innerHTML =
        `<div style="font-weight:bold;margin-bottom:6px;">${opt.title}</div>` +
        (opt.desc ? `<div style="margin-bottom:12px;color:#aaa;white-space:pre-line;">${opt.desc}</div>` : "") +
        `<div style="display:flex;justify-content:flex-end;gap:8px;">` +
        `<button id="cm-confirm-cancel" style="padding:5px 14px;background:#444;color:#ddd;border:none;border-radius:4px;cursor:pointer;">${tr("Cancel")}</button>` +
        `<button id="cm-confirm-ok" style="padding:5px 14px;background:${opt.danger ? "#c04a4a" : "#4a9eff"};color:#fff;border:none;border-radius:4px;cursor:pointer;">${opt.confirmText || tr("OK")}</button></div>`;
    overlay.appendChild(dlg);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    dlg.querySelector("#cm-confirm-cancel").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    dlg.querySelector("#cm-confirm-ok").addEventListener("click", () => { close(); opt.onConfirm(); });
    dlg.querySelector("#cm-confirm-ok").focus();
}

/** 批量移动对话框（新建子分类 / 删除分类共用）：多选节点 + 目标分类 */
function showBatchMoveDialog(opt) {
    // opt: { title, sourcePath, nodes: [{name, dispPath}], targetDefault, confirmText, onConfirm(names, target) }
    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100001;display:flex;align-items:center;justify-content:center;";
    const dlg = document.createElement("div");
    dlg.style.cssText =
        "background:#2a2a2a;color:#ddd;border-radius:8px;padding:16px;min-width:380px;max-width:460px;" +
        "max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.5);font-size:13px;";
    dlg.innerHTML =
        `<div style="font-weight:bold;margin-bottom:4px;">${opt.title}</div>` +
        `<div style="margin-bottom:8px;color:#aaa;">${tr("Source category: {path}", { path: opt.sourcePath })}</div>` +
        `<div style="margin-bottom:6px;">${tr("Target category:")}<input id="cm-batch-target" list="cm-batch-cats" value="${opt.targetDefault || ""}"` +
        ` style="width:60%;box-sizing:border-box;padding:5px 8px;border:1px solid #555;border-radius:4px;background:#1e1e1e;color:#ddd;outline:none;" /></div>` +
        `<datalist id="cm-batch-cats"></datalist>` +
        `<div style="margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;">` +
        `<span>${tr("Nodes to move:")}</span>` +
        `<label style="color:#4a9eff;cursor:pointer;font-size:12px;"><input type="checkbox" id="cm-batch-all" checked /> ${tr("Select All")}</label></div>` +
        `<div id="cm-batch-list" style="flex:1;min-height:120px;max-height:260px;overflow-y:auto;border:1px solid #444;border-radius:4px;padding:4px;margin-bottom:10px;"></div>` +
        `<div style="display:flex;justify-content:flex-end;gap:8px;">` +
        `<button id="cm-batch-cancel" style="padding:5px 14px;background:#444;color:#ddd;border:none;border-radius:4px;cursor:pointer;">${tr("Cancel")}</button>` +
        `<button id="cm-batch-ok" style="padding:5px 14px;background:#4a9eff;color:#fff;border:none;border-radius:4px;cursor:pointer;">${opt.confirmText || tr("OK")}</button></div>`;
    overlay.appendChild(dlg);
    document.body.appendChild(overlay);

    const datalist = dlg.querySelector("#cm-batch-cats");
    for (const p of [...CM.catIndex.keys()].sort()) {
        const o = document.createElement("option");
        o.value = p;
        datalist.appendChild(o);
    }

    const list = dlg.querySelector("#cm-batch-list");
    const boxes = [];
    for (const nd of opt.nodes) {
        const lab = document.createElement("label");
        lab.style.cssText = "display:flex;align-items:center;gap:6px;padding:3px 4px;border-radius:3px;cursor:pointer;";
        lab.innerHTML = `<input type="checkbox" checked data-name="${nd.name}" style="cursor:pointer;" />` +
            `<span style="word-break:break-all;">${nd.name}</span>`;
        list.appendChild(lab);
        boxes.push(lab.querySelector("input"));
    }
    const allBox = dlg.querySelector("#cm-batch-all");
    allBox.addEventListener("change", () => boxes.forEach((b) => (b.checked = allBox.checked)));

    const close = () => overlay.remove();
    dlg.querySelector("#cm-batch-cancel").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    dlg.querySelector("#cm-batch-ok").addEventListener("click", () => {
        const target = dlg.querySelector("#cm-batch-target").value.trim();
        if (!target) { alert(tr("Please enter a target category")); return; }
        const names = boxes.filter((b) => b.checked).map((b) => b.dataset.name);
        if (!names.length) { alert(tr("No nodes selected")); return; }
        close();
        opt.onConfirm(names, target);
    });
}

// ============================================================
// 分类操作
// ============================================================

/** 新建自建空分类（放入内容后自动转为普通分类） */
function addEmptyCategory(p) {
    if (!CM.rules.empty_categories) CM.rules.empty_categories = [];
    if (CM.rules.empty_categories.includes(p)) { showToast(tr("This empty category already exists")); return; }
    if (CM.catIndex.has(p) && !CM.emptySet.has(p)) { showToast(tr("Category already exists (contains nodes)")); return; }
    CM.rules.empty_categories.push(p);
    CM.emptySet.add(p);
    CM.catIndex.set(p, p);
    saveRules();
}

/** 新建子分类（空分类：先创建，之后拖拽节点/分类放入） */
function actionNewSubCategory(key) {
    showInputDialog({
        title: tr("New Subcategory"),
        desc: tr("Parent category: {path} (multi-level paths allowed, e.g. Video/Composite)", { path: key }),
        placeholder: tr("Subcategory name"),
        confirmText: tr("Create"),
        onConfirm: (name) => {
            const seg = name.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
            if (!seg) return;
            addEmptyCategory(key + "/" + seg);
        },
    });
}

/** 新建主分类（空分类：先创建，之后拖拽节点/分类放入） */
function actionNewTopCategory() {
    showInputDialog({
        title: tr("New Top-Level Category"),
        desc: tr("Create an empty category at the top level (multi-level paths allowed, e.g. Assets/HD)"),
        placeholder: tr("Top-level category name"),
        confirmText: tr("Create"),
        onConfirm: (name) => {
            const p = name.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
            if (!p) return;
            addEmptyCategory(p);
        },
    });
}

/** 删除空分类（无内容，直接移除；其下空子分类一并移除） */
function actionDeleteEmptyCat(path) {
    CM.rules.empty_categories = (CM.rules.empty_categories || []).filter(
        (p) => p !== path && !p.startsWith(path + "/")
    );
    saveRules();
}

/** 重命名空分类（其下空子分类跟随移动） */
function actionRenameEmptyCat(path) {
    showInputDialog({
        title: tr("Rename Category"),
        desc: tr("Current: {path} (empty category; its subcategories will follow)", { path }),
        defaultValue: path,
        confirmText: tr("Rename"),
        onConfirm: (np) => {
            if (!np || np === path) return;
            CM.rules.empty_categories = (CM.rules.empty_categories || []).map((p) =>
                p === path ? np : (p.startsWith(path + "/") ? np + p.slice(path.length) : p)
            );
            saveRules();
        },
    });
}

/** 重命名分类（其下子分类跟随移动） */
function actionRenameCategory(key) {
    showInputDialog({
        title: tr("Rename Category"),
        desc: tr("Current: {path} (its subcategories will follow)", { path: key }),
        defaultValue: key,
        confirmText: tr("Rename"),
        onConfirm: (np) => {
            if (np && np !== key) {
                moveCategoryTo(key, np, np.split("/").pop()); // 统一走基准语义（含排序规则同步）
                saveRules();
            }
        },
    });
}

/** 删除分类：节点批量移到目标分类后，分类自然消失 */
function actionDeleteCategory(key) {
    const nodes = nodesUnderPath(key);
    if (!nodes.length) { alert(tr("This category has no nodes")); return; }
    const parent = key.split("/").slice(0, -1).join("/");
    showBatchMoveDialog({
        title: tr('Delete category "{key}"', { key }),
        sourcePath: key,
        nodes,
        targetDefault: parent,
        confirmText: tr("Move & Delete"),
        onConfirm: (names, target) => {
            const destBase = baseOfDispPath(target); // 目标用基准语义，后续跟随
            for (const n of names) CM.rules.node_move[n] = destBase;
            delete CM.rules.category_rename[baseOfDispPath(key)];
            delete CM.rules.category_rename[key];
            saveRules();
        },
    });
}

/** 隐藏分类 */
function actionHideCategory(key) {
    const base = baseOfDispPath(key) || key; // 隐藏规则以英文基准路径记录
    if (!CM.rules.hidden_categories.includes(base)) CM.rules.hidden_categories.push(base);
    saveRules();
}

/** 隐藏单个节点 */
function actionHideNode(name) {
    if (!CM.rules.hidden_nodes) CM.rules.hidden_nodes = [];
    if (!CM.rules.hidden_nodes.includes(name)) CM.rules.hidden_nodes.push(name);
    saveRules();
}

/** 查看已隐藏列表（分类 + 节点），支持单项恢复 */
function showHiddenListDialog() {
    const cats = CM.rules.hidden_categories || [];
    const nodes = CM.rules.hidden_nodes || [];
    if (!cats.length && !nodes.length) { showToast(tr("No hidden categories or nodes")); return; }

    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100001;display:flex;align-items:center;justify-content:center;";
    const dlg = document.createElement("div");
    dlg.style.cssText =
        "background:#2a2a2a;color:#ddd;border-radius:8px;padding:16px;min-width:380px;max-width:460px;" +
        "max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.5);font-size:13px;";
    dlg.innerHTML =
        `<div style="font-weight:bold;margin-bottom:10px;">${tr("Hidden Items")}</div>` +
        `<div id="cm-hidden-list" style="flex:1;min-height:100px;max-height:340px;overflow-y:auto;border:1px solid #444;border-radius:4px;padding:6px;margin-bottom:12px;"></div>` +
        `<div style="display:flex;justify-content:flex-end;gap:8px;">` +
        `<button id="cm-hidden-close" style="padding:5px 14px;background:#444;color:#ddd;border:none;border-radius:4px;cursor:pointer;">${tr("Close")}</button></div>`;
    overlay.appendChild(dlg);
    document.body.appendChild(overlay);

    const list = dlg.querySelector("#cm-hidden-list");
    const close = () => overlay.remove();
    dlg.querySelector("#cm-hidden-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    let catHeader = null, nodeHeader = null;
    function addSection(title) {
        const h = document.createElement("div");
        h.textContent = title;
        h.style.cssText = "color:#888;font-size:11px;padding:4px 2px 2px;";
        list.appendChild(h);
        return h;
    }
    function addItem(label, kind, key) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 4px;border-radius:3px;";
        const span = document.createElement("span");
        span.textContent = label;
        span.style.cssText = "flex:1;word-break:break-all;";
        const btn = document.createElement("button");
        btn.textContent = tr("Restore");
        btn.style.cssText =
            "padding:2px 10px;background:#4a9eff;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:12px;flex:none;";
        btn.addEventListener("click", () => {
            if (kind === "cat") {
                CM.rules.hidden_categories = CM.rules.hidden_categories.filter((x) => x !== key);
            } else {
                CM.rules.hidden_nodes = (CM.rules.hidden_nodes || []).filter((x) => x !== key);
            }
            saveRules();
            // 清掉空分组标题；全部恢复完则自动关闭对话框
            if (catHeader && !CM.rules.hidden_categories.length) { catHeader.remove(); catHeader = null; }
            if (nodeHeader && !(CM.rules.hidden_nodes || []).length) { nodeHeader.remove(); nodeHeader = null; }
            row.remove();
            if (!CM.rules.hidden_categories.length && !(CM.rules.hidden_nodes || []).length) close();
        });
        row.appendChild(span);
        row.appendChild(btn);
        list.appendChild(row);
    }

    if (cats.length) {
        catHeader = addSection(tr("Categories ({n})", { n: cats.length }));
        for (const c of cats) addItem(c, "cat", c);
    }
    if (nodes.length) {
        nodeHeader = addSection(tr("Nodes ({n})", { n: nodes.length }));
        for (const n of nodes) addItem(n, "node", n);
    }
}

/** 拖拽按键设置对话框（二选一：Alt+右键 / 右键，均实测无冲突） */
function showDragTriggerDialog() {
    const options = [
        { value: { mouse: "right", modifier: "alt" }, label: tr("Alt + Right-click (Default)") },
        { value: { mouse: "right", modifier: "" }, label: tr("Right-click") },
    ];
    const same = (a, b) => a.mouse === b.mouse && a.modifier === b.modifier;
    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100001;display:flex;align-items:center;justify-content:center;";
    const dlg = document.createElement("div");
    dlg.style.cssText =
        "background:var(--color-charcoal-800, #2a2a2a);color:#fff;border:1px solid var(--border-default, #494a50);border-radius:6px;padding:16px;min-width:320px;box-shadow:0 4px 16px rgba(0,0,0,.5);font-size:13px;";
    const cur = normalizeTrigger(CM.rules.drag_trigger);
    dlg.innerHTML =
        `<div style="font-weight:bold;margin-bottom:6px;">${tr("Drag Button")}</div>` +
        `<div style="margin-bottom:10px;color:#aaa;">${tr("Drag nodes/categories with the selected button: move, drop in, or sort.<br />The other button keeps ComfyUI's native behavior.")}</div>` +
        `<div id="cm-dk-list" style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px;"></div>` +
        `<div style="display:flex;justify-content:flex-end;gap:8px;">` +
        `<button id="cm-dk-cancel" style="padding:5px 14px;background:var(--color-charcoal-600, #444);color:#fff;border:none;border-radius:4px;cursor:pointer;">${tr("Cancel")}</button>` +
        `<button id="cm-dk-ok" style="padding:5px 14px;background:#4a9eff;color:#fff;border:none;border-radius:4px;cursor:pointer;">${tr("OK")}</button></div>`;
    overlay.appendChild(dlg);
    document.body.appendChild(overlay);

    let selected = cur;
    const list = dlg.querySelector("#cm-dk-list");
    for (const opt of options) {
        const row = document.createElement("label");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:4px;cursor:pointer;border:1px solid " +
            (same(opt.value, cur) ? "var(--border-default, #494a50)" : "transparent") + ";";
        row.innerHTML =
            `<input type="radio" name="cm-dk" ${same(opt.value, cur) ? "checked" : ""} style="cursor:pointer;" />` +
            `<span>${opt.label}</span>`;
        row.addEventListener("mouseenter", () => { row.style.background = "var(--color-charcoal-700, #3a3a3a)"; });
        row.addEventListener("mouseleave", () => { row.style.background = ""; });
        row.querySelector("input").addEventListener("change", () => {
            selected = opt.value;
            for (const r of list.children) r.style.borderColor = "transparent";
            row.style.borderColor = "var(--border-default, #494a50)";
        });
        list.appendChild(row);
    }

    const close = () => overlay.remove();
    dlg.querySelector("#cm-dk-cancel").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    dlg.querySelector("#cm-dk-ok").addEventListener("click", () => {
        close();
        if (!same(selected, cur)) {
            CM.rules.drag_trigger = selected;
            saveRules();
            showToast(tr("Drag button set to {label}", { label: triggerLabel() }));
        }
    });
}

/** 恢复此分类为默认（清除该分类及其后代的所有自定义规则） */
function actionRestoreCategory(key) {
    let n = 0;
    const base = baseOfDispPath(key); // 该分类的基准路径
    // 命中条件：规则管辖的分类就是它（含子级），或它被父级规则带动，或目标指向它
    for (const k of Object.keys(CM.rules.category_rename)) {
        const v = CM.rules.category_rename[k];
        const selfHit = k === base || k.startsWith(base + "/") || base.startsWith(k + "/") ||
            k === key || k.startsWith(key + "/");
        const destHit = v === key || v.startsWith(key + "/") || v === base || v.startsWith(base + "/");
        if (selfHit || destHit) {
            delete CM.rules.category_rename[k];
            n++;
        }
    }
    // 移入该分类的节点（值以基准语义记录）
    for (const [name, target] of Object.entries(CM.rules.node_move)) {
        if (target === base || target.startsWith(base + "/") ||
            target === key || target.startsWith(key + "/")) {
            delete CM.rules.node_move[name];
            n++;
        }
    }
    const hiddenBefore = CM.rules.hidden_categories.length;
    CM.rules.hidden_categories = CM.rules.hidden_categories.filter(
        (h) => h !== key && !h.startsWith(key + "/") && h !== base && !h.startsWith(base + "/")
    );
    n += hiddenBefore - CM.rules.hidden_categories.length;
    n += removeOrderRulesForCategory(base);
    n += removeOrderRulesForCategory(key);
    if (!n) { showToast(tr("This category is already in its default state")); return; }
    saveRules();
}

/** 恢复此节点为默认分类（移除该节点的移动规则） */
function actionRestoreNode(name) {
    if (!CM.rules.node_move[name]) { showToast(tr("This node is already in its default category")); return; }
    delete CM.rules.node_move[name];
    saveRules();
}

/** 恢复所有分类：清空全部规则（保留拖拽快捷键偏好） */
function actionRestoreAll() {
    const nRename = Object.keys(CM.rules.category_rename).length;
    const nHidden = CM.rules.hidden_categories.length + (CM.rules.hidden_nodes || []).length;
    const nMove = Object.keys(CM.rules.node_move).length;
    const nEmpty = (CM.rules.empty_categories || []).length;
    const nOrder = (CM.rules.order_rules || []).length;
    if (nRename + nHidden + nMove + nEmpty + nOrder === 0) { showToast(tr("There are no category rules to restore")); return; }
    const parts = [
        tr("Renamed: {n}", { n: nRename }),
        tr("Hidden: {n}", { n: nHidden }),
        tr("Moved: {n}", { n: nMove }),
    ];
    if (nEmpty) parts.push(tr("Empty categories: {n}", { n: nEmpty }));
    if (nOrder) parts.push(tr("Sort rules: {n}", { n: nOrder }));
    showConfirmDialog({
        title: tr("Restore All Categories"),
        desc: tr("This will clear all rules and restore every category to its default state:\n{details}", { details: parts.join(" / ") }),
        confirmText: tr("Restore All"),
        danger: true,
        onConfirm: () => {
            CM.rules = {
                category_rename: {}, hidden_categories: [], node_move: {},
                empty_categories: [], hidden_nodes: [], order_rules: [],
                drag_trigger: CM.rules.drag_trigger || { mouse: "right", modifier: "alt" },
            };
            saveRules();
        },
    });
}

// ============================================================
// 树交互（右键分类菜单 + Alt+右键拖拽）
// ============================================================

function setupTreeInteraction() {
    if (window.__cm_tree_installed) return;
    window.__cm_tree_installed = true;
    setupGlobalMenuDismiss();

    // ---- Alt + 右键拖拽（HTML5 DnD 不支持右键启动，用自定义指针拖拽） ----
    const rd = { pending: false, active: false, startX: 0, startY: 0, x: 0, y: 0, name: null, folderPath: null, label: null, ghost: null, targetRow: null, suppressCtxUntil: 0, targetIsFolder: false, dispPath: null, startButton: 2 };

    function rdCleanup() {
        if (rd.targetRow) { rd.targetRow.el.style.outline = ""; rd.targetRow.el.style.boxShadow = ""; }
        if (rd.ghost) { rd.ghost.remove(); rd.ghost = null; }
        rd.active = false; rd.pending = false;
        rd.name = null; rd.folderPath = null; rd.label = null;
        rd.targetIsFolder = false; rd.dispPath = null;
    }

    function rdGhost(text) {
        if (!rd.ghost) {
            rd.ghost = document.createElement("div");
            rd.ghost.style.cssText =
                "position:fixed;z-index:100002;pointer-events:none;background:rgba(42,42,42,.95);color:#ddd;" +
                "border:1px solid #4a9eff;border-radius:4px;padding:4px 10px;font-size:12px;white-space:nowrap;" +
                "box-shadow:0 2px 8px rgba(0,0,0,.4);";
            document.body.appendChild(rd.ghost);
        }
        rd.ghost.textContent = text;
        rd.ghost.style.left = Math.min(rd.x + 14, window.innerWidth - 200) + "px";
        rd.ghost.style.top = Math.min(rd.y + 14, window.innerHeight - 40) + "px";
    }

    /** 指针位置下的可放置目标行（含自建空分类），带上/下半部判定 */
    function rdTargetAt(x, y) {
        const el = document.elementFromPoint(x, y);
        let target = null;
        let row = null;
        const emptyEl = el && el.closest ? el.closest("[data-cm-empty-cat]") : null;
        if (emptyEl) {
            // 自建空分类行（面板顶部区块）
            target = { el: emptyEl, localPath: emptyEl.dataset.cmEmptyCat, isFolder: true };
        } else {
            const rowEl = el && el.closest ? el.closest(ROW_SEL) : null;
            if (!rowEl) return null;
            const rows = visibleRowsWithPaths();
            row = rows.find((r) => r.el === rowEl);
            if (!row) return null;
            let lp = row.localPath;
            if (row.isFolder) {
                // 文件夹行：截断路径唯一解析（排序/放入都需要完整路径）
                lp = resolveTruncatedPath(row);
                if (!lp) return null;
            }
            target = { el: rowEl, localPath: lp, isFolder: row.isFolder };
        }
        // 防止把分类拖进自己或自己的子分类
        if (rd.folderPath) {
            const t = target.localPath;
            if (t === rd.folderPath || t.startsWith(rd.folderPath + "/")) return null;
        }
        // 空分类行只能作为拖入目标，不能作为排序锚点
        if (emptyEl) { target.upper = false; return target; }

        if (!target.isFolder) {
            // 叶子行：仅叶子拖拽可作为锚点（整行 = 排到该节点前面 / 移入该节点所在分类）
            if (rd.folderPath) return null; // 分类不接受叶子目标（防止写坏路径规则）
            const entries = leafCandidates(row);
            if (!entries.length) return null;
            target.leafName = entries[0].name;              // 排序锚点用类名
            target.leafDispPath = entries[0].dispPath;      // 该节点当前所在分类（显示路径）
            target.upper = true;
            return target;
        }

        // 分类行：上半部 = 排到该分类前；下半部 = 拖入该分类
        const r = target.el.getBoundingClientRect();
        target.upper = (y - r.top) < r.height / 2;
        // 分类只能排到分类前（叶子拖到分类行的排序由 node_move 语义承担）
        if (target.upper && !rd.targetIsFolder) target.upper = false;
        return target;
    }

    // 按下：记录待拖对象（鼠标键与修饰键按用户配置；叶子用显示名反查类名；分类取完整路径）
    document.addEventListener("mousedown", (e) => {
        if (!matchTrigger(e)) return;
        const rowEl = e.target.closest?.(ROW_SEL);
        if (!rowEl) return;
        const rows = visibleRowsWithPaths();
        const row = rows.find((r) => r.el === rowEl);
        if (!row) return;
        if (row.isFolder) {
            // 虚拟滚动截断的行路径（含 "?"）尝试唯一解析；解析不出则无法安全拖拽
            const resolved = resolveTruncatedPath(row);
            if (!resolved) return;
            rd.folderPath = resolved;
            rd.name = null;
        } else {
            const entries = leafCandidates(row);
            if (!entries.length) return; // 无法识别：不启动拖拽
            rd.name = entries[0].name;
            rd.dispPath = entries[0].dispPath;
        }
        rd.label = row.label;
        rd.targetIsFolder = row.isFolder;
        rd.startButton = e.button;
        rd.pending = true;
        rd.startX = e.clientX; rd.startY = e.clientY;
        rd.x = e.clientX; rd.y = e.clientY;
    }, true);

    // 拖动超阈值进入拖拽模式，跟随鼠标高亮目标
    document.addEventListener("mousemove", (e) => {
        if (!rd.pending) return;
        rd.x = e.clientX; rd.y = e.clientY;
        if (!rd.active) {
            if (Math.abs(e.clientX - rd.startX) + Math.abs(e.clientY - rd.startY) < 6) return;
            rd.active = true;
            rdGhost(tr("Dragging: {label}", { label: rd.label }));
        }
        const target = rdTargetAt(e.clientX, e.clientY);
        // 清理上一个目标高亮/插入线
        if (rd.targetRow && (!target || target.el !== rd.targetRow.el)) {
            rd.targetRow.el.style.outline = "";
            rd.targetRow.el.style.boxShadow = "";
        }
        rd.targetRow = target;
        if (!target) { rdGhost(tr("Dragging: {label}", { label: rd.label })); return; }
        if (target.upper) {
            // 上半部：行内顶部插入线（inset 阴影，宽度即面板内行宽）
            target.el.style.outline = "";
            target.el.style.boxShadow = "inset 0 2px 0 0 #4a9eff";
            rdGhost(tr('Sort before "{path}"', { path: target.localPath }));
        } else {
            target.el.style.outline = "1px solid #4a9eff";
            target.el.style.boxShadow = "";
            rdGhost(tr("Release to move into: {path}", { path: target.localPath }));
        }
    }, true);

    // 拖拽中/刚结束时阻止右键菜单（挂在 window capture：早于 ComfyUI 的 document 监听，才能拦得住）
    window.addEventListener("contextmenu", (e) => {
        if (rd.active || Date.now() < rd.suppressCtxUntil) {
            rd.suppressCtxUntil = 0;
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    // 松开：拖拽模式 → 执行移动/排序；未拖动 → 交给原生行为（点击展开/右键菜单）
    document.addEventListener("mouseup", (e) => {
        if (!rd.pending || e.button !== rd.startButton) return;
        if (!rd.active) { rdCleanup(); return; }
        const target = rdTargetAt(e.clientX, e.clientY);
        if (target) {
            if (target.upper) {
                // ★ 上半部（"排到它前面"）：成为与目标「同级」的兄弟
                if (rd.targetIsFolder) {
                    // 分类 → 移到目标分类的同级（顶层目标则移出为顶层分类），并排在目标前面
                    // 比较用英文基准路径（与界面语言无关），移动/排序仍传显示路径
                    const srcBase = baseOfDispPath(rd.folderPath);
                    const srcName = srcBase.split("/").pop();
                    const parentDisp = parentOfPath(target.localPath);
                    const parentBase = parentDisp ? baseOfDispPath(parentDisp) : "";
                    const newBase = parentBase ? parentBase + "/" + srcName : srcName;
                    if (newBase !== srcBase) {
                        const newDisp = parentDisp ? parentDisp + "/" + toDisplayPath(srcName) : toDisplayPath(srcName);
                        moveCategoryTo(rd.folderPath, newDisp);   // 整个分类（含子分类/节点）跟随
                        addOrderRule("cat", newDisp, target.localPath, false);
                    } else {
                        addOrderRule("cat", rd.folderPath, target.localPath, false); // 已在同级：纯排序
                    }
                    saveRules();
                } else if (rd.name) {
                    // 节点 → 移入目标节点所在的分类，并排在目标节点前面
                    const destDisp = target.leafDispPath || "";
                    const destBase = destDisp ? baseOfDispPath(destDisp) : "";
                    if (destBase) CM.rules.node_move[rd.name] = destBase;
                    if (CM.rules.hidden_nodes && CM.rules.hidden_nodes.includes(rd.name)) {
                        CM.rules.hidden_nodes = CM.rules.hidden_nodes.filter((n) => n !== rd.name);
                    }
                    if (target.leafName && target.leafName !== rd.name) {
                        addOrderRule("node", rd.name, target.leafName, false);
                    }
                    saveRules();
                }
            } else if (rd.folderPath) {
                // 分类整体拖到目标分类下（子树跟随）：连同子分类与已移入的节点一起进入
                const srcName = toDisplayPath(baseOfDispPath(rd.folderPath).split("/").pop());
                moveCategoryTo(rd.folderPath, target.localPath + "/" + srcName);
                saveRules();
            } else if (rd.name) {
                // 节点移入目标分类（值用基准语义，之后目标分类若再移动会自动跟随）
                CM.rules.node_move[rd.name] = baseOfDispPath(target.localPath);
                // 拖拽移动视为主动整理：同时取消该节点的隐藏
                if (CM.rules.hidden_nodes && CM.rules.hidden_nodes.includes(rd.name)) {
                    CM.rules.hidden_nodes = CM.rules.hidden_nodes.filter((n) => n !== rd.name);
                }
                saveRules();
            }
        }
        rdCleanup();
        if (rd.startButton === 2) rd.suppressCtxUntil = Date.now() + 400; // 吞掉右键松开后补发的 contextmenu
    }, true);

    // ---- 管理菜单：由拖拽触发键打开；普通右键/左键完全交给 ComfyUI 原生行为 ----

    function matchMenuTrigger(e) {
        const t = menuTriggerConfig();
        const wantBtn = t.mouse === "left" ? 0 : 2;
        if (e.button !== wantBtn) return false;
        const need = { alt: false, ctrl: false, shift: false };
        if (t.modifier) for (const p of t.modifier.split("+")) if (p in need) need[p] = true;
        return e.altKey === need.alt && e.ctrlKey === need.ctrl && e.shiftKey === need.shift;
    }

    /** 构建并显示管理菜单（目标 = 右键/点击命中的行或空分类） */
    function openManageMenu(e, rowEl, emptyEl) {
        if (emptyEl) {
            const key = emptyEl.dataset.cmEmptyCat;
            const items = [
                { header: tr("Custom category: {key}", { key }) },
                { label: tr("New Subcategory..."), onclick: () => actionNewSubCategory(key) },
                { label: tr("Rename Category..."), onclick: () => actionRenameEmptyCat(key) },
                { label: tr("Delete This Category"), danger: true, onclick: () => actionDeleteEmptyCat(key) },
                { label: tr("Hide This Category"), danger: true, onclick: () => actionHideCategory(key) },
                { sep: true },
                { label: tr("Drag Button (Current: {label})...", { label: triggerLabel() }), onclick: showDragTriggerDialog },
                { label: tr("View Hidden Items..."), onclick: showHiddenListDialog },
                { label: tr("Restore All Categories"), onclick: actionRestoreAll },
            ];
            showMenu(e.clientX, e.clientY, items);
            return;
        }
        if (!rowEl || !CM.catIndex.size) return;
        const rows = visibleRowsWithPaths();
        const row = rows.find((r) => r.el === rowEl);
        if (!row) return;
        if (!row.isFolder) {
            // 节点（叶子）：节点管理菜单
            const entries = leafCandidates(row);
            if (!entries.length) return; // 无法识别类名：不弹菜单
            const ent = entries[0];
            const nodeItems = [
                { header: row.label },
                { header: tr("Class: {name} | Category: {path}", { name: ent.name, path: ent.dispPath }) },
                { label: tr("Restore This Node to Default Category"), onclick: () => actionRestoreNode(ent.name) },
                { label: tr("Hide This Node"), danger: true, onclick: () => actionHideNode(ent.name) },
                { sep: true },
                { label: tr("Drag Button (Current: {label})...", { label: triggerLabel() }), onclick: showDragTriggerDialog },
                { label: tr("View Hidden Items..."), onclick: showHiddenListDialog },
                { label: tr("Restore All Categories"), onclick: actionRestoreAll },
            ];
            showMenu(e.clientX, e.clientY, nodeItems);
            return;
        }

        const candidates = categoryCandidates(row.localPath, row.level);
        const valid = candidates.includes(row.localPath) ||
            candidates.some((k) => k.startsWith(row.localPath + "/"));
        const items = [];
        if (valid) {
            const key = row.localPath;
            items.push({ header: key });
            items.push({ label: tr("New Subcategory..."), onclick: () => actionNewSubCategory(key) });
            items.push({ label: tr("New Top-Level Category..."), onclick: () => actionNewTopCategory() });
            items.push({ label: tr("Rename Category..."), onclick: () => actionRenameCategory(key) });
            items.push({ label: tr("Delete This Category (Move Nodes To...)"), danger: true, onclick: () => actionDeleteCategory(key) });
            items.push({ label: tr("Hide This Category"), danger: true, onclick: () => actionHideCategory(key) });
            items.push({ label: tr("Restore This Category to Default"), onclick: () => actionRestoreCategory(key) });
            items.push({ sep: true });
            items.push({ label: tr("Drag Button (Current: {label})...", { label: triggerLabel() }), onclick: showDragTriggerDialog });
            items.push({ label: tr("View Hidden Items..."), onclick: showHiddenListDialog });
            items.push({ label: tr("Restore All Categories"), onclick: actionRestoreAll });
        } else if (candidates.length > 1) {
            // 虚拟滚动导致路径不完整：列出候选让用户选择
            items.push({ header: tr("Please select a category to manage") });
            for (const c of candidates) {
                items.push({
                    label: c,
                    onclick: () => {
                        const sub = [];
                        sub.push({ header: c });
                        sub.push({ label: tr("New Subcategory..."), onclick: () => actionNewSubCategory(c) });
                        sub.push({ label: tr("New Top-Level Category..."), onclick: () => actionNewTopCategory() });
                        sub.push({ label: tr("Rename Category..."), onclick: () => actionRenameCategory(c) });
                        sub.push({ label: tr("Delete This Category (Move Nodes To...)"), danger: true, onclick: () => actionDeleteCategory(c) });
                        sub.push({ label: tr("Hide This Category"), danger: true, onclick: () => actionHideCategory(c) });
                        sub.push({ label: tr("Restore This Category to Default"), onclick: () => actionRestoreCategory(c) });
                        sub.push({ sep: true });
                        sub.push({ label: tr("Drag Button (Current: {label})...", { label: triggerLabel() }), onclick: showDragTriggerDialog });
                        sub.push({ label: tr("View Hidden Items..."), onclick: showHiddenListDialog });
                        sub.push({ label: tr("Restore All Categories"), onclick: actionRestoreAll });
                        showMenu(e.clientX, e.clientY, sub);
                    },
                });
            }
        } else {
            return; // 无法确定目标，不做任何事
        }

        showMenu(e.clientX, e.clientY, items);
    }

    // 右键入口：命中管理触发键才接管；普通右键完全放行 ComfyUI 原生菜单
    // （window capture：必须早于 ComfyUI 自己的 contextmenu 监听，否则 stopImmediatePropagation 拦不住 → 双菜单）
    window.addEventListener("contextmenu", (e) => {
        if (rd.active) { e.preventDefault(); return; }
        if (!matchMenuTrigger(e)) return; // 普通右键 → 原生菜单
        if (Date.now() < rd.suppressCtxUntil) { rd.suppressCtxUntil = 0; return; }
        const emptyEl = e.target.closest ? e.target.closest("[data-cm-empty-cat]") : null;
        const rowEl = emptyEl ? null : e.target.closest?.(ROW_SEL);
        if (!emptyEl && !rowEl) return;
        e.preventDefault();
        e.stopImmediatePropagation(); // 阻止原生菜单同时弹出（双菜单）
        openManageMenu(e, rowEl, emptyEl);
    }, true);

    // 原生 HTML5 拖拽启动（如把叶子节点拖到画布添加）时，插件拖拽让位
    document.addEventListener("dragstart", (e) => {
        if (rd.pending || rd.active) rdCleanup();
    }, true);

    // ---- hover 提示（辅助确认目标） ----
    document.addEventListener("mouseover", (e) => {
        const rowEl = e.target.closest?.(ROW_SEL);
        if (!rowEl || rowEl.__cm_titled) return;
        rowEl.__cm_titled = true;
        const rows = visibleRowsWithPaths();
        const row = rows.find((r) => r.el === rowEl);
        if (!row) return;
        if (row.isFolder) {
            const candidates = categoryCandidates(row.localPath, row.level);
            const valid = candidates.includes(row.localPath) ||
                candidates.some((k) => k.startsWith(row.localPath + "/"));
            if (valid) {
                rowEl.title = tr("{path}\nShortcuts: {drag}: drag to move/sort, {menu}: open the manage menu", {
                    path: row.localPath,
                    drag: triggerLabel(),
                    menu: menuTriggerLabel(),
                });
            }
        } else {
            const entries = leafCandidates(row);
            if (entries.length) {
                rowEl.title = tr("{name} ({path})\nShortcuts: {drag}: drag to move/sort, {menu}: open the manage menu (drag onto the canvas to add the node)", {
                    name: entries[0].name,
                    path: entries[0].dispPath,
                    drag: triggerLabel(),
                    menu: menuTriggerLabel(),
                });
            }
        }
    });

    // 空分类行保活（MutationObserver 毫秒级重插 + 轮询兜底）
    setInterval(renderEmptyRows, 800);

    console.log(`[${CM_NAMESPACE}] 节点树交互已注入（右键管理分类 / Alt+右键拖拽移动，规则实时生效）`);
}

// ============================================================
// 扩展注册
// ============================================================

/**
 * 翻译字典晚到时的校准（规则已按未翻译状态应用过一次）：
 * - 若上次应用未改动任何节点（规则未命中，store 未被污染）→ 以当前 store 状态重建基准
 * - 用分类字典把基准映射为显示路径（幂等：中文段不在字典键中，映射后不变）→ 规则得以命中
 * 随后重新应用一次，规则/隐藏/排序按显示路径生效。
 */
function calibrateWithDict() {
    // 基准路径来自节点数据（与界面语言无关），字典晚到只需按字典重算显示路径
    reapply();
    applyOrderRules();
    CM.perf.calibratedAt = performance.now();
}

/**
 * 等待 store 就绪并分三段启用，避免右键菜单/拖拽被翻译同步拖慢：
 * - 阶段一（store 就绪）：注册隐藏过滤器 + 建索引 + 装交互 → 右键菜单立即可用
 * - 阶段二（同一时刻）：立即应用规则；翻译未启用时这就是最终结果
 * - 阶段三（字典就绪，可能晚于阶段二）：校准基准（按分类字典映射为显示路径）并重新应用
 */
function waitAndFirstApply() {
    let tries = 0;
    let interactionInstalled = false;
    let applied = false;
    let calibrated = false;

    const timer = setInterval(() => {
        tries++;
        const store = getNodeDefStore();
        if (!store || !Array.isArray(store.nodeDefs) || !store.nodeDefs.length) {
            if (tries > 200) clearInterval(timer); // 10 秒后放弃
            return;
        }

        // ---- 阶段一：交互立即就绪 ----
        if (!interactionInstalled) {
            interactionInstalled = true;
            CM.perf.storeReadyAt = performance.now();
            try {
                refreshHiddenFilter(store);
                rebuildIndex(store);
                setupTreeInteraction();
            } catch (e) {
                console.error(`[${CM_NAMESPACE}] 初始化树交互失败：`, e);
            }
            CM.perf.interactionAt = performance.now();
            // 异步拉取后端原始分类作为权威基准（前端 category 可能已被 i18n 部分翻译）
            fetchRawCategories();
        }

        // ---- 阶段二：立即应用规则（不等翻译字典）----
        if (!applied) {
            applied = true;
            CM.perf.dictReadyAt = performance.now();
            try {
                if (reapply()) {
                    applyOrderRules();
                    CM.perf.appliedAt = performance.now();
                    const p = CM.perf;
                    console.log(
                        `[${CM_NAMESPACE}] 规则已应用（交互 ${Math.round(p.interactionAt - p.startedAt)}ms / 规则 ${Math.round(p.appliedAt - p.startedAt)}ms，实时生效）`
                    );
                }
            } catch (e) {
                console.error(`[${CM_NAMESPACE}] 首次应用规则失败：`, e);
            }
            // 翻译未启用 → 无需校准
            if (!isTranslationEnabled()) calibrated = true;
        }

        // ---- 阶段三：字典就绪后校准（基准按显示路径重算；幂等，可安全重复执行）----
        if (!calibrated && window.__UiTranslated) {
            calibrated = true;
            try {
                calibrateWithDict();
            } catch (e) {
                console.error(`[${CM_NAMESPACE}] 字典校准失败：`, e);
            }
        }
        if (calibrated || tries > 200) clearInterval(timer);
    }, 50);
}

function registerWhenReady(tries = 0) {
    const comfyApp = window.comfyAPI?.app?.app || window.app;
    if (!comfyApp || typeof comfyApp.registerExtension !== "function") {
        if (tries >= 1000) {
            console.error(`[${CM_NAMESPACE}] app.registerExtension 不可用，分类管理未启用`);
            return;
        }
        setTimeout(() => registerWhenReady(tries + 1), 10);
        return;
    }

    comfyApp.registerExtension({
        name: CM_NAMESPACE,

        // init：加载已保存的规则
        async init() {
            try {
                const resp = await fetch("./uiiiaiii/category-overrides");
                if (resp.ok) {
                    const data = await resp.json();
                    CM.rules = {
                        category_rename: data.category_rename || {},
                        hidden_categories: data.hidden_categories || [],
                        node_move: data.node_move || {},
                        empty_categories: data.empty_categories || [],
                        hidden_nodes: data.hidden_nodes || [],
                        order_rules: Array.isArray(data.order_rules) ? data.order_rules : [],
                        drag_trigger: data.drag_trigger || (data.drag_modifier ? { mouse: "right", modifier: data.drag_modifier } : { mouse: "right", modifier: "alt" }),
                    };
                    const n = Object.keys(CM.rules.category_rename).length +
                        CM.rules.hidden_categories.length + Object.keys(CM.rules.node_move).length +
                        CM.rules.empty_categories.length + CM.rules.hidden_nodes.length +
                        CM.rules.order_rules.length;
                    if (n > 0) console.log(`[${CM_NAMESPACE}] 已加载分类规则 ${n} 条`);
                }
            } catch (e) {
                console.warn(`[${CM_NAMESPACE}] 加载分类规则失败：`, e);
            }
        },

        // 规则应用改为 store 热更新（waitAndFirstApply），此处不做改写
        async setup() {
            window.__CM__ = CM; // 调试句柄
            waitAndFirstApply();
        },
    });

    console.log(`[${CM_NAMESPACE}] 扩展注册完成`);
}

registerWhenReady();