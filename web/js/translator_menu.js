/**
 * 翻译功能 UI 入口
 *
 * 提供两处入口：
 * 1. 画布右键菜单：翻译选中节点（通过 getNodeMenuItems 钩子，节点右键时出现）
 *    以及画布空白右键菜单（通过 getCanvasMenuItems 钩子，有选中节点时出现）
 * 2. 主菜单按钮：翻译整个插件（通过 app.menu.settingsGroup 注入，兼容新版菜单）
 *
 * 后端 API：
 * - GET  /agnes-translate/status         获取配置状态
 * - GET  /agnes-translate/list-plugins    列出所有插件目录
 * - POST /agnes-translate/extract-selected  提取选中节点定义
 * - POST /agnes-translate/extract-plugin    提取整个插件节点定义
 * - POST /agnes-translate/translate         执行翻译并写入文件
 *
 * 参考实现：
 * - UIIIAIII Toolkit/web/js/SettingsPanel.js（ComfyButton + app.menu.settingsGroup 注入方式）
 * - https://docs.comfy.org/custom-nodes/js/context-menu-migration（新 context menu API）
 */

const TRANSLATOR_NAMESPACE = "UIIIAIII Toolkit-Translator";

// 后端端点
const ENDPOINT_STATUS = "/agnes-translate/status";
const ENDPOINT_LIST_PLUGINS = "/agnes-translate/list-plugins";
const ENDPOINT_EXTRACT_SELECTED = "/agnes-translate/extract-selected";
const ENDPOINT_EXTRACT_PLUGIN = "/agnes-translate/extract-plugin";
const ENDPOINT_TRANSLATE = "/agnes-translate/translate";

/**
 * 按翻译字典翻译动态文本（模板法）。
 * 字典键为含 {name} 占位符的完整模板字符串，命中后用 params 替换占位符；
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

// ─── 顶栏按钮组合协调器（与 SettingsPanel.js 共享，代码必须保持一致）───
// 参考 rgthree 的做法：用官方 ComfyButtonGroup 实例作为唯一容器。
// 谁先到谁创建组，后者通过官方 append()/insert() 加入；menu 未就绪时轮询挂载。
window.__UIIIAIII_TOPBAR__ = window.__UIIIAIII_TOPBAR__ || (() => {
    const st = { group: null, mountTimer: null };

    function ensureMounted() {
        const app = window.comfyAPI?.app?.app || window.app;
        const anchor = app?.menu?.settingsGroup?.element;
        if (!anchor) return false;
        if (st.group && !anchor.parentElement.contains(st.group.element)) {
            anchor.before(st.group.element);
            console.log("[UIIIAIII Toolkit] 顶栏按钮组已挂载（", st.group.element.children.length, "个按钮）");
        }
        return true;
    }

    return {
        add(el, toFront) {
            try {
                const ComfyButtonGroup = window.comfyAPI?.buttonGroup?.ComfyButtonGroup;
                if (!el || !ComfyButtonGroup) return;
                if (!st.group) {
                    st.group = new ComfyButtonGroup(el);
                    console.log("[UIIIAIII Toolkit] 创建共享按钮组");
                } else if (toFront) {
                    st.group.insert(el, 0);
                } else {
                    st.group.append(el);
                }
                if (!ensureMounted()) {
                    if (!st.mountTimer) {
                        let tries = 0;
                        st.mountTimer = setInterval(() => {
                            if (ensureMounted() || ++tries > 300) {
                                clearInterval(st.mountTimer);
                                st.mountTimer = null;
                            }
                        }, 100);
                    }
                }
            } catch (e) {
                console.error("[UIIIAIII Toolkit] 顶栏按钮组挂载失败:", e);
            }
        },
    };
})();

/**
 * 等待 ComfyUI app 就绪并注册扩展
 */
function registerTranslatorExtensionWhenReady(tries = 0) {
    const comfyApp = window.comfyAPI?.app?.app || window.app;
    const comfyApi = window.comfyAPI?.api?.api || window.api || null;

    if (!comfyApp || typeof comfyApp.registerExtension !== "function" || !comfyApi) {
        if (tries >= 1000) {
            console.error(`[${TRANSLATOR_NAMESPACE}] app.registerExtension 不可用，无法注册翻译功能`);
            return;
        }
        setTimeout(() => registerTranslatorExtensionWhenReady(tries + 1), 10);
        return;
    }

    const app = comfyApp;
    const api = comfyApi;

    // ============================================================
    // 工具函数
    // ============================================================

    /**
     * 显示提示消息（使用 ComfyUI 原生 toast，退化方案用自定义 div）
     */
    function showToast(message, type = "info") {
        try {
            if (app?.ui?.notifications?.show) {
                // ComfyUI notifications 的 severity: info/success/warning/error
                const severity = type === "error" ? "error" : (type === "warn" ? "warning" : (type === "success" ? "success" : "info"));
                app.ui.notifications.show(message, { severity, timeout: 6000 });
                return;
            }
        } catch {}
        // 退化方案：自定义浮层
        console.log(`[${TRANSLATOR_NAMESPACE}] ${type}: ${message}`);
        try {
            const div = document.createElement("div");
            div.textContent = message;
            const bg = type === "error" ? "#c33" : (type === "success" ? "#3a7" : (type === "warn" ? "#c93" : "#333"));
            div.style.cssText = `position:fixed;top:60px;right:20px;background:${bg};color:#fff;padding:10px 16px;border-radius:4px;z-index:99999;font-size:13px;max-width:480px;box-shadow:0 2px 8px rgba(0,0,0,0.3);`;
            document.body.appendChild(div);
            setTimeout(() => div.remove(), 6000);
        } catch {}
    }

    /**
     * 翻译完成后自动刷新前端
     *
     * ComfyUI 会自动保存当前工作流，刷新页面后：
     * - UIIIAIII Toolkit 从本插件 locales 目录重新读取翻译 JSON
     * - 所有节点重建，翻译自然应用
     *
     * 这是唯一可靠的方式，因为主插件前端（main.js）的 applyNodeTranslation
     * 有跳过已翻译节点的逻辑，无法在不重建节点的情况下覆盖旧翻译。
     */
    function refreshTranslation() {
        // 延迟 500ms 刷新，让用户看到翻译成功的提示
        setTimeout(() => {
            window.location.reload();
        }, 500);
        return true;
    }

    /**
     * 构建翻译完成的 toast 消息（模板翻译）
     * @param {object} result - /agnes-translate/translate 的返回结果
     * @param {object} notes - 附加说明（notLoadedNote / menuNote，已翻译）
     * @returns {string}
     */
    function formatDoneMessage(result, { notLoadedNote = "", menuNote = "" } = {}) {
        const inputCount = result.input_count ?? result.translated_count;
        const translatedCount = result.translated_count ?? 0;
        const missingCount = result.missing_count ?? 0;
        const mergedCount = result.merged_count ?? translatedCount;
        const missing = missingCount > 0
            ? tr("{n} nodes not returned by the API, filled with original text", { n: missingCount })
            : "";
        const dictNote = (result.dict_hits ?? 0) > 0
            ? tr("{n} terms reused from dictionary", { n: result.dict_hits })
            : "";
        const mode = tr(result.mode === "auto" ? "auto" : "manual");
        return tr(
            "Translation done: {t}/{i} nodes{missing}{notLoaded}{menu}{dict}. Merged file has {merged} nodes ({mode} mode).",
            { t: translatedCount, i: inputCount, missing, notLoaded: notLoadedNote, menu: menuNote, dict: dictNote, merged: mergedCount, mode }
        );
    }

    /**
     * 检查翻译 API 是否已配置
     * @returns {Promise<{configured: boolean, message?: string}>}
     */
    async function checkTranslatorConfigured() {
        try {
            const resp = await api.fetchApi(ENDPOINT_STATUS, { method: "GET" });
            if (!resp.ok) {
                return { configured: false, message: tr("Failed to get translation config status") };
            }
            const data = await resp.json();
            if (!data.translator_configured) {
                return {
                    configured: false,
                    message: tr("Translation API is not configured. Please fill in Base URL, API Key and Model in ComfyUI Settings → UIIIAIII Toolkit → Translation API."),
                };
            }
            return { configured: true };
        } catch (e) {
            return { configured: false, message: tr("Failed to check translation config: {msg}", { msg: e }) };
        }
    }

    // ============================================================
    // 对话框：插件选择
    // ============================================================

    /**
     * 弹出插件选择对话框
     * @returns {Promise<string|null>} 选中的插件名，取消则返回 null
     */
    function showPluginSelector(plugins) {
        return new Promise((resolve) => {
            const overlay = document.createElement("div");
            overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100000;display:flex;align-items:center;justify-content:center;";

            const dialog = document.createElement("div");
            dialog.style.cssText = "background:#2a2a2a;color:#eee;border-radius:8px;padding:20px;min-width:500px;max-width:700px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.5);";

            const title = document.createElement("h3");
            title.textContent = "Select a Plugin to Translate";
            title.style.cssText = "margin:0 0 12px 0;font-size:16px;";
            dialog.appendChild(title);

            const desc = document.createElement("p");
            desc.textContent = tr("Found {n} plugins. Selecting one extracts all its nodes and calls the API to translate them.", { n: plugins.length });
            desc.style.cssText = "margin:0 0 12px 0;font-size:13px;color:#aaa;";
            dialog.appendChild(desc);

            const list = document.createElement("div");
            list.style.cssText = "overflow-y:auto;flex:1;margin-bottom:12px;border:1px solid #444;border-radius:4px;";
            plugins.forEach((plugin) => {
                const item = document.createElement("div");
                item.style.cssText = "padding:10px 12px;cursor:pointer;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;";
                item.onmouseenter = () => { item.style.background = "#3a3a3a"; };
                item.onmouseleave = () => { item.style.background = ""; };
                const nameSpan = document.createElement("span");
                nameSpan.textContent = plugin.name;
                nameSpan.style.cssText = "font-weight:500;";
                const countSpan = document.createElement("span");
                countSpan.textContent = tr("{n} nodes", { n: plugin.node_count ?? 0 });
                countSpan.style.cssText = "color:#888;font-size:12px;";
                item.appendChild(nameSpan);
                item.appendChild(countSpan);
                item.onclick = () => {
                    overlay.remove();
                    resolve(plugin.name);
                };
                list.appendChild(item);
            });
            dialog.appendChild(list);

            const btnRow = document.createElement("div");
            btnRow.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
            const cancelBtn = document.createElement("button");
            cancelBtn.textContent = "Cancel";
            cancelBtn.style.cssText = "padding:6px 16px;background:#444;color:#eee;border:none;border-radius:4px;cursor:pointer;";
            cancelBtn.onclick = () => {
                overlay.remove();
                resolve(null);
            };
            btnRow.appendChild(cancelBtn);
            dialog.appendChild(btnRow);

            overlay.appendChild(dialog);
            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    overlay.remove();
                    resolve(null);
                }
            };
            document.body.appendChild(overlay);
        });
    }

    /**
     * 显示翻译进度对话框
     * @returns {{update: Function, close: Function}}
     */
    function showProgressDialog() {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100001;display:flex;align-items:center;justify-content:center;";

        const dialog = document.createElement("div");
        dialog.style.cssText = "background:#2a2a2a;color:#eee;border-radius:8px;padding:24px;min-width:400px;max-width:500px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.5);";

        const spinner = document.createElement("div");
        spinner.style.cssText = "border:3px solid #444;border-top:3px solid #4a9;width:36px;height:36px;border-radius:50%;animation:translator-spin 1s linear infinite;margin:0 auto 16px;";
        const style = document.createElement("style");
        style.textContent = "@keyframes translator-spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}";
        document.head.appendChild(style);
        dialog.appendChild(spinner);

        const status = document.createElement("div");
        status.textContent = "Preparing...";
        status.style.cssText = "font-size:14px;min-height:40px;line-height:1.5;";
        dialog.appendChild(status);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        return {
            update(text) {
                status.textContent = text;
            },
            close() {
                overlay.remove();
                style.remove();
            },
        };
    }

    // ============================================================
    // 获取选中节点类名（兼容新旧 API）
    // ============================================================

    /**
     * 从画布获取选中节点的 comfyClass 列表
     * 新版 ComfyUI 用 canvas.selectedItems（Set），旧版用 canvas.selected_nodes（Object）
     * 过滤掉分组/Frame/Reroute 等非节点元素，并对类名去重
     * @returns {string[]}
     */
    function getSelectedNodeClassNames() {
        const canvas = app.canvas;
        if (!canvas) return [];

        const classNames = [];
        const seen = new Set(); // 去重集合

        // 判断是否为有效 ComfyUI 节点（排除分组、Frame、Reroute 等）
        function isValidNode(node) {
            if (!node) return false;
            // LGraphNode 实例有 isNode 方法或具有 comfyClass/type 属性
            // LGraphGroup 没有 comfyClass，type 为 "group" 等
            // Reroute 节点的 comfyClass 为 "Reroute"，但通常不在 NODE_CLASS_MAPPINGS 中
            const isGroup = node.constructor?.name === "LGraphGroup" || node.type === "group";
            if (isGroup) return false;
            // 必须有 comfyClass 或可用的 type
            const cls = node.comfyClass || node.constructor?.comfyClass;
            if (!cls) return false;
            // 排除已知的非节点类型
            const skipTypes = ["Reroute", "reroute", "note", "Note", "frame", "Frame", "group"];
            if (skipTypes.includes(cls) || skipTypes.includes(node.type)) return false;
            return true;
        }

        // 新版 API：canvas.selectedItems（Set<LGraphNode>）
        if (canvas.selectedItems && canvas.selectedItems instanceof Set) {
            canvas.selectedItems.forEach((node) => {
                if (!isValidNode(node)) return;
                const cls = node.comfyClass || node.constructor?.comfyClass;
                if (cls && !seen.has(cls)) {
                    seen.add(cls);
                    classNames.push(cls);
                }
            });
        }

        // 旧版 API：canvas.selected_nodes（Object<id, LGraphNode>）
        if (canvas.selected_nodes && typeof canvas.selected_nodes === "object") {
            for (const id in canvas.selected_nodes) {
                const node = canvas.selected_nodes[id];
                if (!isValidNode(node)) continue;
                const cls = node.comfyClass || node.constructor?.comfyClass;
                if (cls && !seen.has(cls)) {
                    seen.add(cls);
                    classNames.push(cls);
                }
            }
        }

        return classNames;
    }

    // ============================================================
    // 核心流程：翻译选中节点
    // ============================================================

    async function translateSelectedNodes() {
        const classNames = getSelectedNodeClassNames();

        if (classNames.length === 0) {
            showToast(tr("Failed to extract class names from the selected nodes (a non-node element may be selected)"), "warn");
            return;
        }

        // 检查翻译 API 配置
        const cfgCheck = await checkTranslatorConfigured();
        if (!cfgCheck.configured) {
            showToast(cfgCheck.message, "error");
            return;
        }

        const progress = showProgressDialog();
        progress.update(tr("Extracting {n} node definitions...", { n: classNames.length }));

        try {
            // 提取
            const extractResp = await api.fetchApi(ENDPOINT_EXTRACT_SELECTED, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ class_names: classNames }),
            });
            if (!extractResp.ok) {
                const err = await extractResp.json().catch(() => ({}));
                throw new Error(err.error || tr("Extract failed HTTP {code}", { code: extractResp.status }));
            }
            const extractData = await extractResp.json();

            if (extractData.node_count === 0) {
                progress.close();
                showToast(tr("No node definitions extracted (class names may not be in NODE_CLASS_MAPPINGS)"), "warn");
                return;
            }

            progress.update(tr("Extracted {n} nodes. Calling the translation API (this may take a while)...", { n: extractData.node_count }));

            // 翻译并写入
            const translateResp = await api.fetchApi(ENDPOINT_TRANSLATE, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    nodes: extractData.nodes,
                    categories: extractData.categories || {},
                    plugin_name: "selected_nodes",
                }),
            });
            if (!translateResp.ok) {
                const err = await translateResp.json().catch(() => ({}));
                throw new Error(err.error || tr("Translate failed HTTP {code}", { code: translateResp.status }));
            }
            const result = await translateResp.json();

            progress.close();

            if (result.status === "ok") {
                showToast(
                    formatDoneMessage(result),
                    (result.missing_count ?? 0) > 0 ? "warn" : "success"
                );
                // 自动刷新翻译显示
                if (result.mode === "auto") {
                    const refreshed = await refreshTranslation();
                    if (!refreshed) {
                        showToast(tr("Translation written. Toggle the translation switch or refresh the page to apply."), "info");
                    }
                }
            } else {
                showToast(tr("Translation failed: {msg}", { msg: result.message }), "error");
            }
        } catch (e) {
            progress.close();
            showToast(tr("Translation error: {msg}", { msg: e.message || e }), "error");
            console.error(`[${TRANSLATOR_NAMESPACE}] 翻译选中节点失败：`, e);
        }
    }

    // ============================================================
    // 核心流程：翻译整个插件
    // ============================================================

    async function translatePlugin() {
        // 检查配置
        const cfgCheck = await checkTranslatorConfigured();
        if (!cfgCheck.configured) {
            showToast(cfgCheck.message, "error");
            return;
        }

        const progress = showProgressDialog();
        progress.update(tr("Loading plugin list..."));

        try {
            // 获取插件列表
            const listResp = await api.fetchApi(ENDPOINT_LIST_PLUGINS, { method: "GET" });
            if (!listResp.ok) {
                throw new Error(tr("Loading plugin list failed HTTP {code}", { code: listResp.status }));
            }
            const listData = await listResp.json();
            const plugins = (listData.plugins || []).filter((p) => p.node_count > 0);

            if (plugins.length === 0) {
                progress.close();
                showToast(tr("No plugin folders with nodes found"), "warn");
                return;
            }

            progress.close();

            // 弹出选择对话框
            const selected = await showPluginSelector(plugins);
            if (!selected) {
                return;
            }

            const progress2 = showProgressDialog();
            progress2.update(tr("Extracting node definitions of {name}...", { name: selected }));

            // 提取
            const extractResp = await api.fetchApi(ENDPOINT_EXTRACT_PLUGIN, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ plugin_name: selected }),
            });
            if (!extractResp.ok) {
                const err = await extractResp.json().catch(() => ({}));
                throw new Error(err.error || tr("Extract failed HTTP {code}", { code: extractResp.status }));
            }
            const extractData = await extractResp.json();

            if (extractData.node_count === 0) {
                progress2.close();
                showToast(tr("No loaded nodes extracted from plugin {name}", { name: selected }), "warn");
                return;
            }

            progress2.update(
                extractData.menu_count > 0
                    ? tr("Extracted {n} nodes, {m} menu texts. Calling the translation API (this may take a while)...", { n: extractData.node_count, m: extractData.menu_count })
                    : tr("Extracted {n} nodes. Calling the translation API (this may take a while)...", { n: extractData.node_count })
            );

            // 翻译并写入（同时翻译节点、分类、菜单）
            const translateResp = await api.fetchApi(ENDPOINT_TRANSLATE, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    nodes: extractData.nodes,
                    categories: extractData.categories || {},
                    menus: extractData.menus || {},
                    plugin_name: selected,
                }),
            });
            if (!translateResp.ok) {
                const err = await translateResp.json().catch(() => ({}));
                throw new Error(err.error || tr("Translate failed HTTP {code}", { code: translateResp.status }));
            }
            const result = await translateResp.json();

            progress2.close();

            if (result.status === "ok") {
                const notLoadedNote = extractData.not_loaded?.length
                    ? tr("{n} nodes not loaded, skipped", { n: extractData.not_loaded.length })
                    : "";
                // 菜单翻译信息
                const menuInputCount = result.menu_input_count ?? 0;
                const menuTranslatedCount = result.menu_translated_count ?? 0;
                const menuNote = menuInputCount > 0
                    ? tr("menu {a}/{b}", { a: menuTranslatedCount, b: menuInputCount })
                    : "";
                showToast(
                    formatDoneMessage(result, { notLoadedNote, menuNote }),
                    (result.missing_count ?? 0) > 0 ? "warn" : "success"
                );
                // 自动刷新翻译显示
                if (result.mode === "auto") {
                    const refreshed = await refreshTranslation();
                    if (!refreshed) {
                        showToast(tr("Translation written. Toggle the translation switch or refresh the page to apply."), "info");
                    }
                }
            } else {
                showToast(tr("Translation failed: {msg}", { msg: result.message }), "error");
            }
        } catch (e) {
            try { progress.close(); } catch {}
            showToast(tr("Translation error: {msg}", { msg: e.message || e }), "error");
            console.error(`[${TRANSLATOR_NAMESPACE}] 翻译插件失败：`, e);
        }
    }

    // ============================================================
    // 主菜单按钮注入（新版 UI：app.menu.settingsGroup）
    // ============================================================

    /**
     * 在新版菜单栏添加 "翻译插件" 按钮
     * 参考：UIIIAIII Toolkit/web/js/SettingsPanel.js#addPanelButtons
     * 使用 window.comfyAPI.button.ComfyButton + ComfyButtonGroup
     */
    function addTopbarButton() {
        // 避免重复添加
        if (document.getElementById("comfyui-api-translator-topbtn")) return true;

        const ComfyButton = window.comfyAPI?.button?.ComfyButton;
        const ComfyButtonGroup = window.comfyAPI?.buttonGroup?.ComfyButtonGroup;

        // 新版 UI 可用：纯图标按钮（rgthree 式紧凑风格），说明放 tooltip
        if (ComfyButton && ComfyButtonGroup && app.menu?.settingsGroup?.element) {
            try {
                const btn = new ComfyButton({
                    action: async () => { await translatePlugin(); },
                    tooltip: tr("Extract all nodes of the plugin folder and translate them via the API"),
                    icon: "earth",
                    classList: "comfyui-button comfyui-api-translator-btn",
                });

                if (btn.element) {
                    btn.element.id = "comfyui-api-translator-topbtn";
                }

                // 交给共享协调器挂载：与翻译开关按钮（SettingsPanel.js）合并进同一胶囊
                window.__UIIIAIII_TOPBAR__.add(btn.element);
                console.log(`[${TRANSLATOR_NAMESPACE}] 主菜单按钮已注册（共享按钮组）`);
                return true;
            } catch (e) {
                console.error(`[${TRANSLATOR_NAMESPACE}] 新版菜单按钮注入失败：`, e);
            }
        }

        // 旧版 UI：插入到 .comfy-menu（display 可能 none，但作为兼容兜底）
        const menuContainer = document.querySelector(".comfy-menu");
        if (menuContainer && !menuContainer.querySelector("#comfyui-api-translator-topbtn-legacy")) {
            try {
                const btn = document.createElement("button");
                btn.id = "comfyui-api-translator-topbtn-legacy";
                btn.textContent = "🌐";
                btn.title = tr("Extract all nodes of the plugin folder and translate them via the API");
                btn.style.cssText = "margin:2px;padding:4px 8px;font-size:12px;cursor:pointer;";
                btn.onclick = () => { translatePlugin(); };
                menuContainer.appendChild(btn);
                console.log(`[${TRANSLATOR_NAMESPACE}] 主菜单按钮已注入（旧版 UI，.comfy-menu）`);
                return true;
            } catch (e) {
                console.error(`[${TRANSLATOR_NAMESPACE}] 旧版菜单按钮注入失败：`, e);
            }
        }

        return false;
    }

    // ============================================================
    // 注册扩展
    // ============================================================

    app.registerExtension({
        name: TRANSLATOR_NAMESPACE,

        /**
         * setup：注入主菜单按钮
         * 右键菜单改用 getCanvasMenuItems / getNodeMenuItems 钩子（新版 API）
         */
        async setup() {
            // ---------- 主菜单按钮 ----------
            // 新版菜单在 app 初始化后才可用，需轮询等待
            const tryAddButton = () => {
                if (addTopbarButton()) return true;
                return false;
            };

            if (!tryAddButton()) {
                let tries = 0;
                const interval = setInterval(() => {
                    if (tryAddButton() || tries > 200) {
                        clearInterval(interval);
                        if (tries > 200) {
                            console.warn(`[${TRANSLATOR_NAMESPACE}] 主菜单按钮注入超时（app.menu 未就绪）`);
                        }
                    }
                    tries++;
                }, 100);
            }

            console.log(`[${TRANSLATOR_NAMESPACE}] 扩展已加载`);
        },

        /**
         * 画布空白处右键菜单（新版 API，替代 monkey-patch getCanvasMenuOptions）
         * 当画布上有选中节点时，添加 "翻译选中节点" 项
         */
        getCanvasMenuItems(canvas) {
            const items = [];

            // 兼容新旧 API 获取选中节点数
            let selectedCount = 0;
            if (canvas?.selectedItems?.size) {
                selectedCount = canvas.selectedItems.size;
            } else if (canvas?.selected_nodes) {
                selectedCount = Object.keys(canvas.selected_nodes).length;
            }

            if (selectedCount > 0) {
                items.push(null); // 分隔线
                items.push({
                    content: tr("🌐 Translate Selected Nodes ({n})", { n: selectedCount }),
                    callback: () => {
                        translateSelectedNodes();
                    },
                });
            }

            // 始终提供 "翻译整个插件" 入口
            items.push(null);
            items.push({
                content: "🌐 Translate Entire Plugin...",
                callback: () => {
                    translatePlugin();
                },
            });

            return items;
        },

        /**
         * 节点右键菜单（新版 API，替代 monkey-patch getExtraMenuOptions）
         * 在单个节点上右键时，提供翻译该节点的选项
         */
        getNodeMenuItems(node) {
            const items = [];

            if (node?.comfyClass) {
                items.push(null); // 分隔线
                items.push({
                    content: tr("🌐 Translate This Node ({name})", { name: node.comfyClass }),
                    callback: () => {
                        // 单节点翻译：构造一个临时选中集
                        // 先尝试把当前节点设为选中，然后调用统一流程
                        translateSingleNode(node.comfyClass);
                    },
                });
            }

            return items;
        },
    });

    /**
     * 翻译单个节点（从节点右键菜单触发）
     * 复用 translateSelectedNodes 的逻辑，但仅针对指定类名
     */
    async function translateSingleNode(className) {
        // 检查配置
        const cfgCheck = await checkTranslatorConfigured();
        if (!cfgCheck.configured) {
            showToast(cfgCheck.message, "error");
            return;
        }

        const progress = showProgressDialog();
        progress.update(tr("Extracting node {name} definition...", { name: className }));

        try {
            const extractResp = await api.fetchApi(ENDPOINT_EXTRACT_SELECTED, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ class_names: [className] }),
            });
            if (!extractResp.ok) {
                const err = await extractResp.json().catch(() => ({}));
                throw new Error(err.error || tr("Extract failed HTTP {code}", { code: extractResp.status }));
            }
            const extractData = await extractResp.json();

            if (extractData.node_count === 0) {
                progress.close();
                showToast(tr("Node definition not found: {name}", { name: className }), "warn");
                return;
            }

            progress.update(tr("Node definition extracted. Calling the translation API..."));

            const translateResp = await api.fetchApi(ENDPOINT_TRANSLATE, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    nodes: extractData.nodes,
                    categories: extractData.categories || {},
                    plugin_name: "selected_nodes",
                }),
            });
            if (!translateResp.ok) {
                const err = await translateResp.json().catch(() => ({}));
                throw new Error(err.error || tr("Translate failed HTTP {code}", { code: translateResp.status }));
            }
            const result = await translateResp.json();

            progress.close();

            if (result.status === "ok") {
                showToast(
                    formatDoneMessage(result),
                    (result.missing_count ?? 0) > 0 ? "warn" : "success"
                );
                // 自动刷新翻译显示
                if (result.mode === "auto") {
                    const refreshed = await refreshTranslation();
                    if (!refreshed) {
                        showToast(tr("Translation written. Toggle the translation switch or refresh the page to apply."), "info");
                    }
                }
            } else {
                showToast(tr("Translation failed: {msg}", { msg: result.message }), "error");
            }
        } catch (e) {
            progress.close();
            showToast(tr("Translation error: {msg}", { msg: e.message || e }), "error");
            console.error(`[${TRANSLATOR_NAMESPACE}] 翻译单节点失败：`, e);
        }
    }

    console.log(`[${TRANSLATOR_NAMESPACE}] 扩展注册完成`);
}

// 启动注册流程
registerTranslatorExtensionWhenReady();
