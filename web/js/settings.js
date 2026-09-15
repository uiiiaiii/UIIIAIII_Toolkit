/**
 * UIIIAIII Toolkit 插件设置界面
 *
 * 在 ComfyUI 设置面板中注册 "UIIIAIII Toolkit" 分类，
 * 统一管理 Agnes 和 ModelScope 的 API Key。
 *
 * 注册方式参考 comfyui-agent-panel（comfyui-mcp-panel.js）：
 * 使用全局 window.app / window.api，不依赖 ES module import，
 * 兼容 ComfyUI 桌面版的 Vite 前端加载机制。
 *
 * API 说明：
 * - 读取设置值：app.ui.settings.getSettingValue(id)
 * - 设置显示值：app.ui.settings.setSettingValue(id, value)
 * - type: "text" 用于文本输入（支持 defaultValue、onChange）
 */

// 插件命名空间（同时作为设置项 id 前缀）
const NAMESPACE = "UIIIAIII Toolkit";

// 后端 API Key 配置端点
const API_ENDPOINT = "/agnes-api-keys";

// 设置项 id（集中管理，便于在 onChange 中互相读取）
// 所有设置同属顶级分组 "UIIIAIII Toolkit"，全部用 id 三段式归组（可靠分组机制）：
// - Agnes/Modelscope 用 id "UIIIAIII Toolkit.① Node API.<name>" 归入 "UIIIAIII Toolkit > 节点API"
// - 翻译 API 4 项用 id "UIIIAIII Toolkit.② Translation API.<name>" 归入 "UIIIAIII Toolkit > 翻译API"
// - 字典复用开关用 id "UIIIAIII Toolkit.③ Translation Settings.<name>" 归入 "UIIIAIII Toolkit > 翻译设置"
const SETTING_AGNES = `UIIIAIII Toolkit.① Node API.agnesApiKey`;
const SETTING_MODELSCOPE = `UIIIAIII Toolkit.① Node API.modelscopeApiKey`;
const SETTING_TRANSLATOR_BASE_URL = `UIIIAIII Toolkit.② Translation API.translatorBaseUrl`;
const SETTING_TRANSLATOR_API_KEY = `UIIIAIII Toolkit.② Translation API.translatorApiKey`;
const SETTING_TRANSLATOR_MODEL = `UIIIAIII Toolkit.② Translation API.translatorModel`;
const SETTING_TRANSLATOR_TARGET_LANG = `UIIIAIII Toolkit.② Translation API.translatorTargetLang`;

// 翻译 API 配置端点
const TRANSLATE_CONFIG_ENDPOINT = "/agnes-translate/config";

// 设置栏分组标题（保持字面量，供菜单文本提取器拾取并翻译为目标语言）
const GROUP_NODE_API_TITLE = "① Node API";
const GROUP_TRANSLATION_API_TITLE = "② Translation API";
const GROUP_TRANSLATION_SETTINGS_TITLE = "③ Translation Settings";
const TRANSLATE_STATUS_ENDPOINT = "/agnes-translate/status";

/**
 * 等待 ComfyUI 前端 app 就绪后注册扩展
 *
 * ComfyUI 桌面版使用 Vite，扩展 JS 可能在 app 初始化前加载。
 * 通过轮询 window.app 的可用性来保证注册时机正确。
 * 参考：comfyui-agent-panel/web/js/comfyui-mcp-panel.js#registerExtensionWhenReady
 *
 * @param {number} tries - 当前尝试次数
 */
function registerExtensionWhenReady(tries = 0) {
    const comfyApp = window.comfyAPI?.app?.app || window.app;
    const comfyApi = window.comfyAPI?.api?.api || window.api || null;

    if (!comfyApp || typeof comfyApp.registerExtension !== "function" || !comfyApi) {
        if (tries >= 1000) {
            console.error(`[${NAMESPACE}] app.registerExtension 不可用，无法注册设置面板`);
            return;
        }
        setTimeout(() => registerExtensionWhenReady(tries + 1), 10);
        return;
    }

    const app = comfyApp;
    const api = comfyApi;

    /**
     * 安全读取设置项的值
     * @param {string} id - 设置项 id
     * @returns {string} 设置值（默认空字符串）
     */
    function getSettingValue(id) {
        try {
            return app?.ui?.settings?.getSettingValue?.(id) ?? "";
        } catch {
            return "";
        }
    }

    /**
     * 安全设置设置项的显示值（不触发 onChange 递归）
     * @param {string} id - 设置项 id
     * @param {string} value - 值
     */
    function setSettingValue(id, value) {
        try {
            app?.ui?.settings?.setSettingValue?.(id, value);
        } catch {
            // settings 存储不可用时静默忽略
        }
    }

    /**
     * 从后端加载配置
     * @returns {Promise<{agnes_api_key: string, modelscope_api_key: string}>}
     */
    async function loadApiKeys() {
        try {
            const response = await api.fetchApi(API_ENDPOINT, { method: "GET" });
            if (response.ok) {
                return await response.json();
            }
        } catch (e) {
            console.warn(`[${NAMESPACE}] 加载 API Key 配置失败：`, e);
        }
        return { agnes_api_key: "", modelscope_api_key: "" };
    }

    /**
     * 从后端加载翻译 API 配置
     * @returns {Promise<{base_url: string, api_key: string, model: string, target_lang: string}>}
     */
    async function loadTranslatorConfig() {
        try {
            const response = await api.fetchApi(TRANSLATE_STATUS_ENDPOINT, { method: "GET" });
            if (response.ok) {
                const data = await response.json();
                // status 端点不返回 api_key（安全考虑），单独从 api keys 端点读取
                const keysResp = await api.fetchApi(API_ENDPOINT, { method: "GET" });
                let apiKey = "";
                if (keysResp.ok) {
                    const keysData = await keysResp.json();
                    apiKey = keysData.translator_api_key || "";
                }
                return {
                    base_url: data.base_url || "https://api.openai.com/v1",
                    api_key: apiKey,
                    model: data.model || "gpt-4o-mini",
                    target_lang: data.target_lang || "zh-CN",
                };
            }
        } catch (e) {
            console.warn(`[${NAMESPACE}] 加载翻译配置失败：`, e);
        }
        return { base_url: "https://api.openai.com/v1", api_key: "", model: "gpt-4o-mini", target_lang: "zh-CN" };
    }

    /**
     * 保存翻译 API 配置到后端（部分更新：仅覆盖传入的字段）
     * （输出固定写入本插件 locales 目录，立即生效；无输出模式选项）
     */
    async function saveTranslatorConfig(baseUrl, apiKey, model, targetLang) {
        try {
            const payload = {};
            if (baseUrl !== undefined && baseUrl !== null) payload.base_url = baseUrl;
            if (apiKey !== undefined && apiKey !== null) payload.api_key = apiKey;
            if (model !== undefined && model !== null) payload.model = model;
            if (targetLang !== undefined && targetLang !== null) payload.target_lang = targetLang;
            const response = await api.fetchApi(TRANSLATE_CONFIG_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            return response.ok;
        } catch (e) {
            console.error(`[${NAMESPACE}] 保存翻译配置失败：`, e);
            return false;
        }
    }

    /**
     * 保存配置到后端
     * @param {string} agnesKey - Agnes API Key
     * @param {string} modelscopeKey - ModelScope API Token
     * @returns {Promise<boolean>}
     */
    async function saveApiKeys(agnesKey, modelscopeKey) {
        try {
            const response = await api.fetchApi(API_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    agnes_api_key: agnesKey || "",
                    modelscope_api_key: modelscopeKey || "",
                }),
            });
            return response.ok;
        } catch (e) {
            console.error(`[${NAMESPACE}] 保存 API Key 配置失败：`, e);
            return false;
        }
    }

    // ============================================================
    // 注册扩展及设置项
    // ============================================================
    // 使用 settings 数组方式注册（ComfyUI 标准 Settings 对话框 API），
    // 设置项会出现在 设置面板 → UIIIAIII Toolkit 分类下。
    // 参考：comfyui-agent-panel/web/js/comfyui-mcp-panel.js
    // ============================================================
    app.registerExtension({
        name: NAMESPACE,

        /**
         * init 在扩展加载的早期阶段执行，早于 settings 数组的处理。
         * 在此用 addSetting 注册翻译设置项，确保注册时机正确。
         *
         * 重要发现（通过 ComfyUI MCP 实时验证）：
         * - settings 数组静态注册的 text 类型设置项在某些情况下不渲染
         *   （具体原因未明，但 Agnes/Modelscope 两项能渲染，Translator 多项不能）
         * - setup() 中 addSetting 注册的设置项如果设置面板已被访问过则无法自动渲染
         * - init() 中 addSetting 注册的设置项能正常渲染
         * 因此翻译设置项改用 init() + addSetting 方式注册，
         * 用 id 三段式 "UIIIAIII Toolkit.② Translation API.<name>" 归入顶级分栏 UIIIAIII Toolkit 的翻译API子分组。
         */
        init() {
            const addSettingFn = app?.ui?.settings?.addSetting?.bind(app.ui.settings);
            if (typeof addSettingFn !== "function") {
                console.warn(`[${NAMESPACE}] init：addSetting 不可用，翻译设置项未注册`);
                return;
            }

            // ---- 节点API 设置（Agnes / ModelScope，动态 addSetting 注册）----
            addSettingFn({
                id: SETTING_AGNES,
                name: "Agnes API Key",
                type: "text",
                defaultValue: "",
                tooltip:
                    // 注意：tooltip 必须与 Menus/UIIIAIII_Toolkit.json 中的键逐字符一致（含 \n）
                    "Agnes AI API Key (for text-to-image / image-to-image / text-to-video / image-to-video / keyframe animation).\n" +
                    "Once set, all Agnes nodes will use this Key automatically - no need to enter it in each node again.",
                onChange: async (value) => {
                    const msValue = getSettingValue(SETTING_MODELSCOPE);
                    await saveApiKeys(value || "", msValue || "");
                },
            });

            addSettingFn({
                id: SETTING_MODELSCOPE,
                name: "ModelScope API Token",
                type: "text",
                defaultValue: "",
                tooltip:
                    "ModelScope API Token (used by the Qwen image editing node).\n" +
                    "Once set, the Qwen Image Edit node will use this Token automatically - no need to enter it again.\n" +
                    "Get it at: https://modelscope.cn/my/myaccesstoken",
                onChange: async (value) => {
                    const agnesValue = getSettingValue(SETTING_AGNES);
                    await saveApiKeys(agnesValue || "", value || "");
                },
            });

            // 翻译 API：Base URL
            // 归入 "UIIIAIII Toolkit > 翻译API" 子分组
            addSettingFn({
                id: SETTING_TRANSLATOR_BASE_URL,
                                name: "API Base URL",
                type: "text",
                defaultValue: "https://api.openai.com/v1",
                tooltip:
                    "Base URL of the translation API (OpenAI compatible).\n" +
                    "Common values: OpenAI https://api.openai.com/v1, DeepSeek https://api.deepseek.com/v1, " +
                    "Qwen https://dashscope.aliyuncs.com/compatible-mode/v1, Zhipu https://open.bigmodel.cn/api/paas/v4",
                onChange: async (value) => {
                    const apiKey = getSettingValue(SETTING_TRANSLATOR_API_KEY);
                    const model = getSettingValue(SETTING_TRANSLATOR_MODEL);
                    const targetLang = getSettingValue(SETTING_TRANSLATOR_TARGET_LANG);
                    await saveTranslatorConfig(value, apiKey, model, targetLang);
                },
            });

            // 翻译 API：API Key
            addSettingFn({
                id: SETTING_TRANSLATOR_API_KEY,
                name: "API Key",
                type: "text",
                defaultValue: "",
                tooltip:
                    "API Key for the translation API. Used to call OpenAI-compatible Chat Completions to translate node definitions.",
                onChange: async (value) => {
                    const baseUrl = getSettingValue(SETTING_TRANSLATOR_BASE_URL);
                    const model = getSettingValue(SETTING_TRANSLATOR_MODEL);
                    const targetLang = getSettingValue(SETTING_TRANSLATOR_TARGET_LANG);
                    await saveTranslatorConfig(baseUrl, value, model, targetLang);
                },
            });

            // 翻译 API：模型名
            addSettingFn({
                id: SETTING_TRANSLATOR_MODEL,
                name: "API Model",
                type: "text",
                defaultValue: "gpt-4o-mini",
                tooltip:
                    "Model name used for translation. Must support JSON Mode.\n" +
                    "Common values: gpt-4o-mini / gpt-4o / deepseek-chat / qwen-plus / qwen-turbo / glm-4-flash",
                onChange: async (value) => {
                    const baseUrl = getSettingValue(SETTING_TRANSLATOR_BASE_URL);
                    const apiKey = getSettingValue(SETTING_TRANSLATOR_API_KEY);
                    const targetLang = getSettingValue(SETTING_TRANSLATOR_TARGET_LANG);
                    await saveTranslatorConfig(baseUrl, apiKey, value, targetLang);
                },
            });

            // 翻译目标语言
            addSettingFn({
                id: SETTING_TRANSLATOR_TARGET_LANG,
                                name: "Target Language",
                type: "combo",
                options: [
                    { value: "zh-CN", text: "Simplified Chinese (zh-CN)" },
                    { value: "zh-TW", text: "Traditional Chinese (zh-TW)" },
                    { value: "en", text: "English (en)" },
                    { value: "ja", text: "Japanese (ja)" },
                    { value: "ko", text: "Korean (ko)" },
                    { value: "fr", text: "French (fr)" },
                    { value: "de", text: "German (de)" },
                    { value: "es", text: "Spanish (es)" },
                    { value: "ru", text: "Russian (ru)" },
                    { value: "pt", text: "Portuguese (pt)" },
                    { value: "it", text: "Italian (it)" },
                    { value: "ar", text: "Arabic (ar)" },
                ],
                defaultValue: "zh-CN",
                tooltip:
                    "Target language of the node definition translation.\n" +
                    "Default is Simplified Chinese. After switching to another language, the translation API will translate node names, inputs/outputs, widgets, etc. into the selected language.\n" +
                    "Note: the UI translation language (Translation Settings - Language) must match the target language, otherwise the result will not take effect.",
                onChange: async (value) => {
                    const baseUrl = getSettingValue(SETTING_TRANSLATOR_BASE_URL);
                    const apiKey = getSettingValue(SETTING_TRANSLATOR_API_KEY);
                    const model = getSettingValue(SETTING_TRANSLATOR_MODEL);
                    await saveTranslatorConfig(baseUrl, apiKey, model, value);
                },
            });

            console.log(`[${NAMESPACE}] init：设置项已注册（节点API 2 / 翻译API 4；翻译设置 3 项中字典开关由 SettingsPanel 注册）`);
        },


        /**
         * setup 在扩展加载完成后执行：
         * - 从后端读取已保存的配置并同步到设置项显示值
         *
         * 翻译设置项注册时机：init() 中（早于 settings 数组处理）。
         * 重要发现（通过 ComfyUI MCP 实时验证）：
         * - settings 数组静态注册的 text 类型设置项在某些情况下不渲染
         * - setup() 中 addSetting 注册的设置项如果设置面板已被访问过则无法自动渲染
         * - init() 中 addSetting 注册的设置项能正常渲染
         */
        async setup() {
            // 从后端加载配置并同步显示值
            const config = await loadApiKeys();
            if (config.agnes_api_key) {
                setSettingValue(SETTING_AGNES, config.agnes_api_key);
            }
            if (config.modelscope_api_key) {
                setSettingValue(SETTING_MODELSCOPE, config.modelscope_api_key);
            }

            // 加载翻译 API 配置并同步到设置项
            const translatorConfig = await loadTranslatorConfig();
            setSettingValue(SETTING_TRANSLATOR_BASE_URL, translatorConfig.base_url);
            if (translatorConfig.api_key) {
                setSettingValue(SETTING_TRANSLATOR_API_KEY, translatorConfig.api_key);
            }
            setSettingValue(SETTING_TRANSLATOR_MODEL, translatorConfig.model);
            setSettingValue(SETTING_TRANSLATOR_TARGET_LANG, translatorConfig.target_lang);

            console.log(`[${NAMESPACE}] 设置面板已加载（UIIIAIII Toolkit：节点API / 翻译API / 翻译设置）`);
        },
    });

    console.log(`[${NAMESPACE}] 扩展注册完成`);
}

// 启动注册流程
registerExtensionWhenReady();
