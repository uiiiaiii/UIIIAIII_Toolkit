/**
 * 随机噪波节点的「🎲 随机 / ♻️ 上次」按钮
 *
 * 逻辑与 Efficient 插件的效率采样随机控制一致：
 * - seed 为有效值：点击按钮保存为"上次"，并切到 -1（表示随机）
 * - seed = -1：点击按钮恢复"上次"的 seed
 * - 提交时：seed=-1 则随机生成一个新种子，并记录为上次
 *
 * 注册方式与其他文件一致：使用全局 window.app，
 * 轮询 app 就绪后调用 app.registerExtension。
 */

const NODE_ID = "RandomNoiseSeed"; // 对应 nodes.py 中的 class mapping 键名
const SEED_NAME = "noise_seed";
const NAMESPACE = "UIIIAIII Toolkit";

// 按钮文案片段（英文原文 source），由插件的翻译开关按字典翻译为界面语言。
// 采用"英文片段 + tr() 查字典"而非硬编码中文，符合本插件"英文源 + 翻译自身"的约定。
const BTN_RANDOM = "🎲 Random";
const BTN_LAST = "♻️ Last";

/**
 * 查询当前界面语言的译文；翻译关闭或未加载字典时返回英文原文
 * @param {string} s 英文原文
 * @returns {string}
 */
function tr(s) {
    const menu = window.__UiTranslated && window.__UiTranslated.Menu;
    return (menu && menu[s]) || s;
}

class _NoiseSeedControl {
    constructor(node) {
        this.lastSeed = -1;
        this.serializedCtx = {};
        this.node = node;

        // 移除 ComfyUI 自带的"生成后控制"下拉（fixed/randomize/increment/decrement），
        // 避免与我们的"随机/上次"按钮冲突，只保留按钮交互
        for (let i = this.node.widgets.length - 1; i >= 0; i--) {
            if (this.node.widgets[i].name === "control_after_generate") {
                this.node.widgets.splice(i, 1);
            }
        }

        for (const w of this.node.widgets) {
            if (w.name === SEED_NAME) {
                this.seedWidget = w;
            }
        }

        if (!this.seedWidget) {
            return;
        }

        const max = Math.min(1125899906842624, this.seedWidget.options.max ?? Number.MAX_SAFE_INTEGER);
        const min = Math.max(-1125899906842624, this.seedWidget.options.min ?? 0);
        const step = this.seedWidget.options.step ?? 1;
        const range = (max - min) / (step / 10);

        this.button = this.node.addWidget(
            "button",
            `${tr(BTN_RANDOM)} / ${tr(BTN_LAST)}`,
            null,
            () => {
                const isValidValue =
                    Number.isInteger(this.seedWidget.value) &&
                    this.seedWidget.value >= min &&
                    this.seedWidget.value <= max;

                // 当前显示"上次"占位（lastSeed 未知）且种子为 -1 时，点击无操作。
                // 原实现依赖按钮英文名是否含 "Last"，翻译成中文后判断会失效，故改用状态判断。
                if (this.lastSeed === -1 && this.seedWidget.value == -1) {
                    return;
                }

                if (isValidValue && this.seedWidget.value != -1) {
                    this.lastSeed = this.seedWidget.value;
                    this.seedWidget.value = -1;
                } else if (this.lastSeed !== -1) {
                    this.seedWidget.value = this.lastSeed;
                } else {
                    this.seedWidget.value = -1;
                }

                if (isValidValue) {
                    this.updateButtonLabel();
                }
            },
            { serialize: false }
        );

        // 序列化时处理 -1（随机）
        this.seedWidget.serializeValue = async (node, index) => {
            const currentSeed = this.seedWidget.value;
            this.serializedCtx = { wasSpecial: currentSeed == -1 };

            let seedUsed;
            if (this.serializedCtx.wasSpecial) {
                seedUsed = Math.floor(Math.random() * range) * (step / 10) + min;
            } else {
                seedUsed = this.seedWidget.value;
            }

            seedUsed = Number.isInteger(seedUsed)
                ? Math.min(Math.max(seedUsed, min), max)
                : this.seedWidget.value;

            // 把提交值写入序列化数组（后端实际使用该值）
            if (node && node.widgets_values) {
                node.widgets_values[index] = seedUsed;
            }

            // 记录"上次"种子并更新按钮标签。
            // 注意：不要修改 this.seedWidget.value，否则执行时会闪变成随机种子，
            // 再靠 afterQueued 改回 -1，造成界面闪烁（Efficient 插件同样不改显示值）。
            this.serializedCtx.seedUsed = seedUsed;
            this.lastSeed = seedUsed;
            this.updateButtonLabel();

            return seedUsed;
        };

        this.seedWidget.afterQueued = () => {
            if (this.serializedCtx.wasSpecial) {
                this.seedWidget.value = -1;
            }
            if (this.seedWidget.value !== -1) {
                this.lastSeed = this.seedWidget.value;
            }
            this.updateButtonLabel();
            this.serializedCtx = {};
        };

        // 初始化按钮文案（label 与 name 同步，避免首次绘制取到旧值）
        this.updateButtonLabel();
    }

    updateButtonLabel() {
        const prev = this.lastSeed === -1 ? tr(BTN_LAST) : `♻️ ${this.lastSeed}`;
        const text = `${tr(BTN_RANDOM)} / ${prev}`;
        this.button.name = text;
        // LiteGraph 绘制按钮时优先取 label，需与 name 同步，否则状态变化后文案不刷新
        this.button.label = text;
        this.node.setDirtyCanvas(true, true);
    }
}

function registerNoiseSeedControl() {
    const comfyApp = window.comfyAPI?.app?.app || window.app;
    if (!comfyApp || typeof comfyApp.registerExtension !== "function") {
        setTimeout(registerNoiseSeedControl, 500);
        return;
    }

    comfyApp.registerExtension({
        name: "UIIIAIII Toolkit.RandomNoiseSeedControl",
        async beforeRegisterNodeDef(nodeType, nodeData, _app) {
            if (nodeData.name !== NODE_ID) return;

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const res = onNodeCreated ? onNodeCreated.apply(this, []) : undefined;
                try {
                    this.noiseSeedControl = new _NoiseSeedControl(this);
                } catch (e) {
                    console.error(`[${NAMESPACE}] 随机噪波按钮初始化失败:`, e);
                }
                return res;
            };
        },
    });
}

registerNoiseSeedControl();