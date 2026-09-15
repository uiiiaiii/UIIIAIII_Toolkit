/**
 * UIIIAIII Toolkit 文本节点前端扩展
 *
 * 为 TextPreview 节点提供「上游文本自动同步到编辑框」能力：
 * - text 始终是 ComfyUI 原生可编辑多行文本框（用户可随意修改）
 * - 当 source 输入端口连接了上游时，后端通过 ui.source_text 返回上游文本
 * - 前端检测到 source_text 后，仅在「上游文本发生变化」时同步到 text 编辑框
 *   未变化时不覆盖用户的修改
 * - 不创建额外 DOM widget，不调用 setSize/arrange，避免节点尺寸被缩小
 *
 * 注册方式参考本插件 settings.js：轮询 window.app 就绪后调用 app.registerExtension。
 */

const TEXT_NODES_NAMESPACE = "UIIIAIII Toolkit-TextNodes";

/**
 * 等待 ComfyUI 前端 app 就绪后注册扩展
 *
 * @param {number} tries - 当前尝试次数
 */
function registerTextNodesExtensionWhenReady(tries = 0) {
    const comfyApp = window.comfyAPI?.app?.app || window.app;

    if (!comfyApp || typeof comfyApp.registerExtension !== "function") {
        if (tries >= 1000) {
            console.error(`[${TEXT_NODES_NAMESPACE}] app.registerExtension 不可用，无法注册文本节点扩展`);
            return;
        }
        setTimeout(() => registerTextNodesExtensionWhenReady(tries + 1), 10);
        return;
    }

    comfyApp.registerExtension({
        name: TEXT_NODES_NAMESPACE,

        /**
         * 在节点类型注册前注入 onExecuted 钩子
         *
         * 仅处理 TextPreview 节点：后端执行完成后，
         * 如果有 source_text（上游连接），同步到 text 编辑框。
         */
        beforeRegisterNodeDef(nodeType, nodeData, app) {
            // 仅处理 TextPreview 节点
            if (nodeData.name !== "TextPreview") return;

            // 保存原始 onExecuted 钩子（如有）
            const onExecuted = nodeType.prototype.onExecuted;

            // 重写 onExecuted：后端执行完成后同步上游文本到编辑框
            nodeType.prototype.onExecuted = function (message) {
                // 先调用原始钩子，保证不破坏既有逻辑
                if (onExecuted) onExecuted.apply(this, arguments);

                if (!message) return;

                // 处理上游文本同步（source_text 由后端在 source 有值时返回）
                if (message.source_text) {
                    const sourceText = Array.isArray(message.source_text)
                        ? message.source_text.join("\n")
                        : String(message.source_text);

                    // 仅在上游文本变化时同步，避免覆盖用户的修改
                    // _lastSourceText 存储上次同步的上游文本
                    if (this._lastSourceText !== sourceText) {
                        this._lastSourceText = sourceText;

                        // 找到 text widget（ComfyUI 原生可编辑文本框）
                        const textWidget = Array.isArray(this.widgets)
                            ? this.widgets.find((w) => w.name === "text")
                            : null;

                        if (textWidget) {
                            // 更新 widget 值
                            textWidget.value = sourceText;
                            // 同步到底层 textarea/input 元素（让 UI 立即显示）
                            if (textWidget.inputEl) {
                                textWidget.inputEl.value = sourceText;
                            }
                            // 触发 callback 让 ComfyUI 内部状态同步
                            if (typeof textWidget.callback === "function") {
                                try { textWidget.callback(sourceText); } catch (_) {}
                            }
                        }
                    }
                } else {
                    // 没有 source_text（未连接上游或上游为空），重置记录
                    this._lastSourceText = undefined;
                }

                // 只标记画布重绘，不调用 setSize/arrange，避免节点尺寸被缩小
                if (typeof this.setDirtyCanvas === "function") {
                    this.setDirtyCanvas(true, true);
                }
            };
        },
    });
}

// 启动注册（文件被 ComfyUI 自动加载后立即执行）
registerTextNodesExtensionWhenReady();
