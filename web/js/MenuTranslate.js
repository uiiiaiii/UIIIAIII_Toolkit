/**
 * ComfyUI-Translation-node 菜单翻译模块
 */

import { 
  isAlreadyTranslatedText, 
  nativeTranslatedSettings,
  isOptionTranslationEnabled,
  error
} from "./utils.js";

/**
 * 节点库树的英文分类名集合（来自后端 /object_info 的原始 category）。
 *
 * 不能从 LiteGraph.registered_node_types 取：那里的 category 已被翻译成中文，
 * 无法用于判断树上的英文分类名。前端 i18n / 本插件都可能改写它，
 * 只有后端数据是语言无关的权威来源。
 */
let _rawCategorySegments = null;
let _catSegmentsLoading = false;

async function loadCategorySegments() {
  if (_rawCategorySegments || _catSegmentsLoading) return;
  _catSegmentsLoading = true;
  try {
    const resp = await fetch("./object_info");
    if (!resp.ok) return;
    const info = await resp.json();
    const set = new Set();
    for (const cls in info) {
      const category = info[cls]?.category;
      if (typeof category !== "string" || !category) continue;
      category.replace(/\\/g, "/").split("/").forEach((seg) => {
        const s = seg.trim();
        if (s) set.add(s);
      });
    }
    if (!set.size) return;
    _rawCategorySegments = set;
    // 集合就绪后重扫节点库树：修正此前因缺少集合而沿用的节点显示名
    document.querySelectorAll(".tree-node, [role='treeitem']").forEach((el) => texe.replaceText(el));
  } catch (e) {
    error("加载分类名出错:", e);
  } finally {
    _catSegmentsLoading = false;
  }
}

class TExe {
  static T = null;
  MT(txt) {
    if (!txt) return null;
    if (isAlreadyTranslatedText(txt)) {
      return null;
    }
    const direct = this.T?.Menu?.[txt] || this.T?.Menu?.[txt?.trim?.()];
    if (direct) return direct;

    // 官方 main.json 大量文案是 "Add {group}" 这类模板；运行时占位符已被
    // 替换成实际值，精确匹配失败。这里做模板匹配，保持与官方 i18n 一致。
    const templated = this.matchTemplate(txt);
    if (templated) return templated;

    // 菜单项常把快捷键拼进文案，如 "Cleanup Of VRAM Usage (Shift+r)"；
    // 字典只收录不带快捷键的文案，去掉后缀再查一次，译文后原样补回快捷键。
    const rawText = String(txt);
    const hotkey = rawText.match(/\s*\((Shift|Ctrl|Alt|Cmd|Meta|Option|Control)(\s*\+\s*[A-Za-z0-9]+)+\)\s*$/i);
    if (hotkey && hotkey.index > 0) {
      const baseText = rawText.slice(0, hotkey.index).trim();
      const suffix = rawText.slice(hotkey.index);
      const baseT = this.T?.Menu?.[baseText] || this.matchTemplate(baseText);
      if (baseT) return `${baseT}${suffix}`;
    }

    // 通用规则：节点属性面板标题 "<节点名> Properties"。
    // 标题是运行时拼接的（字典里通常只有节点标题），这里按类名去后缀匹配，
    // 输出 "<节点标题> 属性"；不依赖完整标题词条。
    const raw = String(txt).trim();
    if (raw === "Properties") return "属性";
    if (raw.endsWith(" Properties")) {
      const base = raw.slice(0, -" Properties".length).trim();
      if (!base) return null;
      const menu = this.T?.Menu || {};
      let baseT = menu[base];
      if (!baseT) {
        const nodes = this.T?.Nodes || {};
        for (const [cls, def] of Object.entries(nodes)) {
          const clsNorm = String(cls).replace(/\s*\([^)]*\)\s*$/, "").trim();
          if (clsNorm === base) {
            baseT = (def && typeof def.title === "string" && def.title) || base;
            break;
          }
        }
      }
      if (baseT) return `${baseT} 属性`;
    }
    return null;
  }

  /**
   * 占位符模板匹配：字典键形如 "Add {group}"，实际文本是 "Add Group"。
   * 懒构建模板索引（按首字符分组，避免每次遍历全部模板）。
   */
  matchTemplate(txt) {
    try {
      const T = this.T;
      if (!T || !T.Menu || !txt) return null;
      const key = String(txt);
      if (!key) return null;

      if (!this._templateDict || this._templateDict !== T.Menu) {
        this._templateDict = T.Menu;
        this._templates = [];
        const index = new Map();
        for (const [en, zh] of Object.entries(T.Menu)) {
          if (typeof en !== "string" || typeof zh !== "string") continue;
          if (!en.includes("{") || !zh) continue;

          // 官方复数模板 "A | B"：运行时只显示其中一个分支
          // （如 "0 active"），必须拆成独立模板才能匹配。
          let pairs = [[en, zh]];
          if (en.includes("|")) {
            const enParts = en.split(/\s*\|\s*/);
            const zhParts = zh.split(/\s*\|\s*/);
            if (enParts.length > 1
                && enParts.every((p) => /\{[A-Za-z0-9_$]+\}/.test(p))
                && zhParts.length === enParts.length) {
              pairs = enParts.map((p, i) => [p, zhParts[i]]);
            }
          }

          for (const [enText, zhText] of pairs) {
            const names = [];
            const esc = enText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const pattern = esc.replace(/\\\{([A-Za-z0-9_$]+)\\\}/g, (m, name) => {
              names.push(name);
              return "(.+?)";
            });
            if (!names.length) continue;
            let re;
            try { re = new RegExp("^" + pattern + "$"); } catch (e) { continue; }
            const tpl = { re, names, zh: zhText };
            this._templates.push(tpl);
            const first = enText[0] || "";
            if (!index.has(first)) index.set(first, []);
            index.get(first).push(tpl);
          }
        }
        this._templateIndex = index;
      }

      const group = this._templateIndex?.get(key[0])
        || this._templateIndex?.get("{")
        || this._templates
        || [];
      for (const tpl of group) {
        const m = tpl.re.exec(key);
        if (!m) continue;
        let out = tpl.zh;
        tpl.names.forEach((name, idx) => {
          out = out.split(`{${name}}`).join(m[idx + 1]);
        });
        // 中文模板若使用不同的占位符名，按顺序兜底替换
        let capture = 1;
        out = out.replace(/\{[A-Za-z0-9_$]+\}/g, () => m[capture++] ?? "");
        return out;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 节点库树（分类 + 节点名）专用翻译。
   *
   * 不能用 MT（Menu 字典混杂了菜单词条，会把分类名 "sd" 命成 AlekPet 的语言代码
   * "信德语"）。这里按语义分级：
   *   1. 分类段 → 只认 NodeCategory 字典
   *   2. 已知分类但字典无条目 → 保持英文原文，禁止回落到 Menu
   *   3. 节点名 → Nodes[类名].title，其次 Menu（节点显示名）
   */
  MTTree(txt) {
    if (!txt || isAlreadyTranslatedText(txt)) return null;
    const T = this.T;
    if (!T) return null;
    const key = txt.trim();
    if (!key) return null;

    // 1) 分类：只认 NodeCategory 字典
    const catT = T.NodeCategory || {};
    if (catT[key]) return catT[key];

    // 2) 已知分类但字典无条目 → 保持英文原文，禁止回落到 Menu
    if (_rawCategorySegments?.has(key)) return null;

    // 3) 节点名：优先 Nodes 字典里该类名的标题
    const nodeTitle = T.Nodes?.[key]?.title;
    if (nodeTitle) return nodeTitle;

    // 4) 节点显示名 → Menu；分类集合未就绪时先不回落，避免把分类误译
    return _rawCategorySegments ? this.MT(key) : null;
  }

  constructor() {
    this.excludeClass = [
      "lite-search-item-type",
      "p-tree",            // 拦截扩展节点组 (Vue Tree)
      "p-virtualscroller", // 拦截模版搜索中的虚拟滚动列表
      "lg-node"            // 画布节点由节点数据层首帧写入译文，禁止 DOM 二次翻译造成刷新
    ];
    this.observers = [];
    
    // 【核心修复 1】：内部微任务防抖队列，解决同一 Target 瞬间被触发数百次的问题
    this.pendingNodes = new Set();
    this.isScheduling = false;

    // 子图区域翻译：已设置 Observer 的 .p-tree 元素集合，避免重复创建
    // 用 WeakSet：树组件销毁后允许 GC，避免长期运行持有已移除的 DOM
    this.observedTrees = new WeakSet();
  }

  tSkip(node) {
    try {
      // 性能优化：文本节点直接查父级，精准匹配黑名单组件
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (!el || typeof el.closest !== 'function') return false;

      // 画布节点根必须允许继续递归：否则在 .lg-node 处直接 return，
      // 子树里的子图入口按钮永远得不到翻译。
      if (el.classList?.contains("lg-node")) return false;

      // 图标字体元素里的字符不参与翻译
      if (el.closest("i, svg, [class*='icon-'], [class*='lucide']")) return true;

      // 画布节点内部交给节点数据层首帧写入；但节点上的操作按钮
      // （Issues / Show advanced / Enter subgraph 等）只在 DOM 上，需要放行。
      if (el.closest(".lg-node")) {
        const btn = el.closest('button, [role="button"]');
        if (btn) {
          // 按钮 textContent 可能混入图标字符，只取真实文本节点
          let btnText = "";
          const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
          let tn;
          while ((tn = walker.nextNode())) {
            const parent = tn.parentElement;
            if (parent?.closest("i, svg, [class*='icon-'], [class*='lucide']")) continue;
            btnText += tn.nodeValue || "";
          }
          btnText = btnText.trim();
          // 按钮文案命中字典，或子图入口按钮，都交给 DOM 翻译
          if (btnText && this.T?.Menu?.[btnText]) return false;
          if (/^(Enter|Exit)( subgraph)?$/i.test(btnText)) return false;
        }
        return !el.closest('[data-testid="subgraph-enter-button"]');
      }

      return this.excludeClass.some((cls) => el.closest(`.${cls}`));
    } catch (e) {
      return false;
    }
  }

  /**
   * 目标是否位于节点库树内（分类行/节点行）
   */
  inTreeContext(node) {
    try {
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      return !!el?.closest?.(".tree-node, [role='treeitem']");
    } catch (e) {
      return false;
    }
  }

  translateKjPopDesc(node) {
    try {
      let T = this.T;
      if (!T) return false;
      if (!node || !node.querySelectorAll) return false;
      if (!node?.classList?.contains("kj-documentation-popup")) return false;
      
      // 直接递归整棵子树，避免 querySelectorAll 生成大数组
      this.replaceText(node);
      return true;
    } catch (e) {
      error("翻译KJ弹窗出错:", e);
      return false;
    }
  }

  translateAllText(node) {
    try {
      let T = this.T;
      if (!T || !node) return;
      // 过滤掉不合理的 DOM 节点
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;

      // 把待翻译节点加入防抖队列 (应对你第3、4轮发现的 target 重复重入问题)
      this.pendingNodes.add(node);

      if (!this.isScheduling) {
        this.isScheduling = true;
        
        // 使用 queueMicrotask 在当前所有同步 Mutation 回调执行完毕后，统一收网
        queueMicrotask(() => {
          const nodesToTranslate = Array.from(this.pendingNodes);
          this.pendingNodes.clear();
          this.isScheduling = false;

          for (const targetNode of nodesToTranslate) {
            // 如果节点已经被销毁（Vue 虚拟列表频繁销毁重建），直接跳过
            if (!document.contains(targetNode) && targetNode.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
              continue;
            }

            // 【核心修复 2】：彻底移除 querySelectorAll("*") ！！
            // 直接把父容器抛给 replaceText，让它利用自带的递归完成 O(N) 的单次遍历。
            this.replaceText(targetNode);
          }

          // 账本过大时清理已脱离文档的节点，避免长期运行积累
          if (domTextOrig.size + domAttrOrig.size > 3000) pruneDomLedger();
        });
      }
    } catch (e) {
      error("翻译所有文本出错:", e);
    }
  }

  replaceText(target, ctx = null) {
    try {
      if (!target) return;
      if (!this.T) return;

      const isText = target.nodeType === Node.TEXT_NODE;
      // 祖先已被排除时直接返回；文本节点继承父元素的判断结果，
      // 避免对同一父级重复执行 closest
      const skip = isText ? !!ctx?.skip : (ctx?.skip || this.tSkip(target));
      if (skip) return;

      // 子图容器：用户自定义的接口名称保持原样；但 Enter/Exit subgraph
      // 这类操作按钮仍要正常翻译，否则开启翻译后按钮要刷新才变中文。
      const hostEl = isText ? target.parentElement : target;
      if (hostEl && hostEl.closest && hostEl.closest("[data-uiiaiii-subgraph]")) {
        const operationButton = hostEl.closest("button, [role='button'], .comfyui-button");
        if (!operationButton) return;
      }

      // 节点库树内的文本按“分类/节点名”语义翻译，不能走全局 Menu 词典
      // 父级已确认在树内时子级直接继承，省去逐节点 closest
      const inTree = isText
        ? !!ctx?.inTree
        : (ctx?.inTree === true ? true : this.inTreeContext(target));
      const translate = inTree ? (t) => this.MTTree(t) : (t) => this.MT(t);

      // 官方已翻译的设置项：只检查单个文本节点，
      // 避免对大子树反复拼接 textContent（深层 DOM 下是 O(N²) 开销）
      let checkText = null;
      if (isText) {
        checkText = target.nodeValue;
      } else if (target.childNodes?.length === 1
          && target.firstChild?.nodeType === Node.TEXT_NODE) {
        checkText = target.firstChild.nodeValue;
      }
      if (checkText && nativeTranslatedSettings.includes(checkText)) return;

      // COMBO 下拉选项翻译开关：ContextMenu 容器内的文本受此开关控制
      if (!isOptionTranslationEnabled()) {
        const el = isText ? target.parentElement : target;
        if (el?.closest?.(".litecontextmenu")) return;
      }

      if (target.childNodes && target.childNodes.length) {
        const childCtx = { skip: false, inTree };
        const childNodes = Array.from(target.childNodes);
        for (const childNode of childNodes) {
          this.replaceText(childNode, childCtx);
        }
      }

      if (isText) {
        if (target.nodeValue && !isAlreadyTranslatedText(target.nodeValue)) {
          const translated = translate(target.nodeValue);
          if (translated) {
            if (!domTextOrig.has(target)) domTextOrig.set(target, target.nodeValue);
            target.nodeValue = translated;
          }
        }
        return;
      }

      if (target.nodeType !== Node.ELEMENT_NODE) return;

      if (target.title && !isAlreadyTranslatedText(target.title)) {
        const titleTranslated = translate(target.title);
        if (titleTranslated) {
          rememberAttr(target, "title", target.title);
          target.title = titleTranslated;
        }
      }

      // 输入框占位符（如 easy-use 账号对话框的 "Enter APIKEY"）
      if ((target.nodeName === "INPUT" || target.nodeName === "TEXTAREA") &&
          target.placeholder && !isAlreadyTranslatedText(target.placeholder)) {
        const placeholderTranslated = translate(target.placeholder);
        if (placeholderTranslated) {
          rememberAttr(target, "placeholder", target.placeholder);
          target.placeholder = placeholderTranslated;
        }
      }

      // 无障碍属性 aria-label（部分 2.0 组件的可见文案放在这里）
      if (target.getAttribute) {
        const ariaLabel = target.getAttribute("aria-label");
        if (ariaLabel && !isAlreadyTranslatedText(ariaLabel)) {
          const ariaTranslated = translate(ariaLabel);
          if (ariaTranslated) {
            rememberAttr(target, "aria-label", ariaLabel);
            target.setAttribute("aria-label", ariaTranslated);
          }
        }
      }

      if (target.nodeName === "INPUT" && target.type === "button" &&
          !isAlreadyTranslatedText(target.value)) {
        const valueTranslated = translate(target.value);
        if (valueTranslated) {
          rememberAttr(target, "value", target.value);
          target.value = valueTranslated;
        }
      }

      // 设置面板的下拉框常以只读 input 显示当前选中值（如"自动"/"无"），
      // 翻译后必须记录原文，否则关闭翻译时无法恢复，需要点击一次才刷新
      const isReadonlyInput = (target.nodeName === "INPUT" || target.nodeName === "TEXTAREA") &&
        (target.readOnly || target.getAttribute?.("aria-readonly") === "true");
      if (isReadonlyInput && target.value && !isAlreadyTranslatedText(target.value)) {
        const readonlyValueTranslated = translate(target.value);
        if (readonlyValueTranslated) {
          rememberAttr(target, "value", target.value);
          target.value = readonlyValueTranslated;
        }
      }

      // 叶子元素用 textContent：innerText 会触发同步布局，
      // 设置面板/长菜单等大子树下开销明显
      if (!target.children || target.children.length === 0) {
        const text = target.textContent;
        if (text && !isAlreadyTranslatedText(text)) {
          const innerTextTranslated = translate(text);
          if (innerTextTranslated) {
            rememberAttr(target, "textContent", target.textContent);
            target.textContent = innerTextTranslated;
          }
        }
      }

      if (target.nodeName === "SELECT" && isOptionTranslationEnabled()) {
        Array.from(target.options).forEach(option => {
          if (option.text && !isAlreadyTranslatedText(option.text)) {
            const optionTextTranslated = this.MT(option.text);
            if (optionTextTranslated) {
              rememberAttr(option, "optionText", option.text);
              option.text = optionTextTranslated;
            }
          }
        });
      }
    } catch (e) {
      error("替换文本出错:", e);
    }
  }

  cleanupObservers() {
    try {
      this.observers.forEach(observer => {
        if (observer && typeof observer.disconnect === 'function') {
          observer.disconnect();
        }
      });
      this.observers = [];
      this.observedTrees = new WeakSet();
    } catch (e) {
      error("清理观察者出错:", e);
    }
  }
}

let texe = new TExe();

let _isTranslating = false;

let _pendingNodes = new Set();
let _rafId = null;

function scheduleTranslation(node) {
  if (!node || !node.querySelectorAll) return;
  _pendingNodes.add(node);
  if (_rafId !== null) cancelAnimationFrame(_rafId);
  _rafId = requestAnimationFrame(flushTranslations);
}

function flushTranslations() {
  _rafId = null;
  if (_pendingNodes.size === 0) return;
  _isTranslating = true;
  try {
    for (const node of _pendingNodes) {
      if (node.isConnected) texe.translateAllText(node);
    }
    _pendingNodes.clear();
  } finally {
    setTimeout(() => { _isTranslating = false; }, 0);
  }
}

function isSearchRelatedElement(node) {
  if (!node || !node.classList) return false;
  return node.classList.contains("litesearchbox") || 
         node.classList.contains("lite-search-item") ||
         (node.querySelector && !!node.querySelector(".litesearchbox"));
}

// 需要「立即翻译」的浮层容器：对话框、右键菜单、顶部菜单、下拉弹层
const IMMEDIATE_OVERLAY_SELECTOR = [
  "[data-dialog-key]",
  "[role='dialog']",
  "[role='menu']",
  ".litecontextmenu",
  ".comfyui-menu",
  ".comfyui-popup",
].join(", ");

// DOM 原文账本：翻译改写前记录原文，供语言切换/关闭翻译时恢复。
// 使用 Map 以便遍历；恢复/清理后释放，避免长期持有已销毁节点。
const domTextOrig = new Map();
const domAttrOrig = new Map();

function rememberAttr(el, key, value) {
  const prev = domAttrOrig.get(el) || {};
  if (!(key in prev)) prev[key] = value;
  domAttrOrig.set(el, prev);
}

function pruneDomLedger() {
  for (const node of domTextOrig.keys()) {
    if (!node.isConnected) domTextOrig.delete(node);
  }
  for (const el of domAttrOrig.keys()) {
    if (!el.isConnected) domAttrOrig.delete(el);
  }
}

export function restoreDomTranslations() {
  try {
    // 先恢复文本节点，避免直接替换叶子元素的 textContent 重建 Vue 管理的文本节点
    for (const [node, orig] of domTextOrig) {
      if (node.isConnected && node.nodeValue !== orig) node.nodeValue = orig;
    }
    for (const [el, orig] of domAttrOrig) {
      if (!el.isConnected) continue;
      if (orig.textContent !== undefined && el.textContent !== orig.textContent) {
        el.textContent = orig.textContent;
      }
      if (orig.title !== undefined && el.title !== orig.title) el.title = orig.title;
      if (orig.value !== undefined && el.value !== orig.value) el.value = orig.value;
      if (orig.placeholder !== undefined && el.placeholder !== orig.placeholder) el.placeholder = orig.placeholder;
      if (orig["aria-label"] !== undefined && el.getAttribute?.("aria-label") !== orig["aria-label"]) {
        el.setAttribute("aria-label", orig["aria-label"]);
      }
      if (orig.optionText !== undefined && el.text !== orig.optionText) el.text = orig.optionText;
    }
  } catch (e) {
    error("恢复 DOM 原文失败:", e);
  } finally {
    domTextOrig.clear();
    domAttrOrig.clear();
  }
}

export function translateAllDom(T) {
  try {
    if (!T) return;
    texe.T = T;
    texe.translateAllText(document.body);
  } catch (e) {
    error("重新翻译界面失败:", e);
  }
}

/**
 * 关闭翻译后的兜底：直接把节点 DOM 里的中文译文改回英文原文。
 * Vue/Nodes 2.0 组件可能缓存了译文文本，仅恢复账本不足以刷新；
 * reverseMap 是「中文译文 → 英文原文」。
 */
export function restoreNodeDomText(reverseMap, skipNodeIds) {
  try {
    if (!reverseMap || !reverseMap.size) return;
    const roots = document.querySelectorAll("[data-node-id], .lg-node");
    for (const root of roots) {
      const nodeId = root.getAttribute("data-node-id");
      // 子图容器接口由用户自主命名，关闭翻译时也不能改
      if (skipNodeIds && nodeId && skipNodeIds.has(nodeId)) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        // 端口名可能是用户手动改的中文，关闭翻译时不能按字典反向覆盖
        if (node.parentElement && node.parentElement.closest(".lg-slot")) continue;
        const value = node.nodeValue;
        const key = value && value.trim();
        if (key && reverseMap.has(key)) {
          node.nodeValue = value.replace(key, reverseMap.get(key));
        }
      }
      for (const el of root.querySelectorAll("[title], [aria-label], [placeholder]")) {
        for (const attr of ["title", "aria-label", "placeholder"]) {
          const value = el.getAttribute(attr);
          if (value && reverseMap.has(value)) {
            el.setAttribute(attr, reverseMap.get(value));
          }
        }
      }
    }
  } catch (e) {
    error("恢复节点 DOM 原文失败:", e);
  }
}

/**
 * 停止界面翻译：断开所有观察器并清空字典。
 * 关闭翻译时必须调用，否则已注册的观察器仍会用旧字典翻译新出现的
 * 面板/菜单，表现为关闭后依然显示译文。
 */
export function stopMenuTranslation() {
  try {
    texe.cleanupObservers();
    texe.T = null;
  } catch (e) {
    error("停止界面翻译失败:", e);
  }
}

export function applyMenuTranslation(T) {
  try {
    texe.cleanupObservers();
    texe.T = T;
    loadCategorySegments();
    
    texe.translateAllText(document.querySelector(".litegraph"));
    
    let _bodyDebounceRaf = null;
    let _bodyPendingMutations = [];
    
    const bodyObserver = observeFactory(document.querySelector("body.litegraph"), (mutationsList) => {      // 【立即检测】在防抖之前，同步检测新增的 .p-tree 元素
      for (const mutation of mutationsList) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList?.contains('p-tree')) {
              setupTreeObserver(node);
            } else if (node.querySelectorAll) {
              node.querySelectorAll('.p-tree').forEach(setupTreeObserver);
            }
            // 弹窗/设置面板/右键菜单：不等防抖，立即入队翻译
            // （translateAllText 内部用微任务合批，能在首帧绘制前完成替换）
            // 兼容旧模态框 .comfy-modal、PrimeVue .p-dialog-mask，
            // Reka 对话框（[data-dialog-key] / [role="dialog"]），
            // 以及新版/旧版右键菜单（[role="menu"] / .litecontextmenu）
            let overlay = null;
            if (node.classList?.contains("comfy-modal")) {
              overlay = node;
            } else if (node.classList?.contains("p-dialog-mask")) {
              overlay = node.querySelector(".p-dialog") || node;
            } else if (node.matches?.(IMMEDIATE_OVERLAY_SELECTOR)) {
              overlay = node;
            } else if (node.querySelector) {
              overlay = node.querySelector(IMMEDIATE_OVERLAY_SELECTOR);
            }
            if (overlay) {
              texe.translateAllText(overlay);
              // 立即注册内部观察者：设置项等后续渲染内容第一时间翻译，
              // 不再等 body 级 16ms 防抖
              if (!overlay._uiiaiii_settings_observed) {
                overlay._uiiaiii_settings_observed = true;
                const overlayObserver = observeFactory(overlay, handleNewSettingsObserver, true);
                if (overlayObserver) texe.observers.push(overlayObserver);
              }
            }
          }
        }
      }
      
      _bodyPendingMutations.push(...mutationsList);
      if (_bodyDebounceRaf !== null) cancelAnimationFrame(_bodyDebounceRaf);
      // 用 requestAnimationFrame 而不是 setTimeout(16)：回调在下一帧绘制前
      // 执行，译文能赶在首帧显示，避免可见的「先英文后中文」
      _bodyDebounceRaf = requestAnimationFrame(() => {
        _bodyDebounceRaf = null;
        const mutations = _bodyPendingMutations;
        _bodyPendingMutations = [];
        
        if (_isTranslating) {
          // 被阻塞时不丢弃，收集到调度器延迟处理
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) scheduleTranslation(node);
            }
          }
          return;
        }
        _isTranslating = true;
        try {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              // 搜索元素由 setupSearchBoxObserver 专责处理
              if (isSearchRelatedElement(node)) continue;
              if (node.classList?.contains("comfy-modal")) {
                texe.translateAllText(node);
                observeModalNode(node);
              } else if (node.classList?.contains("p-dialog-mask")) {
                const dialog = node.querySelector(".p-dialog");
                if (dialog) {
                  texe.translateAllText(dialog);
                  // 面板内部的新增项（虚拟滚动、切换标签页）立即翻译，
                  // 不再等 body 级 16ms 防抖
                  if (!dialog._uiiaiii_settings_observed) {
                    dialog._uiiaiii_settings_observed = true;
                    const panelObserver = observeFactory(dialog, handleNewSettingsObserver, true);
                    if (panelObserver) texe.observers.push(panelObserver);
                  }
                  const dialogObserver = observeFactory(dialog, handleSettingsDialog, dialog?.role === "dialog");
                  if (dialogObserver) texe.observers.push(dialogObserver);
                }
              } else {
                texe.translateAllText(node);
              }
            }
          }
        } finally {
          setTimeout(() => { _isTranslating = false; }, 0);
        }
      });
      // 最后一个参数关闭 attributes：body 子树里的 style/class 高频变化
      // （Nodes 2.0 拖拽、动画）不再产生无用 mutation 记录；
      // 回调本身只消费 addedNodes，因此翻译行为不变
    }, true, false);
    
    texe.observers.push(bodyObserver);
    
    document.querySelectorAll(".comfy-modal").forEach(node => {
      observeModalNode(node);
    });
    
    if (document.querySelector(".comfyui-menu")) {
      const menuObserver = observeFactory(document.querySelector(".comfyui-menu"), handleComfyNewUIMenu, true);
      texe.observers.push(menuObserver);
    }
    
    document.querySelectorAll(".comfyui-popup").forEach(node => {
      const popupObserver = observeFactory(node, handleComfyNewUIMenu, true);
      texe.observers.push(popupObserver);
    });

    // 初始翻译已存在的内容（顶部菜单按钮等先于 Observer 渲染的文本）
    document.querySelectorAll(".comfyui-menu, .comfyui-popup").forEach(el => texe.translateAllText(el));

    handleHistoryAndQueueButtons();
    handleSettingsDialog();
    setupSearchBoxObserver();
    setupTreeTranslationObserver();
  } catch (e) {
    error("应用菜单翻译出错:", e);
  }
}

export function observeFactory(observeTarget, fn, subtree = false, observeAttributes = true) {
  if (!observeTarget) return null;
  try {
    const observer = new MutationObserver(function (mutationsList, observer) {
      fn(mutationsList, observer);
    });
    observer.observe(observeTarget, {
      childList: true,
      attributes: observeAttributes,
      subtree: subtree
    });
    return observer;
  } catch (e) {
    error("创建观察者出错:", e);
    return null;
  }
}

function observeModalNode(node) {
  const observer = observeFactory(node, (mutationsList) => {
    for (let mutation of mutationsList) {
      texe.translateAllText(mutation.target);
    }
  });
  if (observer) {
    texe.observers.push(observer);
  }
}

let _menuDebounceRaf = null;
let _menuPendingMutations = [];

function handleComfyNewUIMenu(mutationsList) {
  // 【立即检测】在防抖之前，同步检测 .p-tree 元素
  for (const mutation of mutationsList) {
    const target = mutation.target;
    if (target?.nodeType === Node.ELEMENT_NODE) {
      if (target.classList?.contains('p-tree')) {
        setupTreeObserver(target);
      } else if (target.querySelectorAll) {
        target.querySelectorAll('.p-tree').forEach(setupTreeObserver);
      }
    }
    if (mutation.type === "childList") {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.classList?.contains('p-tree')) {
            setupTreeObserver(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll('.p-tree').forEach(setupTreeObserver);
          }
        }
      }
    }
  }
  
  _menuPendingMutations.push(...mutationsList);
  if (_menuDebounceRaf !== null) cancelAnimationFrame(_menuDebounceRaf);
  // 同样用 rAF：菜单展开时译文赶在首帧绘制前生效，消除右键菜单可见延迟
  _menuDebounceRaf = requestAnimationFrame(() => {
    _menuDebounceRaf = null;
    const mutations = _menuPendingMutations;
    _menuPendingMutations = [];
    
    if (_isTranslating) {
      // 被阻塞时不丢弃，收集到调度器延迟处理
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) scheduleTranslation(node);
          }
        }
      }
      return;
    }
    _isTranslating = true;
    try {
      // 去重：同一 target 只翻译一次
      const targets = new Set();
      for (const mutation of mutations) {
        targets.add(mutation.target);
      }
      for (const target of targets) {
        texe.translateAllText(target);
      }
    } finally {
      setTimeout(() => { _isTranslating = false; }, 0);
    }
  });
}

function handleHistoryAndQueueButtons() {
  const viewHistoryButton = document.getElementById("comfy-view-history-button");
  const viewQueueButton = document.getElementById("comfy-view-queue-button");

  [viewHistoryButton, viewQueueButton].filter(Boolean).forEach(btn => {
    const observer = observeFactory(btn, (mutationsList) => {
      for (let mutation of mutationsList) {
        if (mutation.type === "childList") {
          const translatedValue = texe.MT(mutation.target.textContent);
          if (translatedValue) {
            mutation.target.innerText = translatedValue;
          }
        }
      }
    });
    if (observer) {
      texe.observers.push(observer);
    }
  });
  
  if (document.querySelector(".comfy-menu")) {
    const menuObserver = observeFactory(document.querySelector(".comfy-menu"), handleViewQueueComfyListObserver);
    if (menuObserver) texe.observers.push(menuObserver);

    const comfyLists = document.querySelector(".comfy-menu").querySelectorAll(".comfy-list");
    if (comfyLists.length > 0) {
      const list0Observer = observeFactory(comfyLists[0], handleViewQueueComfyListObserver);
      if (list0Observer) texe.observers.push(list0Observer);
      
      if (comfyLists.length > 1) {
        const list1Observer = observeFactory(comfyLists[1], handleViewQueueComfyListObserver);
        if (list1Observer) texe.observers.push(list1Observer);
      }
    }
  }
}

function handleViewQueueComfyListObserver(mutationsList) {
  for (let mutation of mutationsList) {
    texe.replaceText(mutation.target);
    if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
      for (const node of mutation.addedNodes) {
        texe.replaceText(node);
      }
    }
  }
}

function handleSettingsDialog() {
  const comfySettingDialog = document.querySelector("#comfy-settings-dialog");
  if (!comfySettingDialog) return;

  if (comfySettingDialog?.querySelector("tbody")) {
    const observer = observeFactory(comfySettingDialog.querySelector("tbody"), (mutationsList) => {
      for (let mutation of mutationsList) {
        if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
          translateSettingDialog(comfySettingDialog);
        }
      }
    });
    if (observer) texe.observers.push(observer);
  }

  const newSettingsPanels = document.querySelectorAll(".p-dialog-content, .p-tabview-panels");
  for (const panel of newSettingsPanels) {
    const observer = observeFactory(panel, handleNewSettingsObserver, true);
    if (observer) texe.observers.push(observer);
  }
  
  translateSettingDialog(comfySettingDialog);
}

function handleNewSettingsObserver(mutationsList) {
  for (let mutation of mutationsList) {
    if (mutation.type === "childList") {
      for (const node of mutation.addedNodes) {
        texe.translateAllText(node);
      }
    }
  }
}

function translateSettingDialog(comfySettingDialog) {
  if (!comfySettingDialog) return;
  // 统一走递归翻译：替代 querySelectorAll("*") + innerText，
  // 避免旧版设置面板上的同步布局与重复文本拼接
  texe.replaceText(comfySettingDialog);
}

function setupSearchBoxObserver() {
  const searchObserver = observeFactory(document.querySelector(".litegraph"), (mutationsList, observer) => {
    if (!observer.searchBoxObservers) {
      observer.searchBoxObservers = [];
    }
    
    for (let mutation of mutationsList) {
      if (mutation.removedNodes.length > 0 && observer.searchBoxObservers.length > 0) {
        observer.searchBoxObservers.forEach(ob => {
          if (ob && typeof ob.disconnect === 'function') {
            ob.disconnect();
          }
        });
        observer.searchBoxObservers = [];
        continue;
      }
      
      for (const sb of mutation.addedNodes) {
        if (!sb || !sb.querySelector) continue;
        const helper = sb.querySelector(".helper");
        if (!helper) continue;
        
        const helperObserver = observeFactory(helper, (mutationsList) => {
          for (let mutation of mutationsList) {
            for (const item of mutation.addedNodes) {
              if (item.innerText && texe.T.Nodes[item.innerText]) {
                item.innerText = texe.T.Nodes[item.innerText]["title"] || item.innerText;
              }
            }
          }
        });
        
        if (helperObserver) {
          observer.searchBoxObservers.push(helperObserver);
        }
        
        for (let item of helper.querySelectorAll(".lite-search-item")) {
          if (item.innerText && texe.T.Nodes[item.innerText]) {
            item.innerText = texe.T.Nodes[item.innerText]["title"] || item.innerText;
          }
        }
      }
    }
  });
  
  if (searchObserver) texe.observers.push(searchObserver);
}

// ========== 子图区域（PrimeVue Tree）专用翻译 ==========
// 绕开 tSkip 的 p-tree 排除，直接遍历翻译树内文本节点

let _treeDebounceRaf = null;

/**
 * 直接遍历 .p-tree 内的文本节点进行翻译，绕开 tSkip 的 p-tree 排除
 * 不经过 replaceText/tSkip，直接调用 texe.MT() 查询翻译并替换
 * @param {Element} treeRoot - .p-tree 根元素
 */
function translateTreeLabels(treeRoot) {
  if (!treeRoot || !texe.T) return;
  try {
    const walker = document.createTreeWalker(treeRoot, NodeFilter.SHOW_TEXT, null, false);
    let textNode;
    while (textNode = walker.nextNode()) {
      const txt = textNode.textContent?.trim();
      if (!txt) continue;
      if (isAlreadyTranslatedText(txt)) continue;
      const translated = texe.MTTree(txt);
      if (translated && translated !== txt) {
        textNode.textContent = textNode.textContent.replace(txt, translated);
      }
    }
  } catch (e) {
    error("翻译Tree标签出错:", e);
  }
}

/**
 * 为单个 .p-tree 元素设置 MutationObserver，监听展开/收起等变化
 * 首次调用时立即执行翻译，后续变化经 16ms 防抖后重新翻译
 * @param {Element} treeEl - .p-tree 元素
 */
function setupTreeObserver(treeEl) {
  if (!treeEl || texe.observedTrees.has(treeEl)) return;
  texe.observedTrees.add(treeEl);

  // 首次翻译
  translateTreeLabels(treeEl);

  // 监听树的变化（展开/收起/切换），16ms 防抖
  const observer = observeFactory(treeEl, () => {
    if (_treeDebounceRaf !== null) cancelAnimationFrame(_treeDebounceRaf);
    _treeDebounceRaf = requestAnimationFrame(() => {
      _treeDebounceRaf = null;
      translateTreeLabels(treeEl);
    });
  }, true);

  if (observer) texe.observers.push(observer);
}

/**
 * 查找所有 .p-tree 元素并设置翻译 Observer
 * 在 applyMenuTranslation 末尾调用，以及检测到新 .p-tree 时调用
 */
function setupTreeTranslationObserver() {
  document.querySelectorAll('.p-tree').forEach(setupTreeObserver);
}