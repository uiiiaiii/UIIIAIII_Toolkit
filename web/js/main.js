/**
 * ComfyUI-Translation 主逻辑模块
 *
 * 翻译功能基于以下两个开源项目修改而来：
 * - AIGODLIKE-ComfyUI-Translation (https://github.com/AIGODLIKE/AIGODLIKE-ComfyUI-Translation)
 * - ComfyUI-DD-Translation
 */

import { app } from "../../../scripts/app.js";
import { applyMenuTranslation, observeFactory } from "./MenuTranslate.js";
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
  static translateNodeWidgetLabels(node) {
    try {
      const widgets = node?.widgets;
      if (!widgets || !widgets.length) return;

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

      const menuT = this.T.Menu || {};
      const nodesT = this.T.Nodes || {};
      const classType = node.constructor?.comfyClass || node.constructor?.type;
      const widgetDict = (classType && nodesT[classType]?.widgets) || {};
      for (const w of widgets) {
        if (!w) continue;
        // 显示名优先 label，其次 name
        const shown = (typeof w.label === "string" && w.label) ? w.label : w.name;
        if (typeof shown !== "string" || !shown) continue;
        if (w._uiiaiii_tl === shown) continue;   // 显示名未变，无需重复处理
        w._uiiaiii_tl = shown;
        if (isAlreadyTranslatedText(shown)) continue;   // 已是译文
        const translated = widgetDict[shown] || menuT[shown];
        if (translated && translated !== shown) {
          // 仅首次改写时记录原文（null 表示原本没有 label，显示名取 name）
          if (w._uiiaiii_tl_orig === undefined) {
            w._uiiaiii_tl_orig = (typeof w.label === "string" && w.label) ? w.label : null;
          }
          w.label = translated;
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

      // 记录原型层英文原文标题（仅一次），供关闭翻译时还原
      if (nodeType._uiiaiii_orig_title === undefined) {
        nodeType._uiiaiii_orig_title = nodeType.title;
      }
      const origTitle = nodeType._uiiaiii_orig_title;

      if (!isTranslationEnabled()) {
        if (origTitle !== undefined && nodeType.title !== origTitle) {
          nodeType.title = origTitle;
        }
        return;
      }

      const zhTitle = nodesT.hasOwnProperty(class_type) ? nodesT[class_type]["title"] : null;
      if (zhTitle && nodeType.title !== zhTitle) {
        nodeType.title = zhTitle;
      }
    } catch (e) {
      error(`为节点类型 ${nodeName} 应用翻译失败:`, e);
    }
  }

  static applyVueNodeDisplayNameTranslation(nodeDef) {
    try {
      const nodesT = TUtils.T.Nodes;
      const class_type = nodeDef.name;
      if (nodesT.hasOwnProperty(class_type)) {
        const hasNativeTranslation = nodeDef.display_name && isAlreadyTranslatedText(nodeDef.display_name);
        if (!hasNativeTranslation && nodesT[class_type]["title"]) {
          nodeDef.display_name = nodesT[class_type]["title"];
        }
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
      item.label = translation;
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
   * 应用端口（inputs/outputs）显示名译文。
   *
   * 关键原则：译文只写入自定义属性 _uiiaiii_label，**绝不写 slot.label**。
   * LiteGraph 序列化会把 slot.label 写进工作流 JSON，一旦改写就会持久污染
   * （关闭翻译后重新加载工作流仍显示中文）。显示层的译文由 patchNodeDrawing()
   * 在绘制瞬间临时映射到 label，序列化数据始终只含英文原名。
   * （widgets 的 label 不参与序列化，故仍可照常改写。）
   */
  static applySlotTranslation(item, translation) {
    if (!item || !translation || translation === item.name) return;
    // 历史污染：label 曾是被写进工作流的译文 → 内存中恢复英文原名，改由 _uiiaiii_label 承担显示
    if (typeof item.label === "string" && item.label !== item.name && isAlreadyTranslatedText(item.label)) {
      item.label = item.name;
    }
    item._uiiaiii_label = translation;
  }

  static applyNodeTranslation(node) {
    try {
      if (!node || !node.constructor) return;

      let keys = ["inputs", "outputs", "widgets"];
      let nodesT = this.T.Nodes;
      let class_type = node.constructor.comfyClass ? node.constructor.comfyClass : node.constructor.type;
      
      if (!class_type) return;

      if (!isTranslationEnabled()) {
        for (let key of keys) {
          if (!node.hasOwnProperty(key)) continue;
          if (!node[key] || !Array.isArray(node[key])) continue;
          node[key].forEach((item) => {
            if (!item) return;
            delete item._uiiaiii_label;   // 撤销显示层译文（序列化数据本就不受影响）
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
      
      for (let key of keys) {
        if (!node.hasOwnProperty(key)) continue;
        if (!node[key] || !Array.isArray(node[key])) continue;
        
        const dict = t[key] || {};
        node[key].forEach((item) => {
          if (!item || !item.name) return;
          let translation = dict[item.name];
          // widgets 额外查 Menu 字典：覆盖前端动态创建/改写的控件与按钮文案
          // （如 addWidget("button", "Browse…")、运行时 label 赋值 detector_confidence）
          if (!translation && key === "widgets") {
            const menuT = this.T.Menu || {};
            translation = menuT[item.name] || (item.label && menuT[item.label]) || null;
          }
          if (translation) {
            if (key === "widgets") {
              // widgets 的 label 不参与序列化，可直接改写
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
        // 仅当用户在界面上显式改过标题时才跳过翻译（由 setTitle/loadedGraphNode 标记），
        // 不再用"标题不等于类名"之类的启发式判断：那会把英文显示名误判为自定义标题，导致标题永不翻译
        // 译文同样只写自定义属性 _uiiaiii_title：node.title 会被序列化进工作流，不能改写
        if (!node._translation_custom_title) {
          node._uiiaiii_title = t["title"];
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
          // 控件创建完毕后立刻检查翻译
          if (isTranslationEnabled() && res && res.name) {
            let class_type = this.constructor.comfyClass || this.constructor.type;
            let dict = TUtils.T.Nodes[class_type];
            if (dict && dict["widgets"] && res.name in dict["widgets"]) {
              TUtils.safeApplyTranslation(res, dict["widgets"][res.name]);
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
        observeFactory(dragHandle.childNodes[1], (mutationsList, observer) => {
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

        if (node._uiiaiii_title !== undefined) {
          restore.push([node, "title", node.title]);
          node.title = node._uiiaiii_title;
        }

        const applySlot = (slot) => {
          if (slot && slot._uiiaiii_label !== undefined) {
            restore.push([slot, "label", slot.label]);
            slot.label = slot._uiiaiii_label;
          }
        };
        if (Array.isArray(node.inputs)) node.inputs.forEach(applySlot);
        if (Array.isArray(node.outputs)) node.outputs.forEach(applySlot);

        try {
          return origDrawNode.apply(this, arguments);
        } finally {
          for (const [obj, key, val] of restore) {
            obj[key] = val;
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

      if (origTitle !== undefined && node.title && node.title !== origTitle && node.title !== translatedTitle) {
        node._translation_custom_title = true;
      }
      TUtils.applyNodeTranslation(node);
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
        } catch (e) { /* 忽略重试错误 */ }
      }, 300);
    } catch (e) {
      error(`创建节点处理失败 (${node?.title || '未知'}):`, e);
    }
  },
};

app.registerExtension(ext);