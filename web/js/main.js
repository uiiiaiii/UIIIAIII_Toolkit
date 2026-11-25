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

  static async syncTranslation(OnFinished = () => {}) {
    try {
      translatedValueSet.clear();
      const enabled = isTranslationEnabled();

      // 无论开关状态都要拉取字典：
      //  - 开启：用于应用译文
      //  - 关闭：用于识别界面/工作流中残留的旧译文并还原为英文原文
      //    （历史版本会把译文 label 写进工作流 JSON，关闭后需要据此清理）
      const dict = { Menu: {}, Nodes: {}, NodeCategory: {} };

      try {
        const response = await fetch("./translation_node/get_translation", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `locale=${currentConfig.locale}`
        });

        if (!response.ok) {
          throw new Error(`请求翻译数据失败: ${response.status} ${response.statusText}`);
        }

        const resp = await response.json();
        for (var key in dict) {
          dict[key] = (resp && resp[key]) || {};
        }

        // 合并分类到菜单中
        dict.Menu = Object.assign(dict.Menu || {}, dict.NodeCategory || {});

        // 提取 Node 中 key 到 Menu
        for (let key in dict.Nodes) {
          let node = dict.Nodes[key];
          if(node && node["title"]) {
            dict.Menu[key] = node["title"] || key;
          }
        }

        // ---- 构建判断用的 Set，提取所有字典内容 ----
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

      } catch (e) {
        error("获取翻译数据失败:", e);
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
      // 绝不修改 nodeType.title：节点序列化会读取 title，修改原型会把译文
      // 写进工作流；显示层由 _uiiaiii_title + 绘制临时映射完成。
      if (nodeType._uiiaiii_orig_title === undefined) {
        nodeType._uiiaiii_orig_title = nodeType.title;
      }

      // 节点库菜单/画布标题显示的是 nodeType.title（英文）。把英文显示名
      // →中文标题加入 Menu，供 DOM 翻译器翻译 2.0 菜单；不修改原型数据。
      if (isTranslationEnabled() && this.T && this.T.Menu) {
        const zhTitle = this.T.Nodes?.[class_type]?.title;
        const enTitle = nodeType.title;
        if (typeof enTitle === "string" && enTitle && typeof zhTitle === "string"
            && zhTitle && zhTitle !== enTitle && this.T.Menu[enTitle] === undefined) {
          this.T.Menu[enTitle] = zhTitle;
        }
      }
    } catch (e) {
      error(`为节点类型 ${nodeName} 应用翻译失败:`, e);
    }
  }

  static applyVueNodeDisplayNameTranslation(nodeDef) {
    try {
      if (!nodeDef || typeof nodeDef.name !== "string") return;
      // 记录节点定义层的英文显示名（仅一次）
      if (nodeDef._uiiaiii_orig_display_name === undefined) {
        nodeDef._uiiaiii_orig_display_name = nodeDef.display_name;
      }
      const orig = nodeDef._uiiaiii_orig_display_name;
      const zhTitle = TUtils.T.Nodes?.[nodeDef.name]?.title;

      // 不修改 nodeDef.display_name：它是节点定义对象，关闭翻译后无法自动恢复，
      // 会导致节点标题/菜单一直残留中文。只把英文显示名→中文标题加入 Menu，
      // 由 DOM 翻译器在显示层翻译。
      if (isTranslationEnabled() && TUtils.T && TUtils.T.Menu
          && typeof orig === "string" && orig && typeof zhTitle === "string"
          && zhTitle && zhTitle !== orig && TUtils.T.Menu[orig] === undefined) {
        TUtils.T.Menu[orig] = zhTitle;
      }
      // 把历史版本可能写入的中文显示名恢复为英文原文
      if (orig !== undefined && nodeDef.display_name !== orig) {
        nodeDef.display_name = orig;
      }
    } catch (e) {
      error(`为Vue节点 ${nodeDef?.name} 应用显示名称翻译失败:`, e);
    }
  }

  static applyVueNodeTranslation(nodeDef) {
    try {
      const catsT = TUtils.T.NodeCategory;
      if (!nodeDef.category) return;
      // 记录进入插件翻译前的 category（只记一次），翻译始终基于它计算，避免多次翻译累积。
      // 注意：此时 ComfyUI 内置 i18n 可能已改写部分分类名，它不保证是纯英文原文；
      // 分类管理需要与语言无关的基准时，改用后端 /object_info 的原始分类。
      if (nodeDef._original_category === undefined) {
        nodeDef._original_category = nodeDef.category;
      }
      const catArr = String(nodeDef._original_category).split("/");
      nodeDef.category = catArr.map((cat) => catsT?.[cat] || cat).join("/");
    } catch (e) {
      error(`为Vue节点 ${nodeDef?.name} 应用翻译失败:`, e);
    }
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

  static safeApplyTranslation(item, translation) {
    if (this.needsTranslation(item) && translation) {
      if (!item._original_name) {
        item._original_name = item.name;
      }
      item._uiiaiii_applied = translation;
      // 只写显示层自定义属性，绝不写 item.label（会被序列化进工作流）
      item._uiiaiii_label = translation;
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

    // 不再根据「label 是否在译文集合」改写 slot.label：
    // slot.label 会被 LiteGraph 序列化，且用户可能把端口手动命名为中文
    // （恰好与字典译文相同）。译文只写显示层自定义属性，由绘制层临时映射。
    item._uiiaiii_label = translation;
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
    delete node._uiiaiii_title;
    // 标题还原：历史工作流可能残留旧译文标题，或原型标题仍是译文
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
          delete item._uiiaiii_tl_orig;
          delete item._uiiaiii_tl;
          delete item._uiiaiii_label;
          delete item._uiiaiii_applied;
          continue;
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

      LGraph.prototype.serialize = function () {
        const restore = [];
        try {
          for (const node of this._nodes || []) {
            clean(node, restore);
            for (const key of ["inputs", "outputs", "widgets"]) {
              const arr = node?.[key];
              if (Array.isArray(arr)) {
                for (const item of arr) clean(item, restore);
              }
            }
          }
          return origSerialize.apply(this, arguments);
        } finally {
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
  static async switchLocale(locale) {
    try {
      currentConfig.locale = locale;
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

      // 节点原型标题按新状态/语言重新应用（关闭时恢复英文）
      this.applyNodeTypeTranslation(window.comfyAPI?.app?.app || window.app);

      if (isTranslationEnabled()) {
        for (const node of nodes) {
          if (this.isSubgraphNode(node)) continue;
          this.applyNodeTranslation(node);
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
      window.dispatchEvent(new CustomEvent("uiiaiii-locale-changed", { detail: { locale } }));
      window.dispatchEvent(new CustomEvent("uiiaiii-translation-state-changed", {
        detail: { enabled: isTranslationEnabled() }
      }));
    } catch (e) {
      error("切换语言失败:", e);
    }
  }

  /**
   * 实时启用/关闭翻译：恢复原文后按开关重新应用。
   */
  static async setTranslationEnabled(enabled) {
    try {
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

      // 节点原型标题按新状态/语言重新应用（关闭时恢复英文）
      this.applyNodeTypeTranslation(window.comfyAPI?.app?.app || window.app);

      if (enabled && isTranslationEnabled()) {
        for (const node of nodes) {
          if (this.isSubgraphNode(node)) continue;
          this.applyNodeTranslation(node);
        }
        applyMenuTranslation(this.T);
        translateAllDom(this.T);
      } else {
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
      window.dispatchEvent(new CustomEvent("uiiaiii-translation-state-changed", {
        detail: { enabled: isTranslationEnabled() }
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
      for (const node of allNodes) {
        if (!node || node.id === undefined) continue;
        const root = document.querySelector(`[data-node-id="${node.id}"]`);
        if (!root) continue;
        if (this.isSubgraphNode(node)) {
          // 子图自定义接口不翻译，但容器底部的 Enter subgraph 操作按钮要翻译
          const enterText = root.querySelector('[data-testid="subgraph-enter-button"] span');
          if (enterText) {
            const translated = this.T?.Menu?.["Enter subgraph"] || this.T?.Menu?.["enterSubgraph"];
            if (translated && enterText.textContent !== translated) {
              enterText.textContent = translated;
            }
          }
          continue;
        }

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
    } catch (e) { /* 忽略 */ }
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
      for (const node of nodes || []) {
        if (!node || node.id === undefined) continue;
        const root = document.querySelector(`[data-node-id="${node.id}"]`);
        if (!root) continue;
        if (this.isSubgraphNode(node)) {
          // 子图接口保持用户命名，只恢复容器的 Enter subgraph 操作按钮
          const enterText = root.querySelector('[data-testid="subgraph-enter-button"] span');
          if (enterText && enterText.textContent !== "Enter subgraph") {
            enterText.textContent = "Enter subgraph";
          }
          continue;
        }

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
      // 下拉当前值恢复为英文
      this.syncComboDomLabels(nodes);
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 直接同步节点下拉控件在 DOM 中显示的当前值。
   * 新版 Nodes 2.0 的 combo 控件由 DOM/渲染器缓存显示文本，数据层恢复后
   * 画面仍可能停留在旧语言；这里按 widget 的当前值直接修正可见文本。
   */
  static syncComboDomLabels(nodes) {
    try {
      const menu = window.__UiTranslated?.Menu || {};
      const enabled = isTranslationEnabled();
      for (const node of nodes || []) {
        if (!node || node.id === undefined) continue;
        if (this.isSubgraphNode(node)) continue;
        const root = document.querySelector(`[data-node-id="${node.id}"]`);
        if (!root) continue;
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

  /**
   * 关闭翻译启动/刷新工作流时，清理工作流里持久化的已知译文标题/端口名。
   * 不修改文件，只恢复显示层；用户自定义中文（不在字典中）保留。
   */
  static restoreDisabledGraphTranslations() {
    if (isTranslationEnabled()) return;
    try {
      const app = window.comfyAPI?.app?.app || window.app;
      const allNodes = this.collectAllNodes(app?.graph);
      for (const node of allNodes) {
        this.applyNodeTranslation(node);
      }
      // 同步刷新 DOM，避免 2.0 组件仍缓存中文标题/控件名
      this.restoreNodeDomToEnglish(allNodes);
    } catch (e) { /* 忽略 */ }
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

      // Agnes / Qwen 图像节点：参考图插槽逐级展开（AgnesVideo 还含参考音频）
      if (["AgnesVideo", "AgnesImage", "QwenImageEdit", "QwenImage21", "MiniMaxH3Image"].includes(class_type)) {
        this.setupGrowableInputs(node);
      }

      if (!isTranslationEnabled()) {
        for (let key of keys) {
          if (!node.hasOwnProperty(key)) continue;
          if (!node[key] || !Array.isArray(node[key])) continue;
          node[key].forEach((item) => {
            if (!item) return;
            delete item._uiiaiii_label;   // 撤销显示层译文（序列化数据本就不受影响）
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

        // 标题还原：撤销显示层译文；若工作流里残留的是旧译文标题，一并回退为英文原名
        delete node._uiiaiii_title;
        if (!node._translation_custom_title && node.title && isAlreadyTranslatedText(node.title)) {
          node.title = node._original_title
            || node.constructor._uiiaiii_orig_title
            || node.constructor.comfyClass
            || node.constructor.type;
        }
        delete node._original_title;
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
        if (!node.hasOwnProperty(key)) continue;
        if (!node[key] || !Array.isArray(node[key])) continue;
        
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
          // widgets 额外查 Menu 字典：覆盖前端动态创建/改写的控件与按钮文案
          // （如 addWidget("button", "Browse…")、运行时 label 赋值 detector_confidence）
          if (!translation && key === "widgets") {
            const menuT = this.T.Menu || {};
            translation = menuT[item.name] || (item.label && menuT[item.label]) || null;
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
      
      if (t.hasOwnProperty("title")) {
        // 仅当用户在界面上显式改过标题时才跳过翻译（由 setTitle/loadedGraphNode 标记，
        // 以及 isCustomNodeTitle 的运行时判定）；否则译文只写自定义属性 _uiiaiii_title：
        // node.title 会被序列化进工作流，不能改写
        if (!node._translation_custom_title && !this.isCustomNodeTitle(node)) {
          node._uiiaiii_title = t["title"];
        } else {
          delete node._uiiaiii_title;
        }
      }
      
      let addInput = node.addInput;
      node.addInput = function (name, type, extra_info) {
        var oldInputs = [];
        if (this.inputs && Array.isArray(this.inputs)) {
          this.inputs.forEach((i) => oldInputs.push(i.name));
        }
        var res = addInput.apply(this, arguments);
        if (this.inputs && Array.isArray(this.inputs)) {
          this.inputs.forEach((i) => {
            if (oldInputs.includes(i.name)) return;
            if (t["widgets"] && i.widget?.name in t["widgets"]) {
              TUtils.applySlotTranslation(i, t["widgets"][i.widget?.name]);
            }
          });
        }
        return res;
      };
      
      let onInputAdded = node.onInputAdded;
      node.onInputAdded = function (slot) {
        let res;
        if (onInputAdded) {
          res = onInputAdded.apply(this, arguments);
        }
        let t = TUtils.T.Nodes[this.comfyClass];
        if (t?.["widgets"] && slot.name in t["widgets"]) {
          if (TUtils.needsTranslation(slot)) {
            TUtils.applySlotTranslation(slot, t["widgets"][slot.name]);
          }
        }
        return res;
      };

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
    } catch (e) {
      error(`为节点 ${node?.title || '未知'} 应用翻译失败:`, e);
    }
  }

  static applyNodeDescTranslation(nodeType, nodeData, app) {
    try {
      if (!isTranslationEnabled()) return;
      
      let nodesT = this.T.Nodes;
      var t = nodesT[nodeType.comfyClass];
      if (t?.["description"]) {
        nodeData.description = t["description"];
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

      // 以下函数均按开关决定是否安装翻译钩子（关闭时内部提前返回，不做任何改写）
      TUtils.applyContextMenuTranslation(app);
      TUtils.applyMenuTranslation(app);
      TUtils.addRegisterNodeDefCB(app);

      addPanelButtons(app);
      setupPluginManager();
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
      if (!isTranslationEnabled()) return;
      nodeDefs.forEach(TUtils.applyVueNodeDisplayNameTranslation);
      nodeDefs.forEach(TUtils.applyVueNodeTranslation);
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
      if (origTitle !== undefined && node.title && node.title !== origTitle
          && node.title !== translatedTitle && !isAlreadyTranslatedText(node.title)) {
        node._translation_custom_title = true;
      }
      TUtils.applyNodeTranslation(node);
      // 关闭翻译时刷新工作流：等所有节点加载完后，统一清理工作流里
      // 持久化的已知译文标题/端口名（不修改文件，只恢复显示）。
      if (!isTranslationEnabled()) {
        clearTimeout(TUtils._graphRestoreTimer);
        TUtils._graphRestoreTimer = setTimeout(() => TUtils.restoreDisabledGraphTranslations(), 300);
      }
      // Nodes 2.0 DOM 渲染完成后，用节点字典覆盖端口/控件名
      setTimeout(() => TUtils.syncNodeDomLabels([node]), 300);
    } catch (e) {
      error(`加载图表节点处理失败 (${node?.title || '未知'}):`, e);
    }
  },
  
  nodeCreated(node, app) {
    try {
      TUtils.applyNodeTranslation(node);
      // 部分插件会在自身钩子里动态创建控件（addWidget）或改写控件 label，
      // 延迟再应用一次 widget 翻译，确保这些后写入的文案也被翻译
      setTimeout(() => {
        try {
          TUtils.applyNodeTranslation(node);
          TUtils.syncNodeDomLabels([node]);
        } catch (e) { /* 忽略重试错误 */ }
      }, 300);
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