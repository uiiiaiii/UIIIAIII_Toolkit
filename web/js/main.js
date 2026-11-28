/**
 * ComfyUI-Translation 主逻辑模块
 *
 * 翻译功能基于以下两个开源项目修改而来：
 * - AIGODLIKE-ComfyUI-Translation (https://github.com/AIGODLIKE/AIGODLIKE-ComfyUI-Translation)
 * - ComfyUI-DD-Translation
 */

// ComfyUI 已废弃 /scripts/app.js 等 legacy 导入路径，改用运行时全局对象
// （window.comfyAPI 由前端在加载扩展前挂载；window.app 兼容更早的版本）
const app = window.comfyAPI?.app?.app || window.app;
import { applyMenuTranslation, observeFactory, restoreDomTranslations, restoreNodeDomText, stopMenuTranslation, translateAllDom } from "./MenuTranslate.js";
import { registerSettings, addPanelButtons, setupPluginManager } from "./SettingsPanel.js";
import {
  isAlreadyTranslatedText,
  isAlreadyTranslated,
  nativeTranslatedSettings,
  isTranslationEnabled,
  isOptionTranslationEnabled,
  initConfig,
  currentConfig,
  translatedValueSet,
  error
} from "./utils.js";

export class TUtils {
  static T = {
    Menu: {},
    Nodes: {},
    NodeCategory: {},
  };

  static async syncTranslation(OnFinished = () => {}, force = false) {
    try {
      translatedValueSet.clear();
      const enabled = isTranslationEnabled();
      const locale = currentConfig.locale;
      if (!TUtils._dictCache) TUtils._dictCache = new Map();

      // 字典按语言缓存：关闭翻译/切换开关时直接复用上次结果，
      // 不再等待网络请求，标题栏与节点可以在同一帧内恢复/翻译。
      // force=true 用于翻译写入后强制重新拉取，跳过缓存。
      if (force) TUtils._dictCache.delete(locale);
      let dict = TUtils._dictCache.get(locale);
      // 缓存里没有 Nodes 视为不完整（早期请求失败/后端未就绪），丢弃后重新拉取
      if (dict && (!dict.Nodes || Object.keys(dict.Nodes).length === 0)) {
        dict = null;
        TUtils._dictCache.delete(locale);
      }

      if (dict) {
        TUtils.buildTranslatedValueSet(dict);
      } else {
        // 首次加载/首次切换该语言：拉取字典并缓存
        dict = { Menu: {}, Nodes: {}, NodeCategory: {} };
        try {
          const response = await fetch("./translation_node/get_translation", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `locale=${locale}`
          });

          if (!response.ok) {
            throw new Error(`请求翻译数据失败: ${response.status} ${response.statusText}`);
          }

          dict = TUtils.normalizeTranslationDict(await response.json());
          TUtils.buildTranslatedValueSet(dict);
          // 只有拿到节点字典才缓存，避免把不完整字典长期留在缓存里
          if (dict.Nodes && Object.keys(dict.Nodes).length) {
            TUtils._dictCache.set(locale, dict);
          }
        } catch (e) {
          error("获取翻译数据失败:", e);
        }
      }

      // 关闭状态下字典对外不可用（TUtils.T 置空），避免误应用；
      // 但 translatedValueSet 已保留，供还原逻辑识别残留译文。
      TUtils.T = enabled ? dict : { Menu: {}, Nodes: {}, NodeCategory: {} };

      // 字典版本号：切换语言/重新同步后，绘制兜底立即重新扫描所有节点
      TUtils._dictVersion = (TUtils._dictVersion || 0) + 1;

      // 暴露当前翻译字典给其他模块（顶部按钮等按字典显示译文）
      window.__UiTranslated = TUtils.T;

      OnFinished();
    } catch (err) {
      error("同步翻译过程出错:", err);
      OnFinished();
    }
  }

  /** 规范化后端字典：合并分类到 Menu、提取节点标题 */
  static normalizeTranslationDict(resp) {
    const dict = { Menu: {}, Nodes: {}, NodeCategory: {} };
    for (const key of Object.keys(dict)) {
      dict[key] = (resp && resp[key]) || {};
    }

    // 合并分类到菜单中（复制一份，避免修改后端返回对象/缓存源）
    dict.Menu = Object.assign({}, dict.Menu, dict.NodeCategory || {});

    // 提取 Node 中 key 到 Menu
    for (const key in dict.Nodes) {
      const node = dict.Nodes[key];
      if (node && node["title"]) {
        dict.Menu[key] = node["title"] || key;
      }
    }
    return dict;
  }

  /** 构建“已翻译文本”集合，供恢复逻辑识别残留译文 */
  static buildTranslatedValueSet(dict) {
    translatedValueSet.clear();
    if (!dict) return;

    // ---- 提取所有字典内容 ----
    for (const d of [dict.Menu, dict.NodeCategory]) {
      if (!d) continue;
      for (const [key, val] of Object.entries(d)) {
        // 跳过 value==key：英文原样不算翻译，避免该英文词被判为"已翻译"而永远跳过
        if (val && typeof val === 'string' && key !== val) translatedValueSet.add(val);
      }
    }
    for (const nodeKey in dict.Nodes) {
      const nodeDict = dict.Nodes[nodeKey];
      if (!nodeDict) continue;
      if (nodeDict.title && typeof nodeDict.title === 'string' && nodeDict.title !== nodeKey) translatedValueSet.add(nodeDict.title);
      for (const cat of ['inputs', 'outputs', 'widgets']) {
        if (nodeDict[cat]) {
          for (const [key, val] of Object.entries(nodeDict[cat])) {
            // 跳过 value==key：未翻译原文不视为已翻译
            if (val && typeof val === 'string' && key !== val) translatedValueSet.add(val);
          }
        }
      }
    }
  }

  /**
   * 绘制前确保节点控件的显示名已翻译（成本极低：Set 查找 + 缓存）
   *
   * 覆盖场景：插件在运行时反复改写控件 label（如 cw.label = "detector_confidence"），
   * 晚于 nodeCreated 的翻译时机；绘制前兜底可保证界面始终显示译文。
   */
  /**
   * 给下拉控件安装选项显示名映射（getOptionLabel）
   *
   * 新版前端（1.59+）在渲染下拉列表前会调用该函数，因此选项在弹层打开时
   * 直接就是译文，不需要等 DOM 插入后再做文本替换（消除可见延迟）。
   * 只影响显示，控件值/工作流序列化保持英文原值。
   */
  static ensureComboOptionLabel(widget) {
    if (!widget || widget.type !== "combo") return;
    const options = widget.options;
    if (!options || typeof options.getOptionLabel === "function") return;
    options.getOptionLabel = (value) => {
      if (value === null || value === undefined) return "";
      const text = String(value);
      const menu = TUtils.T?.Menu;
      return (menu && menu[text]) || text;
    };
  }

  static translateNodeWidgetLabels(node) {
    try {
      const widgets = node?.widgets;
      if (!widgets || !widgets.length) return;

      // 子图容器的控件是内部控件投影，显示名以子图输入定义为准，跳过翻译
      if (this.isSubgraphNode(node)) return;

      if (!isTranslationEnabled()) {
        // 关闭翻译：还原先前被改写的控件显示名（label 可能来自运行时改写，需原样回退）
        for (const w of widgets) {
          if (!w || w._uiiaiii_tl_orig === undefined) continue;
          if (w._uiiaiii_tl_orig === null) delete w.label;
          else w.label = w._uiiaiii_tl_orig;
          delete w._uiiaiii_tl_orig;
          delete w._uiiaiii_tl;
        }
        return;
      }

      // 大工作流下避免每次绘制都全量扫描：同一节点最多每 500ms 兜底一次。
      // 字典版本变化（切换语言/重新同步）时立即重新扫描。
      const dictVersion = TUtils._dictVersion || 0;
      const now = performance.now();
      if (node._uiiaiii_tl_ver === dictVersion
          && node._uiiaiii_tl_ts
          && now - node._uiiaiii_tl_ts < 500) {
        return;
      }
      node._uiiaiii_tl_ver = dictVersion;
      node._uiiaiii_tl_ts = now;

      const menuT = this.T.Menu || {};
      const nodesT = this.T.Nodes || {};
      const classType = node.constructor?.comfyClass || node.constructor?.type;
      const widgetDict = (classType && nodesT[classType]?.widgets) || {};
      for (const w of widgets) {
        if (!w) continue;
        // 下拉选项：渲染前映射显示名，避免弹层打开后再替换文本
        this.ensureComboOptionLabel(w);
        // 撤销异常长的控件名（官方语言包/历史脏字典可能把 tooltip 整句写进 label）
        if (typeof w.label === "string" && this.isOversizedFieldLabel(w.name, w.label)) {
          delete w.label;
        }
        // 显示名优先 label，其次 name
        const shown = (typeof w.label === "string" && w.label) ? w.label : w.name;
        if (typeof shown !== "string" || !shown) continue;
        if (w._uiiaiii_tl === shown) continue;   // 显示名未变，无需重复处理
        w._uiiaiii_tl = shown;
        if (isAlreadyTranslatedText(shown)) continue;   // 已是译文
        // 字典以控件内部名为 key；插件改写 label 时按 label 兜底
        let translated = (w.name && widgetDict[w.name]) || widgetDict[shown] || menuT[shown];
        if (this.isOversizedFieldLabel(w.name, translated)) translated = null;
        if (translated && translated !== shown) {
          // 仅首次改写时记录原文（null 表示原本没有 label，显示名取 name）
          if (w._uiiaiii_tl_orig === undefined) {
            w._uiiaiii_tl_orig = (typeof w.label === "string" && w.label) ? w.label : null;
          }
          w._uiiaiii_label = translated;
          w._uiiaiii_applied = translated;
        }
      }
    } catch (e) { /* 忽略，不影响绘制 */ }
  }

  static enhandeDrawNodeWidgets() {
    try {
      let drawNodeWidgets = LGraphCanvas.prototype.drawNodeWidgets;
      LGraphCanvas.prototype.drawNodeWidgets = function (node, posY, ctx, active_widget) {
        if (!node.widgets || !node.widgets.length) {
          return 0;
        }
        // 绘制前兜底翻译控件显示名（覆盖插件运行时改写的 label）
        TUtils.translateNodeWidgetLabels(node);
        // 译文只在绘制期间临时写入 widget.label，绘制后恢复，
        // 保证工作流序列化数据永远是英文原文
        const restoreLabels = [];
        for (const w of node.widgets) {
          if (!w) continue;
          const translated = w._uiiaiii_applied ?? w._uiiaiii_label;
          if (translated === undefined) continue;
          const hadOwn = Object.prototype.hasOwnProperty.call(w, "label");
          restoreLabels.push([w, w.label, !hadOwn]);
          w.label = translated;
        }
        const widgets = node.widgets.filter((w) => w.type === "slider");
        widgets.forEach((widget) => {
          widget._ori_label = widget.label;
          const fixed = widget.options.precision != null ? widget.options.precision : 3;
          widget.label = (widget.label || widget.name) + ": " + Number(widget.value).toFixed(fixed).toString();
        });
        let result;
        try {
          result = drawNodeWidgets.call(this, node, posY, ctx, active_widget);
        } finally {
          widgets.forEach((widget) => {
            widget.label = widget._ori_label;
            delete widget._ori_label;
          });
          for (const [w, oldLabel, remove] of restoreLabels) {
            if (remove) delete w.label;
            else w.label = oldLabel;
          }
        }
        return result;
      };
    } catch (e) {
      error("增强节点小部件绘制失败:", e);
    }
  }

  static applyNodeTypeTranslationEx(nodeName) {
    try {
      let nodesT = this.T.Nodes;
      var nodeType = LiteGraph.registered_node_types[nodeName];
      if (!nodeType) return;

      let class_type = nodeType.comfyClass ? nodeType.comfyClass : nodeType.type;

      // 记录原型层英文原文标题（仅一次）。
      // 原型标题可能已被官方 i18n/历史翻译改成中文，不能当英文原文保存。
      if (nodeType._uiiaiii_orig_title === undefined) {
        nodeType._uiiaiii_orig_title =
          (typeof nodeType.title === "string" && nodeType.title && !this.containsCjk(nodeType.title))
            ? nodeType.title
            : (nodeType.comfyClass || nodeType.type || nodeType.title);
      }
      const origTitle = nodeType._uiiaiii_orig_title;

      // 记录原型原始分类，供 frontend-only 节点恢复分类名
      if (!TUtils._nodeDefOrigCategories) TUtils._nodeDefOrigCategories = new Map();
      if (class_type && !TUtils._nodeDefOrigCategories.has(class_type)) {
        TUtils._nodeDefOrigCategories.set(class_type, nodeType.category);
      }

      if (!isTranslationEnabled()) {
        if (origTitle !== undefined && nodeType.title !== origTitle) {
          nodeType.title = origTitle;
        }
        return;
      }

      // 蓝图/子图节点注册名不是蓝图标题，按原型英文标题或注册键查字典
      const zhTitle = nodesT?.[class_type]?.title
        || (typeof origTitle === "string" ? nodesT?.[origTitle]?.title : null)
        || (typeof nodeName === "string" ? nodesT?.[nodeName]?.title : null);
      // 搜索索引会读取节点标题/显示名；必须在索引构建前后都能拿到中文，
      // 所以恢复旧机制：开启翻译时直接改原型标题，关闭时还原。
      // 新建节点的实例标题会在 applyNodeTranslation 中还原成英文，避免写进工作流。
      if (typeof zhTitle === "string" && zhTitle && nodeType.title !== zhTitle) {
        nodeType.title = zhTitle;
      }

      // 节点库菜单/画布标题仍保留 Menu 映射，供 DOM 翻译器兜底
      if (this.T && this.T.Menu && typeof origTitle === "string" && origTitle
          && typeof zhTitle === "string" && zhTitle && zhTitle !== origTitle
          && this.T.Menu[origTitle] === undefined) {
        this.T.Menu[origTitle] = zhTitle;
      }
    } catch (e) {
      error(`为节点类型 ${nodeName} 应用翻译失败:`, e);
    }
  }

  static isComfyChineseLocale() {
    try {
      const locale = window.Comfy?.Locale || window.comfyAPI?.i18n?.locale || "";
      return String(locale).toLowerCase().startsWith("zh");
    } catch (e) {
      return false;
    }
  }

  /** 中文标题的 2~6 字子串，用于短中文/关键词查询命中 */
  static getSearchAliasVariants(text) {
    if (typeof text !== "string" || text.length < 2) return [];
    if (!/[\u3400-\u9fff]/.test(text)) return [];
    const out = [];
    const maxLen = Math.min(text.length, 6);
    for (let len = 2; len <= maxLen; len++) {
      for (let start = 0; start + len <= text.length; start++) {
        out.push(text.slice(start, start + len));
      }
    }
    return Array.from(new Set(out)).slice(0, 40);
  }

  /** 文本是否包含汉字（用于识别被翻译过的显示名/描述） */
  static containsCjk(text) {
    return typeof text === "string" && /[\u3400-\u9fff]/.test(text);
  }

  /**
   * 在节点定义实例上写入自有属性，覆盖 ComfyNodeDefImpl 原型上的只读 getter。
   *
   * 前端 1.59+ 的 display_name / description 只有 getter，没有 setter；
   * 直接赋值会在严格模式下抛 TypeError，导致关闭翻译时恢复无效。
   * defineProperty 写入自有 data 属性后，读取时优先于原型 getter，且可反复改写。
   */
  static setNodeDefOwnField(nodeDef, field, value) {
    if (!nodeDef || typeof field !== "string") return;
    try {
      // 读取值已经正确时无需写入（own 属性或原型 getter 都算）
      if (nodeDef[field] === value) return;
      Object.defineProperty(nodeDef, field, {
        value,
        writable: true,
        configurable: true,
        enumerable: true
      });
    } catch (e) { /* 忽略，不影响其它节点 */ }
  }

  static applyVueNodeDisplayNameTranslation(nodeDef) {
    try {
      if (!nodeDef || typeof nodeDef.name !== "string") return;
      const name = nodeDef.name;
      if (!TUtils._nodeDefOrigNames) TUtils._nodeDefOrigNames = new Map();
      if (!TUtils._nodeDefOrigAliases) TUtils._nodeDefOrigAliases = new Map();
      if (!TUtils._nodeDefAppliedNames) TUtils._nodeDefAppliedNames = new Set();

      // 记录原始英文显示名（按节点名保存）。不能直接用当前 display_name：
      // 开启翻译或历史版本可能已把它写成中文。
      if (!TUtils._nodeDefOrigNames.has(name)) {
        const backend = typeof nodeDef.backendDisplayName === "string" ? nodeDef.backendDisplayName : "";
        const current = typeof nodeDef.display_name === "string" ? nodeDef.display_name : "";
        const orig = backend || (!TUtils.containsCjk(current) ? current : "") || name;
        TUtils._nodeDefOrigNames.set(name, orig);
      }
      const orig = TUtils._nodeDefOrigNames.get(name);

      if (!TUtils._nodeDefOrigAliases.has(name)) {
        TUtils._nodeDefOrigAliases.set(
          name,
          Array.isArray(nodeDef.search_aliases) ? [...nodeDef.search_aliases] : nodeDef.search_aliases
        );
      }
      const origAliases = TUtils._nodeDefOrigAliases.get(name);
      // 蓝图/子图节点定义名不是蓝图标题，按英文显示名兜底查字典
      const zhTitle = TUtils.T.Nodes?.[name]?.title
        || (typeof orig === "string" ? TUtils.T.Nodes?.[orig]?.title : null)
        || (typeof nodeDef.backendDisplayName === "string"
          ? TUtils.T.Nodes?.[nodeDef.backendDisplayName]?.title
          : null);

      if (isTranslationEnabled() && typeof zhTitle === "string" && zhTitle && zhTitle !== orig) {
        // 节点库/搜索列表读取 display_name；用自有属性覆盖只读 getter。
        TUtils.setNodeDefOwnField(nodeDef, "display_name", zhTitle);
        const base = Array.isArray(origAliases) ? origAliases : [];
        // 同时保留英文显示名，并加入中文前缀，避免两三个汉字查询命中不了
        nodeDef.search_aliases = Array.from(new Set(
          [orig, zhTitle, ...this.getSearchAliasVariants(zhTitle), ...base]
            .filter((v) => typeof v === "string" && v)
        ));
        TUtils._nodeDefAppliedNames.add(name);
        if (TUtils.T && TUtils.T.Menu && typeof orig === "string" && orig
            && TUtils.T.Menu[orig] === undefined) {
          TUtils.T.Menu[orig] = zhTitle;
        }
      } else {
        // 关闭翻译或无译文：写回记录的英文原文。
        // 不依赖 applied 标记，避免 raw/store 两份对象互相清标记导致漏恢复。
        TUtils.setNodeDefOwnField(nodeDef, "display_name", orig);
        if (origAliases === undefined) delete nodeDef.search_aliases;
        else nodeDef.search_aliases = origAliases;
        TUtils._nodeDefAppliedNames.delete(name);
      }
    } catch (e) {
      error(`为Vue节点 ${nodeDef?.name} 应用显示名称翻译失败:`, e);
    }
  }

  /** 对所有已注册的 Vue 节点定义重新应用显示名/分类/描述（切换语言/开关翻译时用） */
  static applyVueNodeDefTranslations() {
    // 只操作 store 中已构建的 ComfyNodeDefImpl 实例。
    // raw 定义会被前端用来构造 store 对象，改写 raw 会固化 backendDisplayName/Description，
    // 之后只读 getter 永远返回被污染的值。
    const store = this.getNodeDefStore();
    const defs = store?.nodeDefs;
    if (!Array.isArray(defs)) return;
    for (const nodeDef of defs) {
      this.applyVueNodeDisplayNameTranslation(nodeDef);
      this.applyVueNodeTranslation(nodeDef);
      this.applyVueNodeDescriptionTranslation(nodeDef);
    }
  }

  /**
   * 获取前端 Pinia 的 nodeDef store。
   * 前端没有把 store 挂到 window 上，只能通过 Vue 应用实例访问。
   */
  static getNodeDefStore() {
    try {
      const el = document.querySelector("#vue-app") || document.querySelector("#app");
      const vueApp = el?.__vue_app__;
      const pinia = vueApp?.config?.globalProperties?.$pinia;
      return pinia?._s?.get?.("nodeDef") || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 强制重建节点搜索索引。
   * 修改 display_name / search_aliases 不会自动让 Fuse 索引失效，
   * 这里通过临时注册一个恒真过滤器触发 visibleNodeDefs 重算，
   * 再立即移除，使 nodeSearchService 用当前中文定义重建。
   */
  static refreshNodeSearchIndex() {
    const store = this.getNodeDefStore();
    if (!store) return false;
    try {
      // 把当前开关状态应用到 store 中全部节点定义（包括 frontend-only 节点）。
      // updateNodeDefs 可能重建实例，所以替换映射后需要再应用一次。
      const applyAll = () => {
        for (const def of store.nodeDefs || []) {
          this.applyVueNodeDisplayNameTranslation(def);
          this.applyVueNodeTranslation(def);
          this.applyVueNodeDescriptionTranslation(def);
        }

        // 关闭翻译时再做一次兜底：即使原始值映射缺失（例如旧版本污染的定义），
        // 也要把残留的中文显示名/分类/描述恢复成英文。
        if (!isTranslationEnabled()) {
          for (const def of store.nodeDefs || []) {
            if (this.containsCjk(def.display_name)) {
              const backend = typeof def.backendDisplayName === "string" && !this.containsCjk(def.backendDisplayName)
                ? def.backendDisplayName
                : def.name;
              this.setNodeDefOwnField(def, "display_name", backend || def.name);
            }
            // 分类管理器接管后，中文分类可能是用户自定义名称，不能反查成英文
            if (!this.isCategoryManagerActive()
                && typeof def.category === "string" && this.containsCjk(def.category)) {
              def.category = def.category.split("/")
                .map((part) => this._categoryReverse?.get(part) || part)
                .join("/");
            }
            if (this.containsCjk(def.description)) {
              const backend = typeof def.backendDescription === "string" && !this.containsCjk(def.backendDescription)
                ? def.backendDescription
                : "";
              this.setNodeDefOwnField(def, "description", backend);
            }
          }
        }
      };

      applyAll();
      if (typeof store.updateNodeDefs === "function" && store.nodeDefsByName) {
        // 用新对象替换节点定义映射，强制 visibleNodeDefs / 搜索列表重新渲染；
        // 只替换后端定义，蓝图定义由 blueprintNodeDefsByName 单独维护。
        const byName = store.nodeDefsByName;
        const defs = byName instanceof Map ? [...byName.values()] : Object.values(byName);
        store.updateNodeDefs(defs);
        applyAll();
      } else if (typeof store.registerNodeDefFilter === "function"
          && typeof store.unregisterNodeDefFilter === "function") {
        const id = "uiiaiii.search.refresh";
        store.registerNodeDefFilter({
          id,
          name: "UI translation refresh",
          description: "",
          predicate: () => true
        });
        store.unregisterNodeDefFilter(id);
      }
      // 已打开的节点搜索弹层也要重渲染，否则会继续显示缓存结果
      setTimeout(() => this.refreshNodeSearchUi(), 80);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 强制节点搜索弹层重新渲染。
   * 索引重建后，已经打开的弹层仍可能缓存旧结果（中文名/描述），
   * 这里对输入框和弹层 Vue 实例做一次刷新。
   */
  static refreshNodeSearchUi() {
    try {
      const input = document.querySelector('input[placeholder*="Add a node"]')
        || document.querySelector('input[placeholder*="add a node"]')
        || document.querySelector(".node-search input");
      if (!input) return;
      const original = input.value ?? "";
      const forceVueUpdate = () => {
        let inst = input.closest('[role="dialog"], .comfy-dialog, .p-dialog')?.__vueParentComponent
          || input.__vueParentComponent;
        let depth = 0;
        while (inst && depth++ < 20) {
          try { inst.proxy?.$forceUpdate?.(); } catch (e) { /* 忽略 */ }
          inst = inst.parent;
        }
      };
      // 用不可能命中的查询清空结果列表，让 Vue 卸载旧列表项；
      // 恢复原查询时列表会重新创建，DOM 上残留的译文也随之消失。
      const resetQuery = "__uiiaiii_refresh__";
      input.value = resetQuery;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      setTimeout(() => {
        if (input.value !== resetQuery) return; // 用户已输入新内容，不覆盖
        input.value = original;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        forceVueUpdate();
      }, 60);
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 新建/加载节点时，原型标题可能已被翻译成中文。
   * 还原实例标题为英文，避免 node.title 被序列化进工作流；
   * 显示层仍由 _uiiaiii_title 提供中文。
   */
  static normalizeNodeInstanceTitle(node) {
    try {
      if (!node || node._translation_custom_title) return;
      const protoTitle = node.constructor?.title;
      const origTitle = node.constructor?._uiiaiii_orig_title;
      if (typeof origTitle !== "string" || !origTitle) return;
      if (typeof node.title === "string" && node.title === protoTitle
          && isAlreadyTranslatedText(node.title)) {
        node.title = origTitle;
      }
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 分类管理器是否已就绪。
   * 就绪后 nodeDef.category 由分类管理器统一维护（基准 + 用户规则 + 字典翻译）；
   * 翻译模块再写会覆盖用户的分类规则。
   */
  static isCategoryManagerActive() {
    return !!(window.__CM__ && window.__CM__.ready);
  }

  static applyVueNodeTranslation(nodeDef) {
    try {
      if (!nodeDef || typeof nodeDef.name !== "string") return;
      const name = nodeDef.name;
      // 分类管理器已接管分类显示路径，翻译模块不再改写 category
      if (this.isCategoryManagerActive()) {
        TUtils._nodeDefAppliedCategories?.delete(name);
        return;
      }
      if (!TUtils._nodeDefOrigCategories) TUtils._nodeDefOrigCategories = new Map();
      if (!TUtils._nodeDefAppliedCategories) TUtils._nodeDefAppliedCategories = new Set();
      if (!TUtils._nodeDefOrigCategories.has(name)) {
        TUtils._nodeDefOrigCategories.set(name, nodeDef.category);
      }
      const origCategory = TUtils._nodeDefOrigCategories.get(name);

      if (!isTranslationEnabled()) {
        if (origCategory !== undefined && nodeDef.category !== origCategory) {
          nodeDef.category = origCategory;
        }
        TUtils._nodeDefAppliedCategories.delete(name);
        return;
      }

      if (!origCategory) return;
      const catsT = TUtils.T.NodeCategory || {};
      if (!TUtils._categoryReverse) TUtils._categoryReverse = new Map();
      for (const [en, zh] of Object.entries(catsT)) {
        if (typeof en === "string" && typeof zh === "string" && zh && zh !== en) {
          TUtils._categoryReverse.set(zh, en);
        }
      }
      const catArr = String(origCategory).split("/");
      nodeDef.category = catArr.map((cat) => catsT?.[cat] || cat).join("/");
      TUtils._nodeDefAppliedCategories.add(name);
    } catch (e) {
      error(`为Vue节点 ${nodeDef?.name} 应用翻译失败:`, e);
    }
  }

  static applyVueNodeDescriptionTranslation(nodeDef) {
    try {
      if (!nodeDef || typeof nodeDef.name !== "string") return;
      const name = nodeDef.name;
      if (!TUtils._nodeDefOrigDescriptions) TUtils._nodeDefOrigDescriptions = new Map();
      if (!TUtils._nodeDefAppliedDescriptions) TUtils._nodeDefAppliedDescriptions = new Set();
      if (!TUtils._nodeDefOrigDescriptions.has(name)) {
        const backend = typeof nodeDef.backendDescription === "string" ? nodeDef.backendDescription : "";
        const current = typeof nodeDef.description === "string" ? nodeDef.description : "";
        const orig = backend || (!TUtils.containsCjk(current) ? current : "");
        TUtils._nodeDefOrigDescriptions.set(name, orig);
      }
      const orig = TUtils._nodeDefOrigDescriptions.get(name) ?? "";

      if (!isTranslationEnabled()) {
        TUtils.setNodeDefOwnField(nodeDef, "description", orig);
        TUtils._nodeDefAppliedDescriptions.delete(name);
        return;
      }

      const zhDescription = TUtils.T.Nodes?.[name]?.description;
      if (typeof zhDescription === "string" && zhDescription && zhDescription !== orig) {
        TUtils.setNodeDefOwnField(nodeDef, "description", zhDescription);
        TUtils._nodeDefAppliedDescriptions.add(name);
      } else {
        // 没有中文描述时写回英文，避免残留上一次写入的中文
        TUtils.setNodeDefOwnField(nodeDef, "description", orig);
      }
    } catch (e) { /* 忽略 */ }
  }

  static applyNodeTypeTranslation(app) {
    try {
      // 不在此判断开关：由 applyNodeTypeTranslationEx 内部按开关应用或还原
      for (let nodeName in LiteGraph.registered_node_types) {
        this.applyNodeTypeTranslationEx(nodeName);
      }
    } catch (e) {
      error("应用节点类型翻译失败:", e);
    }
  }

  static needsTranslation(item) {
    if (!item || !item.hasOwnProperty("name")) return false;
    
    if (isAlreadyTranslated(item.name, item.label)) {
      return false;
    }
    
    if (isAlreadyTranslatedText(item.name)) {
      return false;
    }
    
    return true;
  }

  /**
   * 写入真实显示 label（首帧渲染即译文，避免回来再改 DOM 造成可见刷新）。
   * 原始值记录在 _uiiaiii_orig_label，保存工作流时由序列化补丁恢复英文。
   */
  static applyDisplayLabel(item, translation) {
    if (!item || !translation) return;
    if (item._uiiaiii_orig_label === undefined) {
      item._uiiaiii_orig_label = Object.prototype.hasOwnProperty.call(item, "label")
        ? item.label
        : null;
    }
    if (item.label !== translation) item.label = translation;
    item._uiiaiii_label = translation;
    item._uiiaiii_applied = translation;
  }

  /** 恢复真实显示 label */
  static restoreDisplayLabel(item) {
    if (!item || item._uiiaiii_orig_label === undefined) return;
    const orig = item._uiiaiii_orig_label;
    if (orig === null) delete item.label;
    else item.label = orig;
    delete item._uiiaiii_orig_label;
    delete item._uiiaiii_label;
    delete item._uiiaiii_applied;
  }

  /** 写入真实节点标题（首帧渲染即译文，保存时由序列化补丁恢复英文） */
  static applyNodeTitleDisplay(node, translation) {
    if (!node || !translation) return;
    if (node._uiiaiii_orig_title_instance === undefined) {
      node._uiiaiii_orig_title_instance = node.title;
    }
    if (node.title !== translation) node.title = translation;
    node._uiiaiii_title = translation;
  }

  /** 恢复真实节点标题 */
  static restoreNodeTitleDisplay(node) {
    if (!node || node._uiiaiii_orig_title_instance === undefined) return;
    node.title = node._uiiaiii_orig_title_instance;
    delete node._uiiaiii_orig_title_instance;
    delete node._uiiaiii_title;
  }

  static safeApplyTranslation(item, translation) {
    if (this.needsTranslation(item) && translation) {
      if (!item._original_name) {
        item._original_name = item.name;
      }
      this.applyDisplayLabel(item, translation);
    }
  }

  static restoreOriginalTranslation(item) {
    if (item._original_name) {
      item.label = item._original_name;
      delete item._original_name;
    } else if (item.label && item.name) {
      item.label = item.name;
    }
  }

  /**
   * 节点标题是否为用户自定义（界面上双击标题改名）。
   *
   * 用户在画布上改名时 LiteGraph 直接写 node.title，不经过任何钩子，
   * 而绘制层会用 _uiiaiii_title 覆盖显示 → 改名后仍显示译文。
   * 因此每次应用/绘制时按运行时状态判定：标题既不是原型英文标题、
   * 也不是当前译文、且不属于已知译文 → 视为用户自定义，翻译让位。
   */
  static isCustomNodeTitle(node) {
    if (!node) return false;
    const title = node.title;
    if (typeof title !== "string" || !title) return false;
    if (node._uiiaiii_title !== undefined && title === node._uiiaiii_title) return false;
    if (isAlreadyTranslatedText(title)) return false;

    const classType = node.constructor?.comfyClass || node.constructor?.type;
    const dictTitle = classType ? this.T.Nodes?.[classType]?.title : undefined;
    if (dictTitle !== undefined && title === dictTitle) return false;

    // 原型标题：未翻译时是英文原名，翻译后是译文；两者都代表"不是用户改的"
    const protoTitle = node.constructor?.title;
    if (protoTitle !== undefined && title === protoTitle) return false;

    const origTitle = node.constructor?._uiiaiii_orig_title;
    if (origTitle !== undefined && title === origTitle) return false;

    return true;
  }

  /**
   * 应用端口（inputs/outputs）显示名译文。
   *
   * 关键原则：译文只写入自定义属性 _uiiaiii_label，**绝不写 slot.label**。
   * LiteGraph 序列化会把 slot.label 写进工作流 JSON，一旦改写就会持久污染
   * （关闭翻译后重新加载工作流仍显示中文）。显示层的译文由 patchNodeDrawing()
   * 在绘制瞬间临时映射到 label，序列化数据始终只含英文原名。
   * （widgets 的 label 不参与序列化，故仍可照常改写。）
   */
  /**
   * 判断译文是否为"整句说明"误当成了字段显示名。
   *
   * 字典的 widgets/inputs 段同时收录 tooltip 原文（key 为整句），翻译管线
   * 偶尔会把 tooltip 译文写到字段名上。字段名本身很短（无空格）而译文超长
   * 时一律视为脏数据：套用后 Nodes 2.0 会按文字宽度把节点撑得极长。
   */
  static isOversizedFieldLabel(name, translation) {
    if (typeof name !== "string" || typeof translation !== "string") return false;
    if (!name || name.length > 40 || /\s/.test(name)) return false;
    return translation.length > 60;
  }

  static applySlotTranslation(item, translation) {
    if (!item || !translation || translation === item.name) return;
    if (this.isOversizedFieldLabel(item.name, translation)) return;

    // 写入真实 label 让首帧就是译文；原始 label 记录在 _uiiaiii_orig_label，
    // 保存工作流时由序列化补丁临时恢复英文，避免持久污染。
    this.applyDisplayLabel(item, translation);
  }

  /**
   * 判断节点是否为子图容器节点（Subgraph Node）。
   *
   * 子图容器的端口/控件是把内部节点的端口/控件"提升"出来的投影，
   * 显示名由用户为子图输入/输出定义的名字决定，不能套用翻译字典，
   * 否则用户自定义的"步数"会被源控件的译文"步进"覆盖。
   */
  static isSubgraphNode(node) {
    if (!node) return false;
    try {
      if (typeof node.isSubgraphNode === "function" && node.isSubgraphNode()) return true;
      if (node.subgraph) return true;
    } catch (e) { /* 忽略 */ }
    return false;
  }

  /**
   * 把子图容器上提升端口的显示名同步为子图自身输入/输出定义的名字。
   *
   * 历史版本会把提升控件当作普通控件翻译（如 steps → 步进），该译文会被
   * 前端写进工作流并显示在容器外，与用户在子图内部设置的名字（如"步数"）
   * 不一致。这里以子图边界的 label 为唯一权威来源做一次纠正。
   */
  static syncSubgraphHostLabels(node) {
    // 子图容器的提升接口是用户可自主编辑名称的数据：插件完全不翻译、
    // 不覆盖、不恢复。这里只清理插件自己留下的显示层标记，并给容器 DOM
    // 打标记，供 DOM 翻译器跳过整个容器子树。
    try {
      delete node?._uiiaiii_title;
      const root = document.querySelector(`[data-node-id="${node?.id}"]`);
      if (root) root.setAttribute("data-uiiaiii-subgraph", "1");
      for (const key of ["inputs", "outputs", "widgets"]) {
        const arr = node?.[key];
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          if (!item) continue;
          delete item._uiiaiii_label;
          delete item._uiiaiii_tl;
          delete item._uiiaiii_applied;
          delete item._uiiaiii_tl_orig;
          delete item._original_name;
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 逐级展开的参考输入定义（接入第 N 个后显示第 N+1 个）
   *
   * 后端在 INPUT_TYPES 中声明了全部插槽（图片 5 个、音频 3 个），
   * 前端初始只保留每组第一个，连接后再补下一个，断开时回收多余的未连接插槽。
   */
  static getGrowableInputGroups(classType) {
    const groups = [];
    const imageNames = {
      AgnesImage: [
        "reference_images_1", "reference_images_2", "reference_images_3",
        "reference_images_4", "reference_images_5",
      ],
      AgnesVideo: [
        "reference_images_1", "reference_images_2", "reference_images_3",
        "reference_images_4", "reference_images_5",
      ],
      QwenImageEdit: ["image1", "image2", "image3"],
      QwenImage21: ["image1", "image2", "image3", "image4"],
      MiniMaxH3Image: Array.from({ length: 16 }, (_, i) => `reference_images_${i + 1}`),
    };
    if (imageNames[classType]) {
      groups.push({ type: "IMAGE", names: imageNames[classType] });
    }
    if (classType === "AgnesVideo") {
      groups.push({
        type: "AUDIO",
        names: ["reference_audio_1", "reference_audio_2", "reference_audio_3"],
      });
    }
    return groups;
  }

  static setupGrowableInputs(node) {
    try {
      if (!node) return;
      if (node._uiiaiii_grow_setup) {
        this.syncGrowableInputs(node);
        return;
      }
      node._uiiaiii_grow_setup = true;

      const inputType = (typeof LiteGraph !== "undefined" && LiteGraph.INPUT !== undefined)
        ? LiteGraph.INPUT
        : 1;
      const prev = node.onConnectionsChange;
      node.onConnectionsChange = function (type, index, connected, linkInfo, slot) {
        let res;
        if (typeof prev === "function") {
          res = prev.apply(this, arguments);
        }
        try {
          const name = slot?.name || this.inputs?.[index]?.name;
          const groups = TUtils.getGrowableInputGroups(
            this.constructor?.comfyClass || this.constructor?.type
          );
          if (type === inputType && groups.some((g) => g.names.includes(name))) {
            setTimeout(() => TUtils.syncGrowableInputs(this), 0);
          }
        } catch (e) { /* 忽略 */ }
        return res;
      };

      // 等节点完成初始插槽构建后再裁剪
      setTimeout(() => this.syncGrowableInputs(node), 0);
    } catch (e) { /* 忽略 */ }
  }

  static syncGrowableInputs(node) {
    try {
      if (!node || !Array.isArray(node.inputs)) return;
      const classType = node.constructor?.comfyClass || node.constructor?.type;
      const groups = this.getGrowableInputGroups(classType);
      if (!groups.length) return;
      let changed = false;

      for (const group of groups) {
        const isConnected = (name) => {
          const idx = node.inputs.findIndex((inp) => inp && inp.name === name);
          if (idx === -1) return false;
          if (typeof node.isInputConnected === "function") {
            try { return node.isInputConnected(idx); } catch (e) { /* 忽略 */ }
          }
          const inp = node.inputs[idx];
          return inp.link != null || (Array.isArray(inp.links) && inp.links.length > 0);
        };

        let count = 0;
        for (const name of group.names) {
          if (isConnected(name)) count++;
        }
        const desired = Math.min(group.names.length, Math.max(1, count + 1));

        // 回收超出 desired 的未连接插槽
        for (let i = group.names.length - 1; i >= desired; i--) {
          const name = group.names[i];
          if (isConnected(name)) continue;
          const idx = node.inputs.findIndex((inp) => inp && inp.name === name);
          if (idx !== -1) {
            node.removeInput(idx);
            changed = true;
          }
        }

        // 补足 desired 以内的插槽
        for (let i = 0; i < desired; i++) {
          const name = group.names[i];
          if (!node.inputs.some((inp) => inp && inp.name === name)) {
            node.addInput(name, group.type);
            changed = true;
          }
        }
      }

      if (changed) {
        if (typeof node.computeSize === "function" && typeof node.setSize === "function") {
          const size = node.computeSize();
          node.setSize([node.size?.[0] ?? size[0], size[1]]);
        }
        node.graph?.setDirtyCanvas?.(true, true);
        node.setDirtyCanvas?.(true, true);
      }
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 恢复单个节点的显示层译文，不触碰工作流数据。
   * 用于语言切换/关闭翻译时清掉旧语言残留。
   */
  static restoreNodeDisplay(node) {
    if (!node) return;
    // 子图容器由用户定义：只按子图定义的 name 修正历史译文显示，绝不写持久字段
    if (this.isSubgraphNode(node)) {
      this.syncSubgraphHostLabels(node);
      return;
    }
    // 标题还原：优先恢复首帧写入前的原始英文标题
    this.restoreNodeTitleDisplay(node);
    delete node._uiiaiii_title;
    // 历史工作流可能残留旧译文标题，或原型标题仍是译文
    if (!node._translation_custom_title && node.title && isAlreadyTranslatedText(node.title)) {
      node.title = node._original_title
        || node.constructor?._uiiaiii_orig_title
        || node.constructor?.comfyClass
        || node.constructor?.type
        || node.title;
    }
    delete node._original_title;
    for (const key of ["inputs", "outputs", "widgets"]) {
      const arr = node[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item) continue;
        const applied = item._uiiaiii_applied ?? item._uiiaiii_label;
        const userChanged = typeof item.label === "string"
          && applied !== undefined && item.label !== applied;
        if (userChanged) {
          // 用户手动改过显示名：保留用户输入，只清理我们的标记
          delete item._original_name;
          delete item._uiiaiii_orig_label;
          delete item._uiiaiii_tl_orig;
          delete item._uiiaiii_tl;
          delete item._uiiaiii_label;
          delete item._uiiaiii_applied;
          continue;
        }
        // 恢复首帧写入前的真实 label
        if (item._uiiaiii_orig_label !== undefined) {
          this.restoreDisplayLabel(item);
        }
        delete item._uiiaiii_label;
        delete item._uiiaiii_tl;
        // localized_name 是节点端口的翻译显示字段，旧工作流会把它序列化保存；
        // 关闭翻译后必须清掉，否则端口仍显示旧译文
        if (typeof item.localized_name === "string" && isAlreadyTranslatedText(item.localized_name)) {
          delete item.localized_name;
        }
        if (item._original_name) {
          item.label = item._original_name;
          delete item._original_name;
        } else if (item._uiiaiii_tl_orig !== undefined) {
          if (item._uiiaiii_tl_orig === null) delete item.label;
          else item.label = item._uiiaiii_tl_orig;
        }
        delete item._uiiaiii_tl_orig;
        delete item._uiiaiii_applied;
      }
    }
  }

  /**
   * 保证工作流序列化数据干净。
   * 保存期间临时移除翻译显示字段和插件内部标记，保存后立即恢复；
   * 绝不把译文、localized_name 或 _uiiaiii_* 写进工作流 JSON。
   */
  static patchSerialization() {
    try {
      if (typeof LGraph === "undefined" || !LGraph.prototype || LGraph.prototype._uiiaiii_serialize_patched) return;
      const origSerialize = LGraph.prototype.serialize;
      if (typeof origSerialize !== "function") return;

      const CLEAN_KEYS = [
        "localized_name",
        "_uiiaiii_label",
        "_uiiaiii_title",
        "_uiiaiii_tl",
        "_uiiaiii_tl_orig",
        "_uiiaiii_applied",
        "_uiiaiii_orig_label",
        "_uiiaiii_orig_title_instance",
        "_original_name",
        "_original_title",
        "_translation_custom_title",
      ];
      const clean = (obj, restore) => {
        if (!obj || typeof obj !== "object") return;
        for (const key of CLEAN_KEYS) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            restore.push([obj, key, obj[key]]);
            delete obj[key];
          }
        }
      };

      // 首帧写入的真实 label/title 在保存时临时恢复英文，保存后还原译文
      const hideDisplay = (obj, restoreDisplay) => {
        if (!obj || typeof obj !== "object") return;
        if (obj._uiiaiii_orig_label !== undefined
            && Object.prototype.hasOwnProperty.call(obj, "label")) {
          restoreDisplay.push([obj, "label", obj.label]);
          if (obj._uiiaiii_orig_label === null) delete obj.label;
          else obj.label = obj._uiiaiii_orig_label;
        }
        if (obj._uiiaiii_orig_title_instance !== undefined
            && Object.prototype.hasOwnProperty.call(obj, "title")) {
          restoreDisplay.push([obj, "title", obj.title]);
          obj.title = obj._uiiaiii_orig_title_instance;
        }
      };

      const walkGraph = (graph, restore, restoreDisplay) => {
        for (const node of graph?._nodes || []) {
          hideDisplay(node, restoreDisplay);
          clean(node, restore);
          for (const key of ["inputs", "outputs", "widgets"]) {
            const arr = node?.[key];
            if (Array.isArray(arr)) {
              for (const item of arr) {
                hideDisplay(item, restoreDisplay);
                clean(item, restore);
              }
            }
          }
          if (node?.subgraph?._nodes) {
            walkGraph(node.subgraph, restore, restoreDisplay);
          }
        }
      };

      LGraph.prototype.serialize = function () {
        const restore = [];
        const restoreDisplay = [];
        try {
          walkGraph(this, restore, restoreDisplay);
          return origSerialize.apply(this, arguments);
        } finally {
          for (const [obj, key, value] of restoreDisplay) obj[key] = value;
          for (const [obj, key, value] of restore) obj[key] = value;
        }
      };
      LGraph.prototype._uiiaiii_serialize_patched = true;
    } catch (e) {
      error("拦截工作流序列化失败:", e);
    }
  }

  /**
   * 实时切换词典语言：恢复旧译文 → 重新加载字典 → 重新应用。
   * 不刷新页面，不修改工作流数据。
   */
  static async switchLocale(locale, options = {}) {
    try {
      currentConfig.locale = locale;
      // 翻译提取/写入后强制重载字典，避免命中旧缓存
      if (options.force) TUtils._dictCache?.delete(locale);
      const graph = (window.comfyAPI?.app?.app || window.app)?.graph;
      const nodes = this.collectAllNodes(graph);

      // 必须先停掉旧字典的观察器：否则恢复后的英文会在等待 syncTranslation
      // 的异步期间被旧观察器重新翻译，且原文账本已清，之后就再也恢复不了。
      stopMenuTranslation();
      TUtils._dragObserver?.disconnect?.();
      TUtils._dragObserver = null;

      restoreDomTranslations();
      for (const node of nodes) this.restoreNodeDisplay(node);

      await this.syncTranslation();
      // 早期请求可能拿到不完整字典（Nodes 为空），开启时再强制同步一次
      if (isTranslationEnabled() && (!this.T?.Nodes || Object.keys(this.T.Nodes).length === 0)) {
        await this.syncTranslation();
      }

      // 节点原型标题按新状态/语言重新应用（关闭时恢复英文）
      this.applyNodeTypeTranslation(window.comfyAPI?.app?.app || window.app);
      // 节点定义的 display_name 同步切换（搜索索引读取该字段）
      this.applyVueNodeDefTranslations();
      // 主动重建搜索索引，英文界面下也能直接中文搜索
      this.refreshNodeSearchIndex();

      if (isTranslationEnabled()) {
        const app = window.comfyAPI?.app?.app || window.app;
        const applyNode = (node) => {
          if (!node || this.isSubgraphNode(node)) return;
          delete node._uiiaiii_apply_state;
          this.applyNodeTranslation(node);
        };
        for (const node of nodes) applyNode(node);
        const currentGraph = app?.canvas?.graph;
        if (currentGraph && currentGraph !== app?.graph) {
          for (const node of this.collectAllNodes(currentGraph)) applyNode(node);
        }
        applyMenuTranslation(this.T);
        translateAllDom(this.T);
      }
      // 触发下拉控件重新计算显示值（Nodes 2.0 缓存需要响应式更新）
      this.refreshComboWidgets(nodes);
      this.syncComboDomLabels(nodes);
      this.syncNodeDomLabels(nodes);
      graph?.setDirtyCanvas?.(true, true);
      // 节点画布/下拉控件：强制重绘，避免关闭翻译后控件显示值要点击一次才更新
      if (graph?._nodes) {
        for (const node of graph._nodes) node?.setDirtyCanvas?.(true, true);
      }
      const comfyApp = window.comfyAPI?.app?.app || window.app;
      comfyApp?.canvas?.setDirty?.(true, true);
      comfyApp?.canvas?.draw?.(true, true);
      // 节点渲染器/组件更新是异步的：下一帧再强制重绘一次，
      // 确保下拉当前值不会停留在旧语言的画面缓存里
      requestAnimationFrame(() => {
        this.syncComboDomLabels(nodes);
        this.syncNodeDomLabels(nodes);
      this.syncNodeDomLabels(nodes);
        graph?.setDirtyCanvas?.(true, true);
        comfyApp?.canvas?.setDirty?.(true, true);
        comfyApp?.canvas?.draw?.(true, true);
      });
      const prevCats = TUtils._dictCache?.[currentConfig.locale]?.NodeCategory || {};
      window.dispatchEvent(new CustomEvent("uiiaiii-locale-changed", {
        detail: { locale, previousCategories: prevCats }
      }));
      window.dispatchEvent(new CustomEvent("uiiaiii-translation-state-changed", {
        detail: { enabled: isTranslationEnabled(), previousCategories: prevCats }
      }));

      // 子图按钮文案跟随最新字典/开关
      this.applySubgraphButtonI18n(isTranslationEnabled());

      // 关闭状态下继续监听之后打开的子图节点 DOM
      if (isTranslationEnabled()) this.stopDisabledNodeDomWatch();
      else this.watchDisabledNodeDom();
    } catch (e) {
      error("切换语言失败:", e);
    }
  }

  /**
   * 实时启用/关闭翻译：恢复原文后按开关重新应用。
   */
  static async setTranslationEnabled(enabled) {
    try {
      // 先停掉旧的子图 DOM/按钮观察器，避免恢复过程中重复触发
      this.stopDisabledNodeDomWatch();
      this.stopEnabledSubgraphButtonsWatch();
      this.stopSubgraphButtonWatch();

      const graph = (window.comfyAPI?.app?.app || window.app)?.graph;
      const nodes = this.collectAllNodes(graph);

      // 关闭前保存「中文译文 → 英文原文」，用于关闭后强制刷新 Nodes 2.0 DOM
      const reverse = new Map();
      try {
        const dict = this.T || {};
        for (const [en, zh] of Object.entries(dict.Menu || {})) {
          if (typeof en === "string" && typeof zh === "string" && en && zh && en !== zh && !reverse.has(zh)) {
            reverse.set(zh, en);
          }
        }
        for (const nd of Object.values(dict.Nodes || {})) {
          if (!nd || typeof nd !== "object") continue;
          for (const sec of ["inputs", "outputs", "widgets", "options"]) {
            for (const [k, v] of Object.entries(nd[sec] || {})) {
              if (typeof v === "string" && v && v !== k && !reverse.has(v)) reverse.set(v, k);
            }
          }
        }
      } catch (e) { /* 忽略 */ }

      // 必须先停掉旧字典的观察器：否则恢复后的英文会在等待 syncTranslation
      // 的异步期间被旧观察器重新翻译，且原文账本已清，之后就再也恢复不了。
      stopMenuTranslation();
      TUtils._dragObserver?.disconnect?.();
      TUtils._dragObserver = null;

      restoreDomTranslations();
      for (const node of nodes) this.restoreNodeDisplay(node);

      await this.syncTranslation();
      // 早期请求可能拿到不完整字典（Nodes 为空），开启时再强制同步一次
      if (isTranslationEnabled() && (!this.T?.Nodes || Object.keys(this.T.Nodes).length === 0)) {
        await this.syncTranslation();
      }

      // 节点原型标题按新状态/语言重新应用（关闭时恢复英文）
      this.applyNodeTypeTranslation(window.comfyAPI?.app?.app || window.app);
      // 节点定义的 display_name 同步切换（搜索索引读取该字段）
      this.applyVueNodeDefTranslations();
      // 主动重建搜索索引，英文界面下也能直接中文搜索
      this.refreshNodeSearchIndex();

      if (enabled && isTranslationEnabled()) {
        const app = window.comfyAPI?.app?.app || window.app;
        const applyNode = (node) => {
          if (!node || this.isSubgraphNode(node)) return;
          // 强制重跑：子图内部节点可能是在关闭状态下创建的，需要清掉去重标记
          delete node._uiiaiii_apply_state;
          this.applyNodeTranslation(node);
        };
        for (const node of nodes) applyNode(node);
        // app.graph 可能只覆盖根图；当前正在编辑的子图要单独遍历
        const currentGraph = app?.canvas?.graph;
        if (currentGraph && currentGraph !== app?.graph) {
          for (const node of this.collectAllNodes(currentGraph)) applyNode(node);
        }
        // 让子图入口按钮首帧就是中文，避免退出子图后再补翻译造成刷新
        this.applySubgraphButtonI18n(true);
        this.watchEnabledSubgraphButtons();
        applyMenuTranslation(this.T);
        translateAllDom(this.T);
        // Nodes 2.0 控件 DOM 是异步渲染的：首轮同步可能错过，
        // 下一帧和稍后再补一次，避免开关翻译后控件名丢失
        requestAnimationFrame(() => this.syncNodeDomLabels(nodes));
        setTimeout(() => this.syncNodeDomLabels(nodes), 150);
        setTimeout(() => this.syncNodeDomLabels(nodes), 500);
        // 子图入口按钮由节点 DOM 渲染，开启后补扫一次，覆盖异步渲染
        this.syncSubgraphButtons();
        this.syncNodeActionButtons();
        setTimeout(() => this.syncSubgraphButtons(), 300);
        setTimeout(() => this.syncSubgraphButtons(), 800);
        setTimeout(() => this.syncNodeActionButtons(), 300);
        setTimeout(() => this.syncNodeActionButtons(), 800);
      } else {
        // 恢复子图按钮的 i18n 原文，避免开启时覆盖的中文残留
        this.applySubgraphButtonI18n(false);
        // 关闭后立即、下一帧和稍后再强制恢复节点 DOM，
        // 覆盖 Nodes 2.0 组件缓存的标题/控件名译文
        const skipSubgraphIds = new Set(
          nodes.filter(node => this.isSubgraphNode(node)).map(node => String(node.id))
        );
        const syncDom = () => {
          restoreNodeDomText(reverse, skipSubgraphIds);
          this.restoreNodeDomToEnglish(nodes);
        };
        syncDom();
        requestAnimationFrame(syncDom);
        setTimeout(syncDom, 80);
        setTimeout(syncDom, 250);

        // 子图可能在关闭翻译之后才打开，监听内部节点 DOM 新增并补做恢复
        this.watchDisabledNodeDom();
      }
      // 触发下拉控件重新计算显示值（Nodes 2.0 缓存需要响应式更新）
      this.refreshComboWidgets(nodes);
      this.syncComboDomLabels(nodes);
      this.syncNodeDomLabels(nodes);
      graph?.setDirtyCanvas?.(true, true);
      // 节点画布/下拉控件：强制重绘，避免关闭翻译后控件显示值要点击一次才更新
      if (graph?._nodes) {
        for (const node of graph._nodes) node?.setDirtyCanvas?.(true, true);
      }
      const comfyApp = window.comfyAPI?.app?.app || window.app;
      comfyApp?.canvas?.setDirty?.(true, true);
      comfyApp?.canvas?.draw?.(true, true);
      // 节点渲染器/组件更新是异步的：下一帧再强制重绘一次，
      // 确保下拉当前值不会停留在旧语言的画面缓存里
      requestAnimationFrame(() => {
        this.syncComboDomLabels(nodes);
        this.syncNodeDomLabels(nodes);
      this.syncNodeDomLabels(nodes);
        graph?.setDirtyCanvas?.(true, true);
        comfyApp?.canvas?.setDirty?.(true, true);
        comfyApp?.canvas?.draw?.(true, true);
      });
      const prevCats = TUtils._dictCache?.[currentConfig.locale]?.NodeCategory || {};
      window.dispatchEvent(new CustomEvent("uiiaiii-translation-state-changed", {
        detail: { enabled: isTranslationEnabled(), previousCategories: prevCats }
      }));
    } catch (e) {
      error("切换翻译状态失败:", e);
    }
  }

  /**
   * 触发下拉控件的响应式刷新。
   * Nodes 2.0 / Vue 渲染的节点会缓存下拉当前值的显示文本，关闭翻译或
   * 切换语言后仅重绘画布不会更新，必须让组件重新计算一次。
   */
  static refreshComboWidgets(nodes) {
    for (const node of nodes || []) {
      const widgets = node?.widgets;
      if (!Array.isArray(widgets)) continue;
      for (const w of widgets) {
        if (!w || w.type !== "combo") continue;
        if (w.options && Array.isArray(w.options.values)) {
          // 重新赋值数组引用，触发 Vue 的响应式依赖更新
          w.options.values = w.options.values.slice();
        }
        // 替换 getOptionLabel 引用（内部仍调用原函数），让依赖它的
        // 下拉组件重新计算当前值；每次切换都换新引用以触发更新
        if (w.options && typeof w.options.getOptionLabel === "function") {
          const base = w.options.getOptionLabel._uiiaiii_base || w.options.getOptionLabel;
          const wrapped = (value) => base(value);
          wrapped._uiiaiii_base = base;
          w.options.getOptionLabel = wrapped;
        }
      }
    }
  }

  /**
   * 取节点字段的译文：节点级字典优先，全局 Menu 兜底。
   * 2.0 和经典模式必须共用这一个入口，保证同一字段只出现一种译文。
   */
  static getNodeFieldTranslation(node, section, name) {
    try {
      if (!name || !this.T) return null;
      const cls = node?.constructor?.comfyClass || node?.constructor?.type;
      const dict = cls && this.T.Nodes ? this.T.Nodes[cls] : null;
      const lookup = (key) => {
        const value = dict?.[section]?.[key];
        return (typeof value === "string" && value) ? value : null;
      };
      let translated = lookup(name);
      if (!translated && String(name).includes(".")) {
        translated = lookup(String(name).split(".").pop());
      }
      if (!translated) translated = this.T.Menu?.[name] || null;
      return translated;
    } catch (e) {
      return null;
    }
  }

  /**
   * 2.0 节点 DOM 文本覆盖：控件名、输入/输出端口名直接使用节点级字典译文。
   * 插件自带的英文/中文 label 不作为最终显示，保证与经典模式一致。
   */
  static syncNodeDomLabels(nodes) {
    if (!isTranslationEnabled()) return;
    try {
      const allNodes = this.collectAllNodes({ _nodes: nodes });
      const rootMap = this.getNodeDomRootMap();
      for (const node of allNodes) {
        if (!node || node.id === undefined) continue;
        // 子图内部节点可能与主图节点使用相同 id，处理该 id 下全部匹配的 DOM 根
        const roots = rootMap.get(String(node.id)) || [];
        if (!roots.length) continue;

        if (this.isSubgraphNode(node)) {
          // 子图自定义接口不翻译，但容器底部的入口操作按钮要翻译。
          // 只处理按钮的文本节点，兼容 "Enter" / "Enter subgraph" 和无 span 的版本。
          for (const root of roots) {
            const enterBtn = this.findSubgraphButton(root);
            if (!enterBtn) continue;
            this.translateSubgraphButtonText(enterBtn);
            // 组件重渲染可能用 i18n 英文覆盖文本，观察覆盖后重译
            this.watchSubgraphButton(enterBtn);
          }
          continue;
        }

        for (const root of roots) {
          // 控件名标签
          for (const wEl of root.querySelectorAll('[data-testid="node-widget"][data-widget-name]')) {
            const name = wEl.getAttribute("data-widget-name");
            const labelEl = wEl.querySelector('[data-testid="widget-layout-field-label"]');
            if (!labelEl || !name) continue;
            const widget = (node.widgets || []).find(item => item && item.name === name);
            if (this.isUserCustomLabel(widget)) continue;
            const translated = this.getNodeFieldTranslation(node, "widgets", name);
            if (translated && labelEl.textContent !== translated) {
              labelEl.textContent = translated;
            }
          }

          // 输入/输出端口名
          for (const slotEl of root.querySelectorAll(".lg-slot--input, .lg-slot--output")) {
            const dot = slotEl.querySelector("[data-slot-key]");
            const key = dot?.getAttribute("data-slot-key") || "";
            const isInput = slotEl.classList.contains("lg-slot--input");
            const match = key.match(isInput ? /-in-(\d+)$/ : /-out-(\d+)$/);
            if (!match) continue;
            const index = parseInt(match[1], 10);
            const slot = (isInput ? node.inputs : node.outputs)?.[index];
            if (!slot || typeof slot.name !== "string") continue;
            if (this.isUserCustomLabel(slot)) continue;
            const translated = this.getNodeFieldTranslation(node, isInput ? "inputs" : "outputs", slot.name);
            if (!translated) continue;
            const labelEl = slotEl.querySelector(".editable-text span") || slotEl.querySelector("span");
            if (labelEl && labelEl.textContent !== translated) {
              labelEl.textContent = translated;
            }
          }
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 只翻译按钮内的文本节点，跳过图标字体元素。
   * 部分版本的子图按钮没有 span，textContent 会混入图标字符，
   * 不能直接用整个按钮的 textContent 查字典。
   */
  static translateSubgraphButtonText(btn) {
    if (!btn) return false;
    let changed = false;
    try {
      const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent) continue;
        if (parent.closest("i, svg, [class*='icon-'], [class*='lucide']")) continue;
        const raw = node.nodeValue || "";
        const key = raw.trim();
        if (!key) continue;
        const translated = TUtils.T?.Menu?.[key];
        if (translated && translated !== key) {
          node.nodeValue = raw.replace(key, translated);
          if (!btn.dataset.uiiaiiiOrigText) btn.dataset.uiiaiiiOrigText = key;
          changed = true;
        }
      }
    } catch (e) { /* 忽略 */ }
    return changed;
  }

  /**
   * 覆盖 ComfyUI i18n 中「进入/退出子图」按钮的文案。
   * 按钮由 Vue 的 t() 渲染，只做 DOM 后置翻译一定会先显示英文再变中文；
   * 开启时直接改 i18n 消息，让按钮首次渲染就是目标语言，退出子图不再闪。
   */
  /**
   * 从 Vue app 的 provides 中找真实的 vue-i18n composer。
   * app.config.globalProperties.$i18n 在当前前端只是 locale 字符串，不能用于改消息。
   */
  static getAppI18nComposer() {
    try {
      const app = document.querySelector("#vue-app")?.__vue_app__;
      const provides = app?._context?.provides;
      if (!provides) return null;
      for (const key of Reflect.ownKeys(provides)) {
        const value = provides[key];
        if (!value || typeof value !== "object") continue;
        if (typeof value.mergeLocaleMessage === "function" && value.locale) {
          return value;
        }
        if (value.global && typeof value.global.mergeLocaleMessage === "function") {
          return value.global;
        }
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  static applySubgraphButtonI18n(enabled) {
    try {
      const composer = this.getAppI18nComposer();
      if (!composer) return;

      const locale = composer.locale?.value || "en";
      if (!TUtils._i18nBtnOrig) TUtils._i18nBtnOrig = {};
      if (!TUtils._i18nBtnOrig[locale]) {
        const g = composer.getLocaleMessage?.(locale)?.g || {};
        TUtils._i18nBtnOrig[locale] = {
          enter: g.enter,
          enterSubgraph: g.enterSubgraph
        };
      }

      if (enabled) {
        const menu = TUtils.T?.Menu || {};
        composer.mergeLocaleMessage(locale, {
          g: {
            enter: menu["Enter"] || "进入",
            enterSubgraph: menu["Enter subgraph"] || "进入子图"
          }
        });
      } else {
        composer.mergeLocaleMessage(locale, { g: TUtils._i18nBtnOrig[locale] });
      }
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 开启翻译时监听子图按钮 DOM 新增。
   * MutationObserver 在浏览器绘制前执行，插入时立即翻译，
   * 这样退出子图后按钮第一帧就是中文，不需要等 120ms 的补扫。
   */
  static watchEnabledSubgraphButtons() {
    try {
      if (this._enabledBtnObserver) return;
      const observer = new MutationObserver((mutations) => {
        if (!isTranslationEnabled()) return;
        for (const m of mutations) {
          for (const n of m.addedNodes || []) {
            if (n.nodeType !== 1) continue;
            const buttons = [];
            if (n.matches?.('[data-testid="subgraph-enter-button"]')) buttons.push(n);
            n.querySelectorAll?.('[data-testid="subgraph-enter-button"]').forEach((b) => buttons.push(b));
            for (const btn of buttons) {
              if (!btn.closest(".lg-node")) continue;
              TUtils.translateSubgraphButtonText(btn);
              TUtils.watchSubgraphButton(btn);
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      this._enabledBtnObserver = observer;
    } catch (e) { /* 忽略 */ }
  }

  static stopEnabledSubgraphButtonsWatch() {
    try { this._enabledBtnObserver?.disconnect?.(); } catch (e) { /* 忽略 */ }
    this._enabledBtnObserver = null;
  }

  /**
   * 对当前正在编辑的图（可能是多层子图）补一次节点翻译。
   * 子图内部节点是 canvas 绘制，进入更深层时不会触发 DOM 同步，
   * 需要在视图切换后按节点去重状态补跑。
   */
  static syncCurrentGraphTranslations() {
    if (!isTranslationEnabled()) return;
    try {
      const app = window.comfyAPI?.app?.app || window.app;
      const seen = new Set();
      for (const graph of [app?.canvas?.graph, app?.graph]) {
        for (const node of this.collectAllNodes(graph)) {
          if (!node || seen.has(node)) continue;
          seen.add(node);
          if (this.isSubgraphNode(node)) continue;
          this.applyNodeTranslation(node);
        }
      }
      app?.canvas?.setDirty?.(true, true);
      app?.graph?.setDirtyCanvas?.(true, true);
      app?.canvas?.draw?.(true, true);
    } catch (e) { /* 忽略 */ }
  }

  /** 取按钮真实文本，跳过图标字体元素 */
  static getButtonText(btn) {
    if (!btn) return "";
    let text = "";
    try {
      const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (parent?.closest("i, svg, [class*='icon-'], [class*='lucide']")) continue;
        text += node.nodeValue || "";
      }
    } catch (e) { /* 忽略 */ }
    return text.trim();
  }

  /** 翻译节点上的操作按钮（Issues / Show advanced / Hide advanced inputs 等） */
  static syncNodeActionButtons() {
    if (!isTranslationEnabled()) return;
    try {
      document.querySelectorAll(".lg-node button, .lg-node [role='button']").forEach((btn) => {
        // 控件内部按钮交给控件/下拉翻译，避免误改值显示
        if (btn.closest('[data-testid="node-widget"], .lg-node-widget')) return;
        const text = this.getButtonText(btn);
        if (!text) return;
        if (!this.T?.Menu?.[text] && !/^(Enter|Exit)( subgraph)?$/i.test(text)) return;
        this.translateSubgraphButtonText(btn);
        this.watchSubgraphButton(btn);
      });
    } catch (e) { /* 忽略 */ }
  }

  /** 扫描当前 DOM 中全部子图入口按钮并翻译（进入/退出子图后补一次） */
  static syncSubgraphButtons() {
    if (!isTranslationEnabled()) return;
    try {
      let buttons = Array.from(
        document.querySelectorAll('[data-testid="subgraph-enter-button"]')
      );
      if (!buttons.length) {
        buttons = Array.from(document.querySelectorAll("button")).filter((btn) =>
          /^(Enter|Exit)( subgraph)?$/i.test((btn.textContent || "").trim())
        );
      }
      for (const btn of buttons) {
        if (!btn.closest(".lg-node")) continue;
        this.translateSubgraphButtonText(btn);
        this.watchSubgraphButton(btn);
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 查找子图入口按钮（兼容不同版本是否有 data-testid） */
  static findSubgraphButton(root) {
    if (!root) return null;
    try {
      const known = root.querySelector('[data-testid="subgraph-enter-button"]');
      if (known) return known;
      return Array.from(root.querySelectorAll("button")).find((btn) =>
        /^(Enter|Exit)( subgraph)?$/i.test((btn.textContent || "").trim())
      ) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 子图按钮文案由 Vue 的 i18n 渲染，组件重渲染时可能用英文覆盖 DOM 译文。
   * 观察按钮文本，一旦被覆盖立即重新翻译。
   */
  static watchSubgraphButton(btn) {
    if (!btn || btn._uiiaiii_btn_watch) return;
    btn._uiiaiii_btn_watch = true;
    try {
      const observer = new MutationObserver(() => {
        if (!isTranslationEnabled()) return;
        // 组件重渲染可能用 i18n 英文覆盖文本；只处理文本节点，忽略图标
        TUtils.translateSubgraphButtonText(btn);
      });
      observer.observe(btn, { childList: true, characterData: true, subtree: true });
      if (!TUtils._subgraphBtnObservers) TUtils._subgraphBtnObservers = new Set();
      TUtils._subgraphBtnObservers.add(observer);
    } catch (e) { /* 忽略 */ }
  }

  static stopSubgraphButtonWatch() {
    try {
      for (const observer of this._subgraphBtnObservers || []) observer.disconnect();
    } catch (e) { /* 忽略 */ }
    this._subgraphBtnObservers = null;
  }

  /** 一次性收集全部节点 DOM 根并按 id 分组，避免逐节点做全文档查询 */
  static getNodeDomRootMap() {
    const map = new Map();
    try {
      document.querySelectorAll("[data-node-id]").forEach((el) => {
        const id = String(el.dataset.nodeId || "");
        if (!id) return;
        const list = map.get(id);
        if (list) list.push(el);
        else map.set(id, [el]);
      });
    } catch (e) { /* 忽略 */ }
    return map;
  }

  /** 用户手动改过的端口/控件名：有自定义 label 且不是插件写入的译文标记 */
  static isUserCustomLabel(item) {
    if (!item) return false;
    if (item._uiiaiii_label !== undefined || item._uiiaiii_applied !== undefined) return false;
    const label = item.label;
    if (typeof label !== "string" || !label || label === item.name) return false;
    // 命中字典译文的 label 是翻译残留，不是用户自定义，关闭时要恢复
    if (isAlreadyTranslatedText(label)) return false;
    return true;
  }

  /**
   * 关闭翻译时按节点数据强制恢复英文：
   * 端口名/控件名直接使用 name（或插件的英文 label），不依赖反向字典。
   * 用户手动改过的中文 label 保留。
   */
  static restoreNodeDomToEnglish(nodes) {
    try {
      const rootMap = this.getNodeDomRootMap();
      for (const node of nodes || []) {
        if (!node || node.id === undefined) continue;
        // 子图内部节点可能与主图节点使用相同 id，处理该 id 下全部匹配的 DOM 根
        const roots = rootMap.get(String(node.id)) || [];
        if (!roots.length) continue;

        if (this.isSubgraphNode(node)) {
          // 子图接口保持用户命名，只恢复容器入口按钮。
          // 优先用记录的原本文案，兼容 "Enter" / "Enter subgraph"。
          for (const root of roots) {
            const enterBtn = this.findSubgraphButton(root);
            if (!enterBtn) continue;
            const orig = enterBtn.dataset.uiiaiiiOrigText || "Enter subgraph";
            const walker = document.createTreeWalker(enterBtn, NodeFilter.SHOW_TEXT);
            let textNode;
            while ((textNode = walker.nextNode())) {
              const parent = textNode.parentElement;
              if (parent?.closest("i, svg, [class*='icon-'], [class*='lucide']")) continue;
              if (TUtils.containsCjk(textNode.nodeValue || "")) {
                textNode.nodeValue = orig;
              }
            }
          }
          continue;
        }

        for (const root of roots) {
          // 节点标题：把已知译文恢复为英文原名（2.0 标题是 DOM 文本）
          if (!node._translation_custom_title) {
            const header = root.querySelector('[data-testid^="node-header-"]');
            if (header) {
              const englishTitle = node.constructor?._uiiaiii_orig_title
                || node.constructor?.comfyClass
                || node.constructor?.type;
              if (englishTitle) {
                const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
                let textNode;
                while ((textNode = walker.nextNode())) {
                  const value = textNode.nodeValue;
                  const key = value && value.trim();
                  if (key && isAlreadyTranslatedText(key)) {
                    textNode.nodeValue = value.replace(key, englishTitle);
                  }
                }
              }
            }
          }

          for (const wEl of root.querySelectorAll('[data-testid="node-widget"][data-widget-name]')) {
            const name = wEl.getAttribute("data-widget-name");
            const labelEl = wEl.querySelector('[data-testid="widget-layout-field-label"]');
            if (!labelEl || !name) continue;
            const widget = (node.widgets || []).find(item => item && item.name === name);
            if (this.isUserCustomLabel(widget)) continue;
            const label = widget?.label;
            const english = (typeof label === "string" && label && !isAlreadyTranslatedText(label))
              ? label
              : (widget?.name || name);
            if (labelEl.textContent !== english) labelEl.textContent = english;
          }

          for (const slotEl of root.querySelectorAll(".lg-slot--input, .lg-slot--output")) {
            const dot = slotEl.querySelector("[data-slot-key]");
            const key = dot?.getAttribute("data-slot-key") || "";
            const isInput = slotEl.classList.contains("lg-slot--input");
            const match = key.match(isInput ? /-in-(\d+)$/ : /-out-(\d+)$/);
            if (!match) continue;
            const index = parseInt(match[1], 10);
            const slot = (isInput ? node.inputs : node.outputs)?.[index];
            if (!slot || typeof slot.name !== "string") continue;
            if (this.isUserCustomLabel(slot)) continue;
            const labelEl = slotEl.querySelector(".editable-text span") || slotEl.querySelector("span");
            if (labelEl && labelEl.textContent !== slot.name) {
              labelEl.textContent = slot.name;
            }
          }
        }
      }
      // 节点操作按钮（Issues / Show advanced 等）恢复原始英文文案
      try {
        document.querySelectorAll(
          ".lg-node button[data-uiiaiii-orig-text], .lg-node [role='button'][data-uiiaiii-orig-text]"
        ).forEach((btn) => {
          const orig = btn.dataset.uiiaiiiOrigText;
          if (!orig) return;
          const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
          let textNode;
          while ((textNode = walker.nextNode())) {
            const parent = textNode.parentElement;
            if (parent?.closest("i, svg, [class*='icon-'], [class*='lucide']")) continue;
            if (TUtils.containsCjk(textNode.nodeValue || "")) {
              textNode.nodeValue = orig;
            }
          }
        });
      } catch (e) { /* 忽略 */ }

      // 下拉当前值恢复为英文（复用同一次 DOM 扫描结果）
      this.syncComboDomLabels(nodes, rootMap);
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 直接同步节点下拉控件在 DOM 中显示的当前值。
   * 新版 Nodes 2.0 的 combo 控件由 DOM/渲染器缓存显示文本，数据层恢复后
   * 画面仍可能停留在旧语言；这里按 widget 的当前值直接修正可见文本。
   */
  static syncComboDomLabels(nodes, rootMap = null) {
    try {
      const menu = window.__UiTranslated?.Menu || {};
      const enabled = isTranslationEnabled();
      const rootsById = rootMap || this.getNodeDomRootMap();
      for (const node of nodes || []) {
        if (!node || node.id === undefined) continue;
        if (this.isSubgraphNode(node)) continue;
        // 子图内部节点可能与主图节点使用相同 id，处理全部匹配的 DOM 根
        const roots = rootsById.get(String(node.id)) || [];
        if (!roots.length) continue;
        for (const root of roots) {
          for (const w of node.widgets || []) {
            if (!w || w.type !== "combo" || typeof w.name !== "string" || !w.name) continue;
            let text;
            if (enabled) {
              text = this.getNodeFieldTranslation(node, "options", String(w.value));
              if (text === undefined || text === null) text = menu[w.value];
              if (text === undefined && typeof w.options?.getOptionLabel === "function") {
                try { text = w.options.getOptionLabel(w.value); } catch (e) { /* ignore */ }
              }
            }
            if (text === undefined || text === null || text === "") {
              text = w._displayValue ?? w.value;
            }
            if (text === undefined || text === null) continue;
            const escapedName = (typeof CSS !== "undefined" && CSS.escape)
              ? CSS.escape(w.name)
              : String(w.name).replace(/["\\]/g, "\\$&");
            const selector = `button[aria-label="${escapedName}"]`;
            const btn = root.querySelector(selector);
            if (!btn) continue;
            const span = btn.querySelector("span");
            if (span && span.textContent !== String(text)) {
              span.textContent = String(text);
            }
          }
        }
      }
    } catch (e) { /* 忽略，不影响切换 */ }
  }

  /**
   * 收集主图 + 子图内部的全部节点。
   * 子图容器本身跳过翻译，但内部节点需要正常翻译。
   */
  static collectAllNodes(graph) {
    const result = [];
    const seen = new Set();
    const walk = (list) => {
      for (const node of list || []) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        result.push(node);
        if (node.subgraph && Array.isArray(node.subgraph._nodes)) {
          walk(node.subgraph._nodes);
        }
      }
    };
    walk(graph?._nodes);
    return result;
  }

  /** 合并节点加载后的补翻译/补恢复，避免每个节点各自定时造成多次可见刷新 */
  static scheduleNodeBatch(node) {
    try {
      if (node) {
        if (!this._nodeBatch) this._nodeBatch = new Set();
        this._nodeBatch.add(node);
      }
      clearTimeout(this._nodeBatchTimer);
      this._nodeBatchTimer = setTimeout(() => this.flushNodeBatch(), 250);

      // 下一帧先同步一次 DOM 文本，尽量在首帧内完成，减少可见刷新；
      // 250ms 的批量仍保留，用于覆盖插件随后动态改写的 label。
      if (!this._nodeBatchRaf) {
        this._nodeBatchRaf = requestAnimationFrame(() => {
          this._nodeBatchRaf = null;
          const nodes = Array.from(this._nodeBatch || []);
          if (!nodes.length) return;
          try {
            if (isTranslationEnabled()) this.syncNodeDomLabels(nodes);
            else this.restoreNodeDomToEnglish(nodes);
          } catch (e) { /* 忽略 */ }
        });
      }
    } catch (e) { /* 忽略 */ }
  }

  static flushNodeBatch() {
    this._nodeBatchTimer = null;
    const nodes = Array.from(this._nodeBatch || []);
    this._nodeBatch?.clear();
    if (!nodes.length) return;
    try {
      // nodeCreated/loadedGraphNode 已同步应用过翻译，批量只补轻量 widget 检查，
      // 避免整批节点再做一次 inputs/outputs 全量计算
      for (const node of nodes) this.translateNodeWidgetLabels(node);
      if (isTranslationEnabled()) this.syncNodeDomLabels(nodes);
      else this.restoreNodeDomToEnglish(nodes);
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 关闭翻译后，子图往往是之后才打开的：内部节点 DOM 新插入时补做一次英文恢复。
   * 只处理新增的节点 DOM；新增内容本身没有中文时直接跳过，避免无谓写入。
   * 观察器保持到重新开启翻译为止。
   */
  static watchDisabledNodeDom() {
    try {
      if (this._disabledDomObserver) return;
      const pendingRoots = new Set();
      const observer = new MutationObserver((mutations) => {
        if (isTranslationEnabled()) {
          this.stopDisabledNodeDomWatch();
          return;
        }
        for (const m of mutations) {
          for (const n of m.addedNodes || []) {
            if (n.nodeType !== 1) continue;
            if (n.matches?.("[data-node-id]")) pendingRoots.add(n);
            n.querySelectorAll?.("[data-node-id]").forEach((el) => pendingRoots.add(el));
          }
        }
        if (!pendingRoots.size) return;

        clearTimeout(this._disabledDomTimer);
        this._disabledDomTimer = setTimeout(() => {
          const roots = Array.from(pendingRoots);
          pendingRoots.clear();
          if (isTranslationEnabled()) return;
          try {
            // 新增 DOM 已经是英文时不做任何写入，切工作流/进出子图不会有可见刷新
            if (!roots.some((el) => TUtils.containsCjk(el.textContent || ""))) return;

            const app = window.comfyAPI?.app?.app || window.app;
            const allNodes = this.collectAllNodes(app?.graph);
            const ids = new Set(roots.map((el) => String(el.dataset.nodeId || "")));
            const affected = allNodes.filter((node) => ids.has(String(node.id)));
            const targets = affected.length ? affected : allNodes;
            for (const node of targets) this.applyNodeTranslation(node);
            this.restoreNodeDomToEnglish(targets);
          } catch (e) { /* 忽略 */ }
        }, 120);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      this._disabledDomObserver = observer;
    } catch (e) { /* 忽略 */ }
  }

  static stopDisabledNodeDomWatch() {
    try {
      this._disabledDomObserver?.disconnect?.();
    } catch (e) { /* 忽略 */ }
    this._disabledDomObserver = null;
    clearTimeout(this._disabledDomTimer);
    this._disabledDomTimer = null;
  }

  /** 关闭翻译时快速判断节点是否残留译文/翻译标记 */
  static nodeHasTranslationResidue(node) {
    try {
      if (!node) return false;
      if (node._uiiaiii_title !== undefined || node._original_title !== undefined) return true;
      if (typeof node.title === "string"
          && (this.containsCjk(node.title) || isAlreadyTranslatedText(node.title))) return true;

      for (const key of ["inputs", "outputs", "widgets"]) {
        const list = node[key];
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (!item) continue;
          if (item._uiiaiii_label !== undefined || item._uiiaiii_applied !== undefined
              || item._uiiaiii_tl_orig !== undefined || item._original_name) return true;
          if (typeof item.label === "string"
              && (this.containsCjk(item.label) || isAlreadyTranslatedText(item.label))) return true;
          if (typeof item.localized_name === "string" && isAlreadyTranslatedText(item.localized_name)) return true;
        }
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  static applyNodeTranslation(node) {
    try {
      if (!node || !node.constructor) return;

      let keys = ["inputs", "outputs", "widgets"];
      let nodesT = this.T.Nodes;
      let class_type = node.constructor.comfyClass ? node.constructor.comfyClass : node.constructor.type;
      
      if (!class_type) return;

      // 子图容器：端口/控件名由子图输入定义决定，禁止套用字典翻译，
      // 同时纠正历史版本写入容器的译文（如把"步数"改成"步进"）
      if (this.isSubgraphNode(node)) {
        this.syncSubgraphHostLabels(node);
        return;
      }

      // 开关/字典未变化时跳过完整翻译（退出/再次进入子图不重复处理同一节点）
      const applyState = `${isTranslationEnabled() ? 1 : 0}:${TUtils._dictVersion || 0}`;
      if (node._uiiaiii_apply_state === applyState) return;

      // 关闭翻译且没有任何中文残留时，无需逐字段恢复
      if (!isTranslationEnabled() && !this.nodeHasTranslationResidue(node)) {
        node._uiiaiii_apply_state = applyState;
        return;
      }

      // 原型标题可能已按搜索需要改成中文；实例标题恢复英文，显示层用 _uiiaiii_title
      this.normalizeNodeInstanceTitle(node);

      // Agnes / Qwen 图像节点：参考图插槽逐级展开（AgnesVideo 还含参考音频）
      if (["AgnesVideo", "AgnesImage", "QwenImageEdit", "QwenImage21", "MiniMaxH3Image"].includes(class_type)) {
        this.setupGrowableInputs(node);
      }

      if (!isTranslationEnabled()) {
        for (let key of keys) {
          // 子蓝图内部节点的 inputs/outputs 可能来自原型/投影，不能用 own property 限制
          if (!Array.isArray(node[key])) continue;
          node[key].forEach((item) => {
            if (!item) return;

            // 用户手动改过显示名：保留用户输入，只清理我们的标记
            const changedByUser = item._uiiaiii_orig_label !== undefined
              && typeof item.label === "string"
              && item._uiiaiii_applied !== undefined
              && item.label !== item._uiiaiii_applied;
            if (changedByUser) {
              delete item._uiiaiii_orig_label;
              delete item._uiiaiii_label;
              delete item._uiiaiii_applied;
              delete item._original_name;
              return;
            }

            // 首帧写入的译文：恢复记录下来的原始英文 label
            if (item._uiiaiii_orig_label !== undefined) {
              this.restoreDisplayLabel(item);
            } else {
              delete item._uiiaiii_label;
            }

            // 清理工作流中残留的翻译显示名
            if (typeof item.localized_name === "string" && isAlreadyTranslatedText(item.localized_name)) {
              delete item.localized_name;
            }
            if (item._original_name) {
              this.restoreOriginalTranslation(item);
            } else if (typeof item.label === "string" && item.label !== item.name && isAlreadyTranslatedText(item.label)) {
              // 无原文记录、但 label 是已知译文（工作流里残留的旧译文）→ 回退为英文原名
              item.label = item.name;
            }
          });
        }

        // 标题还原：优先恢复首帧写入前的原始英文标题
        this.restoreNodeTitleDisplay(node);
        // 若工作流里残留的是旧译文标题，一并回退为英文原名
        if (!node._translation_custom_title && node.title && isAlreadyTranslatedText(node.title)) {
          node.title = node._original_title
            || node.constructor._uiiaiii_orig_title
            || node.constructor.comfyClass
            || node.constructor.type;
        }
        delete node._original_title;
        node._uiiaiii_apply_state = applyState;
        return;
      }
      
      // 即使该节点类型没有 Nodes 字典条目也继续：前端动态创建的控件文案可能只在 Menu 字典中
      var t = (nodesT && nodesT[class_type]) || {};

      // 把在场节点类的字段名→译文合并进 Menu。
      // Nodes 2.0 在英文界面下不会加载官方 nodeDefs，控件名/端口名只能靠
      // DOM 翻译器查 Menu；不合并时 bit_depth/codec 等会一直显示英文。
      if (t && this.T && this.T.Menu) {
        for (const section of ["inputs", "outputs", "widgets", "options"]) {
          const kv = t[section];
          if (!kv || typeof kv !== "object") continue;
          for (const [fieldKey, fieldValue] of Object.entries(kv)) {
            if (typeof fieldKey !== "string" || typeof fieldValue !== "string") continue;
            if (!fieldKey || !fieldValue || fieldKey === fieldValue) continue;
            if (fieldKey.length > 64 || fieldValue.length > 60) continue;
            if (fieldKey.includes(" ") && fieldKey.length > 40) continue;
            if (this.T.Menu[fieldKey] === undefined) {
              this.T.Menu[fieldKey] = fieldValue;
            }
          }
        }
      }

      for (let key of keys) {
        // 子蓝图内部节点的 inputs/outputs 可能来自原型/投影，不能用 own property 限制
        if (!Array.isArray(node[key])) continue;
        
        const dict = t[key] || {};
        node[key].forEach((item) => {
          if (!item || !item.name) return;
          // 下拉控件创建时即安装选项显示映射（弹层打开时直接显示译文）
          if (key === "widgets") TUtils.ensureComboOptionLabel(item);
          // 官方语言包/历史脏字典可能把 tooltip 整句写成控件名：撤销异常 label，
          // 否则 Nodes 2.0 会按文字宽度把节点撑得极长
          if (key === "widgets" && typeof item.label === "string"
              && this.isOversizedFieldLabel(item.name, item.label)) {
            delete item.label;
          }
          let translation = dict[item.name];
          // 端口/控件都额外查 Menu 兜底：子图内部节点或第三方节点
          // 可能只在 Menu 里有通用字段译文（如 video → 视频）
          if (!translation) {
            const menuT = this.T.Menu || {};
            translation = menuT[item.name] || (item.label && menuT[item.label]) || null;
            // 动态子字段（如 format.codec）按最后一段再查一次
            if (!translation && typeof item.name === "string" && item.name.includes(".")) {
              const tail = item.name.split(".").pop();
              translation = dict[tail] || menuT[tail] || null;
            }
          }
          if (translation && this.isOversizedFieldLabel(item.name, translation)) {
            translation = null;
          }
          if (translation) {
            if (key === "widgets") {
              // widgets 译文也只写 _uiiaiii_label，绘制时临时映射；
              // 不持久改写 label，避免任何序列化污染
              const hasNativeTranslation = item.label && isAlreadyTranslatedText(item.label) && !item._original_name;
              if (!hasNativeTranslation) {
                this.safeApplyTranslation(item, translation);
              }
            } else {
              // inputs/outputs：译文只存自定义属性 _uiiaiii_label，绝不写 slot.label，
              // 否则会被 LiteGraph 序列化进工作流 JSON 造成持久污染
              this.applySlotTranslation(item, translation);
            }
          }
        });
      }
      
      // 标题：节点级字典优先，其次用 Menu 里按类名/原型标题兜底
      const protoTitle = node.constructor?._uiiaiii_orig_title || node.constructor?.title;
      // 修正刷新/加载早期被误判为用户自定义的标题：当前标题若是原型英文或已知译文，应继续翻译
      if (node._translation_custom_title
          && (isAlreadyTranslatedText(node.title)
              || (t?.title && node.title === t.title)
              || (protoTitle && node.title === protoTitle)
              || (node.constructor?._uiiaiii_orig_title
                  && node.title === node.constructor._uiiaiii_orig_title))) {
        // 标题等于原型英文说明用户没有改名，之前是字典未就绪时误判的自定义标题
        delete node._translation_custom_title;
      }
      const titleT = (t.hasOwnProperty("title") ? t["title"] : null)
        || this.T.Menu?.[class_type]
        || (protoTitle ? this.T.Menu?.[protoTitle] : null);
      if (titleT) {
        // 首帧就写入真实 title，避免节点渲染后再改一次造成可见刷新；
        // 原始标题记录在 _uiiaiii_orig_title_instance，保存时由序列化补丁恢复。
        if (!node._translation_custom_title && !this.isCustomNodeTitle(node)) {
          this.applyNodeTitleDisplay(node, titleT);
        } else {
          delete node._uiiaiii_title;
          if (node._translation_custom_title) delete node._uiiaiii_orig_title_instance;
        }
      } else {
        delete node._uiiaiii_title;
      }
      
      // 输入钩子只包装一次：重复 apply 时不再层层嵌套闭包
      if (!node._uiiaiii_input_hooks_patched) {
        node._uiiaiii_input_hooks_patched = true;
        const baseAddInput = node.addInput;
        node.addInput = function (name, type, extra_info) {
          var oldInputs = [];
          if (this.inputs && Array.isArray(this.inputs)) {
            this.inputs.forEach((i) => oldInputs.push(i.name));
          }
          var res = baseAddInput.apply(this, arguments);
          if (this.inputs && Array.isArray(this.inputs)) {
            const widgetsT = TUtils.T.Nodes?.[this.comfyClass || this.type]?.widgets;
            this.inputs.forEach((i) => {
              if (oldInputs.includes(i.name)) return;
              if (widgetsT && i.widget?.name in widgetsT) {
                TUtils.applySlotTranslation(i, widgetsT[i.widget?.name]);
              }
            });
          }
          return res;
        };

        const baseOnInputAdded = node.onInputAdded;
        node.onInputAdded = function (slot) {
          let res;
          if (baseOnInputAdded) {
            res = baseOnInputAdded.apply(this, arguments);
          }
          const widgetsT = TUtils.T.Nodes?.[this.comfyClass || this.type]?.widgets;
          if (widgetsT && slot.name in widgetsT) {
            if (TUtils.needsTranslation(slot)) {
              TUtils.applySlotTranslation(slot, widgetsT[slot.name]);
            }
          }
          return res;
        };
      }

      // 拦截动态生成的小部件 (addWidget)，确保第三方插件动态添加的控件也能被翻译
      let addWidget = node.addWidget;
      if (addWidget && !node._addWidget_translated) {
        node.addWidget = function (type, name, value, callback, options) {
          // 先让底层创建控件
          let res = addWidget.apply(this, arguments);
          // 动态创建的控件：若为下拉，立即安装选项显示映射
          if (res) TUtils.ensureComboOptionLabel(res);
          // 控件创建完毕后立刻检查翻译
          if (isTranslationEnabled() && res && res.name) {
            let class_type = this.constructor.comfyClass || this.constructor.type;
            let dict = TUtils.T.Nodes[class_type];
            if (dict && dict["widgets"] && res.name in dict["widgets"]) {
              const widgetT = dict["widgets"][res.name];
              if (!TUtils.isOversizedFieldLabel(res.name, widgetT)) {
                TUtils.safeApplyTranslation(res, widgetT);
              }
            }
          }
          return res;
        };
        node._addWidget_translated = true; // 防止重复拦截
      }

      node._uiiaiii_apply_state = applyState;
    } catch (e) {
      error(`为节点 ${node?.title || '未知'} 应用翻译失败:`, e);
    }
  }

  static applyNodeDescTranslation(nodeType, nodeData, app) {
    try {
      const className = nodeType?.comfyClass || nodeType?.type;
      if (!TUtils._nodeDefOrigDescriptions) TUtils._nodeDefOrigDescriptions = new Map();
      if (!TUtils._nodeDefAppliedDescriptions) TUtils._nodeDefAppliedDescriptions = new Set();
      // 只记录后端英文原文；nodeData 可能被旧版本写成中文，这种值不能作为恢复源。
      // 绝不能改写 nodeData.description：前端随后会用同一份定义构造
      // ComfyNodeDefImpl，description 会被固化成只读 getter 的数据源。
      if (className && !TUtils._nodeDefOrigDescriptions.has(className)
          && typeof nodeData?.description === "string"
          && !TUtils.containsCjk(nodeData.description)) {
        TUtils._nodeDefOrigDescriptions.set(className, nodeData.description);
      }

      if (!isTranslationEnabled()) {
        if (className && TUtils._nodeDefAppliedDescriptions.has(className)) {
          const orig = TUtils._nodeDefOrigDescriptions.get(className);
          if (nodeType) {
            if (orig === undefined) delete nodeType.description;
            else nodeType.description = orig;
          }
          TUtils._nodeDefAppliedDescriptions.delete(className);
        }
        return;
      }
      
      let nodesT = this.T.Nodes;
      var t = nodesT[nodeType.comfyClass];
      if (t?.["description"]) {
        // 只改 LiteGraph 节点原型的描述（经典画布帮助/提示），
        // 显示层的中文由 store 实例上的 defineProperty 负责。
        if (nodeType) nodeType.description = t["description"];
        if (className) TUtils._nodeDefAppliedDescriptions.add(className);
      }

      if (t) {
        var nodeInputT = t["inputs"] || {};
        var nodeWidgetT = t["widgets"] || {};
        // 递归应用 tooltip 翻译（含 DynamicCombo 内嵌参数）
        var translateTooltip = function (nodeInputSection) {
          if (!nodeInputSection || typeof nodeInputSection !== 'object') return;
          for (let socketname in nodeInputSection) {
            let inp = nodeInputSection[socketname];
            if (!inp || !Array.isArray(inp) || inp.length < 2) continue;
            var opts = inp[1];
            if (opts && typeof opts === 'object') {
              if (opts.tooltip) {
                var tooltip = opts.tooltip;
                var tooltipT = nodeInputT[tooltip] || nodeWidgetT[tooltip] || tooltip;
                opts.tooltip = tooltipT;
              }
              // DynamicCombo：递归 options[].inputs.{required,optional}
              if (Array.isArray(opts.options)) {
                for (const option of opts.options) {
                  if (!option || typeof option !== 'object') continue;
                  const optionInputs = option.inputs;
                  if (!optionInputs || typeof optionInputs !== 'object') continue;
                  translateTooltip(optionInputs.required);
                  translateTooltip(optionInputs.optional);
                }
              }
            }
          }
        };
        for (let itype in nodeData.input) {
          translateTooltip(nodeData.input[itype]);
        }
        
        var nodeOutputT = t["outputs"] || {};
        for (var i = 0; i < (nodeData.output_tooltips || []).length; i++) {
          var tooltip = nodeData.output_tooltips[i];
          var tooltipT = nodeOutputT[tooltip] || tooltip;
          nodeData.output_tooltips[i] = tooltipT;
        }
      }
    } catch (e) {
      error(`为节点 ${nodeType?.comfyClass || '未知'} 应用描述翻译失败:`, e);
    }
  }

  static applyMenuTranslation(app) {
    try {
      if (!isTranslationEnabled()) return;
      applyMenuTranslation(TUtils.T);
      
      const dragHandle = app.ui.menuContainer.querySelector(".drag-handle");
      if (dragHandle && dragHandle.childNodes[1]) {
        // 该观察器独立于 MenuTranslate 的观察器集合，需单独保存以便关闭时断开
        TUtils._dragObserver?.disconnect?.();
        TUtils._dragObserver = observeFactory(dragHandle.childNodes[1], (mutationsList, observer) => {
          for (let mutation of mutationsList) {
            for (let node of mutation.addedNodes) {
              var match = node.data?.match(/(Queue size:) (\w+)/);
              if (match?.length == 3) {
                const t = TUtils.T.Menu[match[1]] ? TUtils.T.Menu[match[1]] : match[1];
                node.data = t + " " + match[2];
              }
            }
          }
        });
      }
    } catch (e) {
      error("应用菜单翻译失败:", e);
    }
  }

  static applyContextMenuTranslation(app) {
    try {
      if (!isTranslationEnabled()) return;
      
      var f = LGraphCanvas.prototype.getCanvasMenuOptions;
      LGraphCanvas.prototype.getCanvasMenuOptions = function () {
        var res = f.apply(this, arguments);
        let menuT = TUtils.T.Menu;
        for (let item of res) {
          if (item == null || !item.hasOwnProperty("content")) continue;
          if (item.content in menuT) {
            if (!item._originalContent) item._originalContent = item.content;
            item.content = menuT[item.content];
          }
        }
        return res;
      };
      
      // 节点右键菜单：同步翻译 Menu 字典中的词条
      // （官方只处理 contextMenu.* i18n 键，插件自定义词条在这里补，
      //  避免菜单展开后再做 DOM 文本替换）
      const getNodeMenuOptions = LGraphCanvas.prototype.getNodeMenuOptions;
      if (typeof getNodeMenuOptions === "function") {
        LGraphCanvas.prototype.getNodeMenuOptions = function () {
          const res = getNodeMenuOptions.apply(this, arguments);
          const menuT = TUtils.T.Menu;
          for (let item of res) {
            if (item == null || !item.hasOwnProperty("content")) continue;
            if (item.content in menuT) {
              if (!item._originalContent) item._originalContent = item.content;
              item.content = menuT[item.content];
            }
          }
          return res;
        };
      }
      
      const f2 = LiteGraph.ContextMenu;
      LiteGraph.ContextMenu = function (values, options) {
        if (options?.hasOwnProperty("title") && options.title in TUtils.T.Nodes) {
          options.title = TUtils.T.Nodes[options.title]["title"] || options.title;
        }
        
        var t = TUtils.T.Menu;
        var tN = TUtils.T.Nodes;
        var reInput = /Convert (.*) to input/;
        var reWidget = /Convert (.*) to widget/;
        var cvt = t["Convert "] || "Convert ";
        var tinp = t[" to input"] || " to input";
        var twgt = t[" to widget"] || " to widget";
        
        for (let value of values) {
          if (value == null || !value.hasOwnProperty("content")) continue;
          
          // 保存原始英文 content（优先保留最早的原始值，防止多次翻译覆盖）
          let originalContent = value._originalContent || value.content;
          let isTranslated = false;
          
          if (value.value in tN) {
            value.content = tN[value.value]["title"] || value.content;
            isTranslated = true;
          } else if (isOptionTranslationEnabled() && value.content in t) {
            value.content = t[value.content];
            isTranslated = true;
          } else {
            var extra_info = options.extra || options.parentMenu?.options?.extra;
            
            var matchInput = value.content?.match(reInput);
            if (matchInput) {
              var match = matchInput[1];
              extra_info?.inputs?.find((i) => {
                if (i.name != match) return false;
                match = i.label ? i.label : i.name;
              });
              extra_info?.widgets?.find((i) => {
                if (i.name != match) return false;
                match = i.label ? i.label : i.name;
              });
              value.content = cvt + match + tinp;
              isTranslated = true;
            } else {
              var matchWidget = value.content?.match(reWidget);
              if (matchWidget) {
                var match = matchWidget[1];
                extra_info?.inputs?.find((i) => {
                  if (i.name != match) return false;
                  match = i.label ? i.label : i.name;
                });
                extra_info?.widgets?.find((i) => {
                  if (i.name != match) return false;
                  match = i.label ? i.label : i.name;
                });
                value.content = cvt + match + twgt;
                isTranslated = true;
              }
            }
          }
          
          // 仅对实际翻译过的菜单项包装回调，执行前恢复英文、执行后恢复中文
          if (isTranslated) {
            value._originalContent = originalContent;
            
            if (typeof value.callback === "function") {
              const originalCallback = value.callback;
              value.callback = function(v, ...args) {
                const translatedContent = v.content;
                v.content = v._originalContent;
                const result = originalCallback.apply(this, [v, ...args]);
                v.content = translatedContent;
                return result;
              };
            }
          }
        }
        
        // 共享回调也需要拦截：执行前恢复英文、执行后恢复中文
        if (options && typeof options.callback === "function") {
          const originalOptCallback = options.callback;
          options.callback = function(v, ...args) {
            if (v && v._originalContent) {
              const translatedContent = v.content;
              v.content = v._originalContent;
              const result = originalOptCallback.apply(this, [v, ...args]);
              v.content = translatedContent;
              return result;
            }
            return originalOptCallback.apply(this, [v, ...args]);
          };
        }
        
        const ctx = f2.call(this, values, options);
        return ctx;
      };
      LiteGraph.ContextMenu.prototype = f2.prototype;
    } catch (e) {
      error("应用上下文菜单翻译失败:", e);
    }
  }

  static addRegisterNodeDefCB(app) {
    try {
      const f = app.registerNodeDef;
      app.registerNodeDef = async function (nodeId, nodeData) {
        var res = f.apply(this, arguments);
        res.then(() => {
          TUtils.applyNodeTypeTranslationEx(nodeId);
        });
        return res;
      };
    } catch (e) {
      error("添加节点定义注册回调失败:", e);
    }
  }

  static addNodeTitleMonitoring(app) {
    try {
      if (typeof LGraphNode === 'undefined') return;
      const originalSetTitle = LGraphNode.prototype.setTitle || function(title) { this.title = title; };
      LGraphNode.prototype.setTitle = function(title) {
        if (title && title !== this.constructor.title) { this._translation_custom_title = true; }
        return originalSetTitle.call(this, title);
      };
    } catch (e) {
      error("添加节点标题监听失败:", e);
    }
  }

  /**
   * 绘制前把显示层译文映射到 LiteGraph 真正读取的字段（slot.label / node.title），绘制后立刻还原。
   *
   * 为什么需要：本插件把译文存放在自定义属性 _uiiaiii_label / _uiiaiii_title 中，
   * 而 LiteGraph 绘制端口名与节点标题时读取的是 slot.label / node.title。
   * 在绘制瞬间临时映射，界面即可显示译文，同时 label / title 在任何时刻都保持英文原文，
   * 从结构上杜绝译文被序列化进工作流——无需拦截序列化，也无需事后清理。
   */
  static patchNodeDrawing() {
    try {
      if (typeof LGraphCanvas === "undefined" || LGraphCanvas.prototype._uiiaiii_draw_patched) return;
      const origDrawNode = LGraphCanvas.prototype.drawNode;
      if (typeof origDrawNode !== "function") return;

      LGraphCanvas.prototype.drawNode = function (node) {
        if (!node) return origDrawNode.apply(this, arguments);
        const restore = [];
        const pushRestore = (obj, key, val, remove) => restore.push({ obj, key, val, remove });

        if (node._uiiaiii_title !== undefined) {
          if (TUtils.isCustomNodeTitle(node)) {
            // 用户已手动改名：自定义标题优先，撤销显示层译文
            delete node._uiiaiii_title;
          } else {
            pushRestore(node, "title", node.title, false);
            node.title = node._uiiaiii_title;
          }
        }

        // 端口显示名：新版前端（ComfyUI 1.4+）给 socket 预置了 localized_name
        // 作为内置 i18n 的显示字段，其优先级高于 label。只映射 label 时，
        // 带 localized_name 的端口仍显示英文，因此两处都在绘制瞬间映射。
        const applySlot = (slot) => {
          if (!slot || slot._uiiaiii_label === undefined) return;
          const hadOwn = Object.prototype.hasOwnProperty.call(slot, "label");
          pushRestore(slot, "label", slot.label, !hadOwn);
          slot.label = slot._uiiaiii_label;
          const hadLN = Object.prototype.hasOwnProperty.call(slot, "localized_name");
          pushRestore(slot, "localized_name", slot.localized_name, !hadLN);
          slot.localized_name = slot._uiiaiii_label;
        };
        if (Array.isArray(node.inputs)) node.inputs.forEach(applySlot);
        if (Array.isArray(node.outputs)) node.outputs.forEach(applySlot);

        try {
          return origDrawNode.apply(this, arguments);
        } finally {
          for (const r of restore) {
            if (r.remove) delete r.obj[r.key];
            else r.obj[r.key] = r.val;
          }
        }
      };
      LGraphCanvas.prototype._uiiaiii_draw_patched = true;
    } catch (e) {
      error("拦截节点绘制失败:", e);
    }
  }
}

const ext = {
  name: "ComfyUI.TranslationNode",
  
  async init(app) {
    try {
      // 暴露给设置面板/顶部按钮，用于实时切换语言与翻译开关
      window.__UiUtils = TUtils;
      window.__UiConfig = currentConfig;
      await initConfig();
      await registerSettings(app);

      TUtils.enhandeDrawNodeWidgets();
      await TUtils.syncTranslation();
    } catch (e) {
      error("扩展初始化失败:", e);
    }
  },
  
  async setup(app) {
    try {      
      TUtils.addNodeTitleMonitoring(app);

      // 绘制瞬间把译文映射到 label / title（绘制后还原），译文本身永不写入这些会被序列化的字段
      TUtils.patchNodeDrawing();
      // 保存工作流时临时剥离翻译字段，保证 JSON 干净
      TUtils.patchSerialization();

      // 节点标题按开关应用或还原（函数内部自行判断开关）
      TUtils.applyNodeTypeTranslation(app);

      // setup 阶段 Pinia 可能尚未就绪，延迟重建搜索索引，
      // 否则英文界面下 Fuse 索引仍是旧英文，中文查询命中不了
      setTimeout(() => TUtils.refreshNodeSearchIndex(), 300);
      setTimeout(() => TUtils.refreshNodeSearchIndex(), 1500);

      // 以下函数均按开关决定是否安装翻译钩子（关闭时内部提前返回，不做任何改写）
      TUtils.applyContextMenuTranslation(app);
      TUtils.applyMenuTranslation(app);
      TUtils.addRegisterNodeDefCB(app);

      addPanelButtons(app);
      setupPluginManager();

      // 页面加载时翻译已关闭：继续监听之后打开的子图内部节点
      if (!isTranslationEnabled()) TUtils.watchDisabledNodeDom();
      // 开启状态：子图按钮的 i18n 文案也切换到目标语言，并监听新插入的按钮
      TUtils.applySubgraphButtonI18n(isTranslationEnabled());
      if (isTranslationEnabled()) TUtils.watchEnabledSubgraphButtons();

      // 进入/退出子图、切换工作流后补扫子图入口按钮：
      // 这些按钮是 Vue 后渲染的，DOM 观察器可能错过“隐藏→显示”的情况
      if (!TUtils._subgraphBtnClickBound) {
        TUtils._subgraphBtnClickBound = true;
        window.addEventListener("pointerup", () => {
          if (!isTranslationEnabled()) return;
          clearTimeout(TUtils._subgraphBtnClickTimer);
          TUtils._subgraphBtnClickTimer = setTimeout(() => {
            TUtils.syncSubgraphButtons();
            TUtils.syncNodeActionButtons();
            TUtils.syncCurrentGraphTranslations();
          }, 150);
          setTimeout(() => {
            TUtils.syncSubgraphButtons();
            TUtils.syncNodeActionButtons();
            TUtils.syncCurrentGraphTranslations();
          }, 600);
        }, true);
      }
    } catch (e) {
      error("扩展设置失败:", e);
    }
  },
  
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    try {
      TUtils.applyNodeDescTranslation(nodeType, nodeData, app);
    } catch (e) {
      error(`注册节点定义前处理失败 (${nodeType?.comfyClass || '未知'}):`, e);
    }
  },
  
  beforeRegisterVueAppNodeDefs(nodeDefs) {
    try {
      // 只保存原始定义，不在此阶段改写 display_name / description / category。
      // 前端会用这些 raw 定义构造 ComfyNodeDefImpl，display_name/description 会被
      // 固化为 backendDisplayName/backendDescription，而它们是只读 getter 的数据源，
      // 关闭翻译后无法恢复。显示层翻译统一在 store 就绪后应用。
      TUtils._vueNodeDefs = nodeDefs;
    } catch (e) {
      error("注册Vue应用节点定义前处理失败:", e);
    }
  },
  
  loadedGraphNode(node, app) {
    try {
      // 英文原文标题取原型层记录值（由 applyNodeTypeTranslationEx 保存）。
      // 未记录时不做自定义判断：避免把英文显示名误判为用户自定义标题而阻断翻译。
      const origTitle = node.constructor._uiiaiii_orig_title;
      const nodeT = TUtils.T.Nodes[node.constructor.comfyClass || node.constructor.type];
      const translatedTitle = nodeT?.title;

      // 已知译文标题是历史残留，不能当成用户自定义标题；
      // 否则刷新工作流后关闭翻译也恢复不回来。
      // 字典尚未加载时无法判断，不能贸然标记为自定义标题。
      if (translatedValueSet.size > 0
          && origTitle !== undefined && node.title && node.title !== origTitle
          && node.title !== translatedTitle && !isAlreadyTranslatedText(node.title)) {
        node._translation_custom_title = true;
      }
      TUtils.applyNodeTranslation(node);
      // 合并到全局防抖批量：DOM 渲染完成后统一补一次翻译/恢复，
      // 避免每个节点各自安排定时器造成多次可见刷新
      TUtils.scheduleNodeBatch(node);
    } catch (e) {
      error(`加载图表节点处理失败 (${node?.title || '未知'}):`, e);
    }
  },
  
  nodeCreated(node, app) {
    try {
      TUtils.applyNodeTranslation(node);
      // 部分插件会在自身钩子里动态创建控件（addWidget）或改写控件 label，
      // 交给全局批量稍后统一补一次，避免每个节点单独定时刷新
      TUtils.scheduleNodeBatch(node);
    } catch (e) {
      error(`创建节点处理失败 (${node?.title || '未知'}):`, e);
    }
  },
};

if (app && typeof app.registerExtension === "function") {
  app.registerExtension(ext);
} else {
  console.error("[UIIIAIII Toolkit] 无法获取 ComfyUI app，界面翻译未注册");
}