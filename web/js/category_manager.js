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
 *     "empty_categories": ["显示路径", ...]   // 自建空分类
 *   }
 */

const CM_NAMESPACE = "UIIIAIII Toolkit-CategoryManager";

const CM = {
    rules: { category_rename: {}, hidden_categories: [], node_move: {}, empty_categories: [] },
    baseCategory: new Map(),   // comfyClass -> 基准 category（默认显示路径）
    catIndex: new Map(),       // 显示路径 -> 显示路径（树右键反查用）
    nodeIndex: new Map(),      // 叶子显示文本 -> [{ name, dispPath }]
    classIndex: new Map(),     // comfyClass -> [{ name, dispPath }]
    emptySet: new Set(),       // 自建空分类（尚未放入任何内容，显示在树面板顶部区块）
    ready: false,              // 首次 reapply 完成
};

const FILTER_ID = "uiiiaiii.hiddenCategories";

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
 * 计算节点的最终 category（基准显示路径 + 规则）
 * 优先级：单节点移动（类名键） > 分类重命名（完整路径） > 父文件夹重命名（前缀） > 基准
 */
function applyRulesTo(name, base) {
    const move = CM.rules.node_move || {};
    if (move[name]) return move[name];

    const rename = CM.rules.category_rename || {};
    if (rename[base]) return rename[base];
    for (const [k, v] of Object.entries(rename)) {
        if (k && base.startsWith(k + "/")) return v + base.slice(k.length);
    }
    return base;
}

/** 分类（显示路径）是否被隐藏：精确命中或位于被隐藏文件夹内 */
function isHiddenDispPath(dispPath) {
    const hidden = CM.rules.hidden_categories || [];
    if (!dispPath) return false;
    if (hidden.includes(dispPath)) return true;
    return hidden.some((h) => h && dispPath.startsWith(h + "/"));
}

// ============================================================
// 索引构建（从 store 读，供树交互反查）
// ============================================================

function rebuildIndex(store) {
    CM.catIndex.clear();
    CM.nodeIndex.clear();
    CM.classIndex.clear();
    for (const nd of store.nodeDefs) {
        if (!nd || !nd.name) continue;
        const dispPath = String(nd.category || "");
        if (!dispPath) continue;

        CM.catIndex.set(dispPath, dispPath);

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
            description: "按「节点分类管理」规则隐藏分类",
            predicate: (nodeDef) => !isHiddenDispPath(String(nodeDef?.category || "")),
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

    // 首次：记录基准（此时 category 是干净的默认显示路径）
    if (!CM.ready) {
        for (const nd of store.nodeDefs) {
            if (nd && nd.name && !CM.baseCategory.has(nd.name)) {
                CM.baseCategory.set(nd.name, String(nd.category || ""));
            }
        }
        CM.ready = true;
    }

    // 从基准 + 规则重算每个节点的 category（赋值触发 nodeTree 响应式重算）
    for (const nd of store.nodeDefs) {
        if (!nd || !nd.name) continue;
        const base = CM.baseCategory.get(nd.name);
        if (base === undefined) continue;
        const final = applyRulesTo(nd.name, base);
        if (nd.category !== final) nd.category = final;
    }

    refreshHiddenFilter(store);
    rebuildIndex(store);
    return true;
}

/** 保存规则到后端（保存后热更新，不再需要刷新） */
async function saveRules() {
    try {
        reapply();
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
        showToast("分类规则已应用");
    } catch (e) {
        console.error(`[${CM_NAMESPACE}] 保存分类规则失败：`, e);
        showToast("保存分类规则失败：" + e.message, true);
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
    const list = [...CM.emptySet].filter((p) => !isHiddenDispPath(p)).sort();
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
            row.title = `自定义分类：${p}（空）\n右键管理；拖拽节点或分类到此处放入`;
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

function showMenu(x, y, items) {
    closeMenu();
    cmMenuEl = document.createElement("div");
    cmMenuEl.style.cssText =
        "position:fixed;z-index:100000;min-width:180px;background:#2a2a2a;border:1px solid #444;" +
        "border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.5);padding:4px;font-size:13px;color:#ddd;";
    for (const it of items) {
        if (!it) continue;
        const b = document.createElement("div");
        if (it.header) {
            b.textContent = it.header;
            b.style.cssText = "padding:4px 12px;color:#888;font-size:11px;border-bottom:1px solid #3a3a3a;margin-bottom:2px;white-space:nowrap;";
        } else if (it.sep) {
            b.style.cssText = "height:1px;background:#3a3a3a;margin:4px 6px;";
        } else {
            b.textContent = it.label;
            b.style.cssText =
                "padding:6px 12px;border-radius:4px;cursor:pointer;white-space:nowrap;" +
                (it.danger ? "color:#e05555;" : "");
            b.addEventListener("mouseenter", () => (b.style.background = "#3a3a3a"));
            b.addEventListener("mouseleave", () => (b.style.background = ""));
            b.addEventListener("click", () => { closeMenu(); it.onclick(); });
        }
        cmMenuEl.appendChild(b);
    }
    document.body.appendChild(cmMenuEl);
    const rect = cmMenuEl.getBoundingClientRect();
    cmMenuEl.style.left = Math.min(x, window.innerWidth - rect.width - 8) + "px";
    cmMenuEl.style.top = Math.min(y, window.innerHeight - rect.height - 8) + "px";
    setTimeout(() => {
        window.addEventListener("click", closeMenu, { once: true });
        window.addEventListener("contextmenu", closeMenu, { once: true, capture: true });
    }, 0);
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
        `<button id="cm-input-cancel" style="padding:5px 14px;background:#444;color:#ddd;border:none;border-radius:4px;cursor:pointer;">取消</button>` +
        `<button id="cm-input-ok" style="padding:5px 14px;background:#4a9eff;color:#fff;border:none;border-radius:4px;cursor:pointer;">${opt.confirmText || "确定"}</button></div>`;
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
        `<button id="cm-confirm-cancel" style="padding:5px 14px;background:#444;color:#ddd;border:none;border-radius:4px;cursor:pointer;">取消</button>` +
        `<button id="cm-confirm-ok" style="padding:5px 14px;background:${opt.danger ? "#c04a4a" : "#4a9eff"};color:#fff;border:none;border-radius:4px;cursor:pointer;">${opt.confirmText || "确定"}</button></div>`;
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
        `<div style="margin-bottom:8px;color:#aaa;">源分类：${opt.sourcePath}</div>` +
        `<div style="margin-bottom:6px;">目标分类：<input id="cm-batch-target" list="cm-batch-cats" value="${opt.targetDefault || ""}"` +
        ` style="width:60%;box-sizing:border-box;padding:5px 8px;border:1px solid #555;border-radius:4px;background:#1e1e1e;color:#ddd;outline:none;" /></div>` +
        `<datalist id="cm-batch-cats"></datalist>` +
        `<div style="margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;">` +
        `<span>要移动的节点：</span>` +
        `<label style="color:#4a9eff;cursor:pointer;font-size:12px;"><input type="checkbox" id="cm-batch-all" checked /> 全选</label></div>` +
        `<div id="cm-batch-list" style="flex:1;min-height:120px;max-height:260px;overflow-y:auto;border:1px solid #444;border-radius:4px;padding:4px;margin-bottom:10px;"></div>` +
        `<div style="display:flex;justify-content:flex-end;gap:8px;">` +
        `<button id="cm-batch-cancel" style="padding:5px 14px;background:#444;color:#ddd;border:none;border-radius:4px;cursor:pointer;">取消</button>` +
        `<button id="cm-batch-ok" style="padding:5px 14px;background:#4a9eff;color:#fff;border:none;border-radius:4px;cursor:pointer;">${opt.confirmText || "确定"}</button></div>`;
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
        if (!target) { alert("请填写目标分类"); return; }
        const names = boxes.filter((b) => b.checked).map((b) => b.dataset.name);
        if (!names.length) { alert("未选择任何节点"); return; }
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
    if (CM.rules.empty_categories.includes(p)) { showToast("该空分类已存在"); return; }
    if (CM.catIndex.has(p) && !CM.emptySet.has(p)) { showToast("分类已存在（含节点）"); return; }
    CM.rules.empty_categories.push(p);
    CM.emptySet.add(p);
    CM.catIndex.set(p, p);
    saveRules();
}

/** 新建子分类（空分类：先创建，之后拖拽节点/分类放入） */
function actionNewSubCategory(key) {
    showInputDialog({
        title: "新建子分类",
        desc: `父分类：${key}（可输入多级路径，如 视频/合成）`,
        placeholder: "子分类名称",
        confirmText: "创建",
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
        title: "新建主分类",
        desc: "在顶层新建一个空分类（支持多级路径，如 素材/高清）",
        placeholder: "主分类名称",
        confirmText: "创建",
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
        title: "重命名分类",
        desc: `当前：${path}（空分类，其下子分类会跟随移动）`,
        defaultValue: path,
        confirmText: "重命名",
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
        title: "重命名分类",
        desc: `当前：${key}（其下子分类会跟随移动）`,
        defaultValue: key,
        confirmText: "重命名",
        onConfirm: (np) => {
            if (np && np !== key) {
                CM.rules.category_rename[key] = np;
                saveRules();
            }
        },
    });
}

/** 删除分类：节点批量移到目标分类后，分类自然消失 */
function actionDeleteCategory(key) {
    const nodes = nodesUnderPath(key);
    if (!nodes.length) { alert("该分类下没有节点"); return; }
    const parent = key.split("/").slice(0, -1).join("/");
    showBatchMoveDialog({
        title: `删除分类「${key}」`,
        sourcePath: key,
        nodes,
        targetDefault: parent,
        confirmText: "移动并删除",
        onConfirm: (names, target) => {
            for (const n of names) CM.rules.node_move[n] = target;
            delete CM.rules.category_rename[key];
            saveRules();
        },
    });
}

/** 隐藏分类 */
function actionHideCategory(key) {
    if (!CM.rules.hidden_categories.includes(key)) CM.rules.hidden_categories.push(key);
    saveRules();
}

/** 恢复此分类为默认（清除该分类及其后代的所有自定义规则） */
function actionRestoreCategory(key) {
    let n = 0;
    // 键或值命中该分类（值命中 = 该分类是改名的目标，如 "视频" -> "文本/视频"）
    for (const k of Object.keys(CM.rules.category_rename)) {
        const v = CM.rules.category_rename[k];
        if (k === key || k.startsWith(key + "/") || v === key || v.startsWith(key + "/")) {
            delete CM.rules.category_rename[k];
            n++;
        }
    }
    for (const [name, target] of Object.entries(CM.rules.node_move)) {
        if (target === key || target.startsWith(key + "/")) { delete CM.rules.node_move[name]; n++; }
    }
    const hiddenBefore = CM.rules.hidden_categories.length;
    CM.rules.hidden_categories = CM.rules.hidden_categories.filter((h) => h !== key && !h.startsWith(key + "/"));
    n += hiddenBefore - CM.rules.hidden_categories.length;
    if (!n) { showToast("该分类已是默认状态"); return; }
    saveRules();
}

/** 恢复此节点为默认分类（移除该节点的移动规则） */
function actionRestoreNode(name) {
    if (!CM.rules.node_move[name]) { showToast("该节点已是默认分类"); return; }
    delete CM.rules.node_move[name];
    saveRules();
}

/** 恢复所有分类：清空全部规则 */
function actionRestoreAll() {
    const nRename = Object.keys(CM.rules.category_rename).length;
    const nHidden = CM.rules.hidden_categories.length;
    const nMove = Object.keys(CM.rules.node_move).length;
    if (nRename + nHidden + nMove === 0) { showToast("当前没有分类管理规则"); return; }
    showConfirmDialog({
        title: "恢复所有分类",
        desc: `将清除全部规则，所有分类回到默认状态：\n重命名 ${nRename} 条 / 隐藏 ${nHidden} 条 / 移动 ${nMove} 条`,
        confirmText: "恢复所有",
        danger: true,
        onConfirm: () => {
            CM.rules = { category_rename: {}, hidden_categories: [], node_move: {} };
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

    // ---- Alt + 右键拖拽（HTML5 DnD 不支持右键启动，用自定义指针拖拽） ----
    const rd = { pending: false, active: false, startX: 0, startY: 0, x: 0, y: 0, name: null, folderPath: null, label: null, ghost: null, targetRow: null, suppressCtxUntil: 0 };

    function rdCleanup() {
        if (rd.targetRow) { rd.targetRow.el.style.outline = ""; }
        if (rd.ghost) { rd.ghost.remove(); rd.ghost = null; }
        rd.active = false; rd.pending = false;
        rd.name = null; rd.folderPath = null; rd.label = null;
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

    /** 指针位置下的可放置目标分类行（含自建空分类） */
    function rdTargetAt(x, y) {
        const el = document.elementFromPoint(x, y);
        let target = null;
        const emptyEl = el && el.closest ? el.closest("[data-cm-empty-cat]") : null;
        if (emptyEl) {
            // 自建空分类行（面板顶部区块）
            target = { el: emptyEl, localPath: emptyEl.dataset.cmEmptyCat, isFolder: true };
        } else {
            const rowEl = el && el.closest ? el.closest(ROW_SEL) : null;
            if (!rowEl) return null;
            const rows = visibleRowsWithPaths();
            const row = rows.find((r) => r.el === rowEl);
            if (!row || !row.isFolder || !droppableFolder(row)) return null;
            target = row;
        }
        // 防止把分类拖进自己或自己的子分类
        if (rd.folderPath) {
            const t = target.localPath;
            if (t === rd.folderPath || t.startsWith(rd.folderPath + "/")) return null;
        }
        return target;
    }

    // 右键按下：记录待拖对象（叶子用显示名反查类名；分类取完整路径）
    document.addEventListener("mousedown", (e) => {
        if (e.button !== 2 || !e.altKey) return;
        const rowEl = e.target.closest?.(ROW_SEL);
        if (!rowEl) return;
        const rows = visibleRowsWithPaths();
        const row = rows.find((r) => r.el === rowEl);
        if (!row) return;
        if (row.isFolder) {
            if (row.localPath.includes("?")) return; // 路径被虚拟滚动截断，无法安全移动
            rd.folderPath = row.localPath;
            rd.name = null;
        } else {
            const entries = leafCandidates(row);
            rd.name = entries.length ? entries[0].name : null;
            if (!rd.name) return; // 无法识别：不启动拖拽
        }
        rd.label = row.label;
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
            rdGhost((rd.name ? "移动节点：" : "移动分类：") + rd.label);
        }
        const target = rdTargetAt(e.clientX, e.clientY);
        if (rd.targetRow && (!target || target.el !== rd.targetRow.el)) rd.targetRow.el.style.outline = "";
        rd.targetRow = target;
        if (target) {
            target.el.style.outline = "1px solid #4a9eff";
            rdGhost("松开移动到：" + target.localPath);
        } else {
            rdGhost((rd.name ? "移动节点：" : "移动分类：") + rd.label);
        }
    }, true);

    // 拖拽中/刚结束时阻止右键菜单（浏览器会在右键松开后补发 contextmenu）
    document.addEventListener("contextmenu", (e) => {
        if (rd.active || Date.now() < rd.suppressCtxUntil) {
            rd.suppressCtxUntil = 0;
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    // 右键松开：拖拽模式 → 执行移动；未拖动 → 交给右键菜单 handler
    document.addEventListener("mouseup", (e) => {
        if (!rd.pending || e.button !== 2) return;
        if (!rd.active) { rdCleanup(); return; }
        const target = rdTargetAt(e.clientX, e.clientY);
        if (target) {
            if (rd.folderPath) {
                // 分类整体拖到目标分类下（子树跟随）
                const src = rd.folderPath;
                const finalPath = target.localPath + "/" + src.split("/").pop();
                if (finalPath !== src) CM.rules.category_rename[src] = finalPath;
            } else if (rd.name) {
                CM.rules.node_move[rd.name] = target.localPath;
            }
            saveRules();
        }
        rdCleanup();
        rd.suppressCtxUntil = Date.now() + 400; // 吞掉紧随鼠标松开补发的 contextmenu
    }, true);

    // ---- 右键菜单（分类文件夹与自建空分类；叶子右键保留 ComfyUI 原生菜单） ----
    document.addEventListener("contextmenu", (e) => {
        if (rd.active) { e.preventDefault(); return; }
        // 自建空分类（面板顶部区块）
        const emptyEl = e.target.closest ? e.target.closest("[data-cm-empty-cat]") : null;
        if (emptyEl) {
            const key = emptyEl.dataset.cmEmptyCat;
            const items = [
                { header: "自定义分类：" + key },
                { label: "新建子分类...", onclick: () => actionNewSubCategory(key) },
                { label: "重命名分类...", onclick: () => actionRenameEmptyCat(key) },
                { label: "删除此分类", danger: true, onclick: () => actionDeleteEmptyCat(key) },
                { label: "隐藏此分类", danger: true, onclick: () => actionHideCategory(key) },
                { sep: true },
                { label: "恢复所有分类", onclick: actionRestoreAll },
            ];
            e.preventDefault();
            showMenu(e.clientX, e.clientY, items);
            return;
        }
        const rowEl = e.target.closest?.(ROW_SEL);
        if (!rowEl || !CM.catIndex.size) return;
        const rows = visibleRowsWithPaths();
        const row = rows.find((r) => r.el === rowEl);
        if (!row) return;
        if (!row.isFolder) {
            // 节点（叶子）：显示节点管理菜单
            const entries = leafCandidates(row);
            if (!entries.length) return; // 无法识别类名：交给原生菜单
            const ent = entries[0];
            const nodeItems = [
                { header: row.label },
                { header: `类名：${ent.name} ｜ 当前分类：${ent.dispPath}` },
                { label: "恢复此节点为默认分类", onclick: () => actionRestoreNode(ent.name) },
                { sep: true },
                { label: "恢复所有分类", onclick: actionRestoreAll },
            ];
            e.preventDefault();
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
            items.push({ label: "新建子分类...", onclick: () => actionNewSubCategory(key) });
            items.push({ label: "新建主分类...", onclick: () => actionNewTopCategory() });
            items.push({ label: "重命名分类...", onclick: () => actionRenameCategory(key) });
            items.push({ label: "删除此分类（节点移至...）", danger: true, onclick: () => actionDeleteCategory(key) });
            items.push({ label: "隐藏此分类", danger: true, onclick: () => actionHideCategory(key) });
            items.push({ label: "恢复此分类为默认", onclick: () => actionRestoreCategory(key) });
            items.push({ sep: true });
            items.push({ label: "恢复所有分类", onclick: actionRestoreAll });
        } else if (candidates.length > 1) {
            // 虚拟滚动导致路径不完整：列出候选让用户选择
            items.push({ header: "请选择要管理的分类" });
            for (const c of candidates) {
                items.push({
                    label: c,
                    onclick: () => {
                        const sub = [];
                        sub.push({ header: c });
                        sub.push({ label: "新建子分类...", onclick: () => actionNewSubCategory(c) });
                        sub.push({ label: "新建主分类...", onclick: () => actionNewTopCategory() });
                        sub.push({ label: "重命名分类...", onclick: () => actionRenameCategory(c) });
                        sub.push({ label: "删除此分类（节点移至...）", danger: true, onclick: () => actionDeleteCategory(c) });
                        sub.push({ label: "隐藏此分类", danger: true, onclick: () => actionHideCategory(c) });
                        sub.push({ label: "恢复此分类为默认", onclick: () => actionRestoreCategory(c) });
                        sub.push({ sep: true });
                        sub.push({ label: "恢复所有分类", onclick: actionRestoreAll });
                        showMenu(e.clientX, e.clientY, sub);
                    },
                });
            }
        } else {
            return; // 无法确定目标，保留原生行为
        }

        e.preventDefault();
        showMenu(e.clientX, e.clientY, items);
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
            if (valid) rowEl.title = row.localPath + "（右键管理；Alt+右键拖拽可整体移动）";
        } else {
            const entries = leafCandidates(row);
            if (entries.length) rowEl.title = `${entries[0].name}（${entries[0].dispPath}）｜Alt+右键拖拽即可移动`;
        }
    });

    // 空分类行保活（MutationObserver 毫秒级重插 + 轮询兜底）
    setInterval(renderEmptyRows, 800);

    console.log(`[${CM_NAMESPACE}] 节点树交互已注入（右键管理分类 / Alt+右键拖拽移动，规则实时生效）`);
}

// ============================================================
// 扩展注册
// ============================================================

/** 等待 store 就绪且（翻译就绪 或 超时），然后首次应用规则 */
function waitAndFirstApply() {
    let tries = 0;
    const timer = setInterval(() => {
        tries++;
        const store = getNodeDefStore();
        if (!store || !Array.isArray(store.nodeDefs) || !store.nodeDefs.length) {
            if (tries > 100) clearInterval(timer); // 10 秒后放弃
            return;
        }
        // 翻译就绪（window.__UiTranslated 由翻译扩展填充）或已等待 10 秒
        const translated = !!window.__UiTranslated?.Nodes && Object.keys(window.__UiTranslated.Nodes).length > 0;
        if (!translated && tries < 100) return;

        clearInterval(timer);
        try {
            if (reapply()) {
                setupTreeInteraction();
                console.log(`[${CM_NAMESPACE}] 规则已应用（实时生效，无需刷新）`);
            }
        } catch (e) {
            console.error(`[${CM_NAMESPACE}] 首次应用规则失败：`, e);
        }
    }, 100);
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
                    };
                    const n = Object.keys(CM.rules.category_rename).length +
                        CM.rules.hidden_categories.length + Object.keys(CM.rules.node_move).length +
                        CM.rules.empty_categories.length;
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