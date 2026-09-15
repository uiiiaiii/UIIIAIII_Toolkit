/**
 * ComfyUI-Translation 设置面板模块
 * 负责：设置项注册、翻译按钮、插件翻译管理面板
 */

import { $el } from "../../../scripts/ui.js";
import {
  isTranslationEnabled,
  toggleTranslation,
  currentConfig,
  saveConfig,
  error
} from "./utils.js";

/**
 * 本地化设置项显示名：优先取翻译字典译文，未启用/无译文回退英文原文。
 */
function localizedName(en) {
  try {
    const m = (window.__UiTranslated && window.__UiTranslated.Menu) || {};
    return m[en] || en;
  } catch (e) {
    return en;
  }
}

// ─── 设置项注册 ───────────────────────────────────────────

/**
 * 在 ComfyUI 设置面板中注册所有翻译相关设置
 * @param {object} app - ComfyUI app 实例
 * @returns {Promise<void>}
 */
export async function registerSettings(app) {
  let availableLocales = ["zh-CN", "en_US"];
  try {
    const locRes = await fetch("./translation_node/get_locales");
    if (locRes.ok) availableLocales = await locRes.json();
  } catch (e) {}

  let isSettingsRegistered = false;

  // 1. 语言设置
  app.ui.settings.addSetting({
    id: "UIIIAIII Toolkit.③ Translation Settings.Language",
    name: "Language Settings (UI Translation Language)",
    type: "combo",
    options: availableLocales,
    defaultValue: currentConfig.locale,
    onChange: async (newVal) => {
      if (!isSettingsRegistered) return;
      if (newVal && newVal !== currentConfig.locale) {
        await saveConfig(currentConfig.translation_enabled, newVal, "plain");
        alert(`Language set to ${newVal}. The page will reload.`);
        location.reload();
      }
    }
  });

  // 2. COMBO 下拉选项翻译开关
  app.ui.settings.addSetting({
    id: "UIIIAIII Toolkit.③ Translation Settings.TranslateOptions",
    name: "Translate COMBO Options",
    tooltip: "Enable or disable translation of COMBO dropdown options in nodes. When off, dropdown options stay in the original English. Refresh the page after changing.",
    type: "boolean",
    defaultValue: currentConfig.translate_options,
    onChange: async (newVal) => {
      if (!isSettingsRegistered) return;
      if (newVal !== currentConfig.translate_options) {
        await saveConfig(currentConfig.translation_enabled, currentConfig.locale, "plain", currentConfig.disabled_plugins, newVal);
        location.reload();
      }
    }
  });

  isSettingsRegistered = true;

  // 主动同步 config.json 的值到 ComfyUI Settings (localStorage)，
  // 防止用户手动编辑 config.json 后 UI 显示与实际行为不一致
  try {
    const setter = app.ui.settings.setSettingValue?.bind(app.ui.settings);
    if (setter) {
      setter("UIIIAIII Toolkit.③ Translation Settings.Language", currentConfig.locale);
      setter("UIIIAIII Toolkit.③ Translation Settings.TranslateOptions", currentConfig.translate_options);
    }
  } catch (e) {
    // 旧版 ComfyUI 可能不支持 setSettingValue，忽略即可
  }
}

// ─── 翻译按钮 ─────────────────────────────────────────────

/**
 * 在顶部菜单栏添加翻译切换按钮（兼容新旧 UI）
 * @param {object} app - ComfyUI app 实例
 */
export function addPanelButtons(app) {
  try {
    if (document.getElementById("toggle-translation-button")) return;

    const translationEnabled = isTranslationEnabled();
    const locale = currentConfig.locale;

    // 按钮文本优先取翻译字典（翻译开启时显示中文），否则回退英文原文
    const menuT = window.__UiTranslated?.Menu || {};
    const onBase = menuT["Translation ON"] || "Translation ON";
    const offBase = menuT["Translation OFF"] || "Translation OFF";
    const onText = `${onBase} (${locale})`;
    const offText = `${offBase} (${locale})`;

    const styleElem = document.createElement("style");
    styleElem.textContent = `
      .translation-active-plain {
        background-color: var(--comfy-menu-bg, #353535);
        color: var(--input-text, #ffffff);
        border: 1px solid var(--border-color, #555555);
        transition: all 0.2s ease;
      }
      .translation-inactive-plain {
        background-color: var(--comfy-input-bg, #1e1e1e);
        color: var(--descrip-text, #888888);
        border: 1px solid var(--border-color, #333333);
        transition: all 0.2s ease;
      }
      .translation-btn:hover {
        transform: translateY(-1px); box-shadow: 0 4px 8px rgba(0,0,0,0.3); cursor: pointer; filter: brightness(1.1);
      }
      .translation-btn {
        cursor: pointer; border-radius: 6px; padding: 6px 12px; font-size: 12px;
      }
    `;
    document.head.appendChild(styleElem);

    const activeClass = "translation-active-plain";
    const inactiveClass = "translation-inactive-plain";

    // 旧版菜单按钮
    if (document.querySelector(".comfy-menu") && !document.getElementById("toggle-translation-button")) {
      app.ui.menuContainer.appendChild(
        $el("button.translation-btn", {
          id: "toggle-translation-button",
          textContent: translationEnabled ? onText : offText,
          className: translationEnabled ? `translation-btn ${activeClass}` : `translation-btn ${inactiveClass}`,
          style: { fontWeight: "normal", margin: "2px" },
          title: translationEnabled ? "Translation enabled" : "Using native language",
          onclick: async () => { await toggleTranslation(); },
        })
      );
    }

    // 新版 UI 按钮
    try {
      if (window?.comfyAPI?.button?.ComfyButton && window?.comfyAPI?.buttonGroup?.ComfyButtonGroup) {
        var ComfyButtonGroup = window.comfyAPI.buttonGroup.ComfyButtonGroup;
        var ComfyButton = window.comfyAPI.button.ComfyButton;

        var btn = new ComfyButton({
          action: async () => { await toggleTranslation(); },
          tooltip: translationEnabled ? "Translation enabled" : "Using native language",
          content: translationEnabled ? onText : offText,
          classList: "toggle-translation-button"
        });

        if (btn.element) {
          btn.element.classList.add("translation-btn");
          btn.element.classList.add(translationEnabled ? activeClass : inactiveClass);
          btn.element.style.fontWeight = "normal";
          btn.element.style.margin = "2px";
        }

        var group = new ComfyButtonGroup(btn.element);
        if (app.menu?.settingsGroup?.element) {
          app.menu.settingsGroup.element.before(group.element);
        }
      }
    } catch (e) {
      error("添加新版UI语言按钮失败:", e);
    }
  } catch (e) {
    error("添加面板按钮失败:", e);
  }
}

// ─── 插件翻译管理面板 ────────────────────────────────────

const SELF_NAME = "UIIIAIII Toolkit";
const PANEL_ID = "tl-plugin-manager-panel";

// 注入锁：防止并发调用导致重复注入面板
let isInjecting = false;

function buildPluginPanel(parentEl) {
  // 强制去重：如果面板已存在，直接返回
  const existing = document.getElementById(PANEL_ID);
  if (existing) return;

  const disabled = new Set(currentConfig.disabled_plugins || []);

  // 先创建面板 DOM 并设置 ID（用 <details> 实现可折叠，默认收起）
  const panel = document.createElement("details");
  panel.id = PANEL_ID;
  panel.style.cssText = "margin-top:12px;font-size:13px;";
  panel.innerHTML = `
    <summary style="cursor:pointer;padding:10px 12px;font-weight:bold;font-size:14px;user-select:none;list-style:none;display:flex;align-items:center;justify-content:space-between;">
      <span>Plugin Translation Manager</span>
      <span class="tl-toggle-hint" style="font-size:11px;color:#888;font-weight:normal;">▸ Expand</span>
    </summary>
    <div class="tl-body" style="padding:0 10px 10px;">
      <div style="margin-bottom:6px;color:#aaa;font-size:12px;">Uncheck to disable node translation for a plugin. Click Save & Reload to apply.</div>
      <input type="text" placeholder="Search plugins..." id="tl-plugin-search"
        style="width:100%;padding:5px 8px;margin-bottom:6px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#ddd;box-sizing:border-box;outline:none;" />
      <div style="display:flex;gap:6px;margin-bottom:6px;">
        <button id="tl-select-all" style="flex:1;padding:3px;border:1px solid #555;border-radius:4px;background:#333;color:#ddd;cursor:pointer;font-size:12px;">Select All</button>
        <button id="tl-deselect-all" style="flex:1;padding:3px;border:1px solid #555;border-radius:4px;background:#333;color:#ddd;cursor:pointer;font-size:12px;">Select None</button>
      </div>
      <div id="tl-plugin-list" style="height:300px;overflow-y:auto;border:1px solid #444;border-radius:4px;padding:4px;"></div>
      <div style="margin-top:8px;display:flex;align-items:center;gap:8px;">
        <button id="tl-save-plugins" style="padding:6px 20px;border:none;border-radius:4px;background:#4a9eff;color:#fff;cursor:pointer;font-weight:bold;">Save & Reload</button>
        <span id="tl-status" style="font-size:11px;color:#888;"></span>
      </div>
    </div>
  `;

  const listEl = panel.querySelector("#tl-plugin-list");
  const searchEl = panel.querySelector("#tl-plugin-search");
  // 搜索框占位符按翻译字典取文（placeholder 不受通用文本替换覆盖）
  const menuT_ph = window.__UiTranslated?.Menu || {};
  searchEl.placeholder = menuT_ph["Search plugins..."] || "Search plugins...";
  const statusEl = panel.querySelector("#tl-status");

  // 先显示加载状态
  statusEl.textContent = "Loading plugin list...";

  // 异步加载插件列表并填充内容
      fetch("./translation_node/get_plugin_list")
        .then(resp => resp.json())
        .then(plugins => {
          plugins = plugins.filter(n => n !== SELF_NAME && n !== "internal");
          // 状态文本按翻译字典拼接（"translation files"/"disabled" 是静态词，可被提取并翻译）
          const menuT_ = window.__UiTranslated?.Menu || {};
          const wordFiles = menuT_["translation files"] || "translation files";
          const wordDisabled = menuT_["disabled"] || "disabled";
          const updateStatus = () => {
            statusEl.textContent = `${plugins.length} ${wordFiles}, ${disabled.size} ${wordDisabled}`;
          };
          updateStatus();

          plugins.forEach(name => {
            const checked = !disabled.has(name);
            const div = document.createElement("div");
            div.style.cssText = "display:flex;align-items:center;padding:2px 4px;border-radius:3px;gap:4px;";
            div.innerHTML = `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;min-width:0;"><input type="checkbox" ${checked ? "checked" : ""} data-plugin="${name}" style="cursor:pointer;"> <span style="word-break:break-all;">${name}</span></label>` +
              `<button class="tl-del-btn" data-plugin="${name}" title="Delete translation files of this plugin" style="border:none;background:transparent;color:#777;cursor:pointer;font-size:12px;line-height:1;padding:2px 6px;border-radius:3px;flex:none;">✕</button>`;
            div.addEventListener("mouseenter", () => div.style.background = "#333");
            div.addEventListener("mouseleave", () => div.style.background = "");

            // 删除按钮：删除该插件的翻译文件（Nodes/Categories/Menus 三处）
            const delBtn = div.querySelector(".tl-del-btn");
            delBtn.addEventListener("mouseenter", () => delBtn.style.color = "#e05555");
            delBtn.addEventListener("mouseleave", () => delBtn.style.color = "#777");
            delBtn.addEventListener("click", async (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              // confirm 为同步原生弹窗，MutationObserver 来不及翻译，须在 JS 层查字典模板
              const msg = (menuT_["Delete the translation files of {name}?\nThis cannot be undone."] ||
                "Delete the translation files of {name}?\nThis cannot be undone.").split("{name}").join(name);
              if (!confirm(msg)) return;
              const fd = new FormData();
              fd.append("plugin", name);
              try {
                const resp = await fetch("./translation_node/delete_plugin", { method: "POST", body: fd });
                const data = await resp.json();
                if (data.success) {
                  plugins.splice(plugins.indexOf(name), 1);
                  div.remove();
                  updateStatus();
                } else {
                  error("删除翻译失败:", data.error);
                }
              } catch (err) {
                error("删除翻译失败:", err);
              }
            });

            listEl.appendChild(div);
          });
        })
        .catch(e => {
          error("获取插件列表失败:", e);
          statusEl.textContent = "Failed to load plugin list";
        });

  // 搜索过滤
  searchEl.addEventListener("input", () => {
    const q = searchEl.value.toLowerCase();
    listEl.querySelectorAll("div").forEach(d => {
      d.style.display = d.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });

  // 全选 / 全不选
  panel.querySelector("#tl-select-all").addEventListener("click", () => {
    listEl.querySelectorAll("input[type=checkbox]").forEach(cb => {
      if (cb.closest("div").style.display !== "none") cb.checked = true;
    });
  });
  panel.querySelector("#tl-deselect-all").addEventListener("click", () => {
    listEl.querySelectorAll("input[type=checkbox]").forEach(cb => {
      if (cb.closest("div").style.display !== "none") cb.checked = false;
    });
  });

  // 保存并刷新
  panel.querySelector("#tl-save-plugins").addEventListener("click", async () => {
    const newDisabled = [];
    listEl.querySelectorAll("input[type=checkbox]").forEach(cb => {
      if (!cb.checked) newDisabled.push(cb.dataset.plugin);
    });
    await saveConfig(currentConfig.translation_enabled, currentConfig.locale, "plain", newDisabled, currentConfig.translate_options);
    location.reload();
  });

  // 折叠状态提示：展开时显示 ▾，收起时显示 ▸
  const toggleHint = panel.querySelector(".tl-toggle-hint");
  if (toggleHint) {
    const updateHint = () => {
      const menuT_h = window.__UiTranslated?.Menu || {};
      const hintExpand = menuT_h["Expand"] || "Expand";
      const hintCollapse = menuT_h["Collapse"] || "Collapse";
      toggleHint.textContent = panel.open ? `▾ ${hintCollapse}` : `▸ ${hintExpand}`;
    };
    updateHint();
    panel.addEventListener("toggle", updateHint);
  }

  parentEl.appendChild(panel);

  // 移除包裹框后，让面板与上方设置项文本水平对齐，融入 UI
  // 动态测量上一设置项文本的左边缘，把结果写成 summary/内容区的 padding-left，
  // 覆盖 summary 自带的 padding:10px 12px（其 12px 左内边距正是标题偏右的根源）
  try {
    const container = panel.parentElement;
    const prev = panel.previousElementSibling;
    const summary = panel.querySelector("summary");
    const body = panel.querySelector(".tl-body");
    let indent = 0;
    if (container && prev) {
      const labelEl = prev.querySelector("label, [class*='label'], span") || prev;
      indent = Math.max(0, Math.round(labelEl.getBoundingClientRect().left - container.getBoundingClientRect().left));
    }
    if (summary) summary.style.paddingLeft = indent + "px";
    if (body) body.style.paddingLeft = indent + "px";
  } catch (e) {
    error("对齐插件翻译管理面板失败:", e);
  }
}

function tryInjectPluginPanel() {
  // 检查注入锁，防止并发调用
  if (isInjecting) return;
  // 检查面板是否已存在
  if (document.getElementById(PANEL_ID)) return;

  isInjecting = true;
  try {
    // 持有锁后再次检查，防止并发调用已注入面板
    if (document.getElementById(PANEL_ID)) return;

    // 新版 UI
    const allSettingItems = document.querySelectorAll('[class*="setting-item"], [class*="SettingItem"], .p-fieldset, .p-panel');
    for (const item of allSettingItems) {
      if (item.textContent?.includes("Translate COMBO Options") || item.textContent?.includes("翻译下拉选项")) {
        const container = item.closest('[class*="group"], [class*="category"], .p-fieldset-content, .p-panel-content') || item.parentElement;
        if (container) buildPluginPanel(container);
        return;
      }
    }

    // 旧版 UI
    const oldDialog = document.querySelector("#comfy-settings-dialog");
    if (oldDialog) {
      const tbody = oldDialog.querySelector("tbody");
      if (tbody) {
        const rows = tbody.querySelectorAll("tr");
        for (const row of rows) {
          if (row.textContent?.includes("Translate COMBO") || row.textContent?.includes("翻译下拉")) {
            buildPluginPanel(tbody);
            return;
          }
        }
      }
    }
  } finally {
    // 同步解锁，不用 requestAnimationFrame
    isInjecting = false;
  }
}

/**
 * 监听设置面板打开，自动注入插件翻译管理面板
 */
export function setupPluginManager() {
  const observer = new MutationObserver(() => tryInjectPluginPanel());
  observer.observe(document.body, { childList: true, subtree: true });
}
