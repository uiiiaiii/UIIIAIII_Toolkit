/**
 * 视频空间/时间分块采样节点的开关联动显隐
 *
 * - enable_spatial_tiling 开 → 显示 tile_size / overlap
 * - enable_temporal_tiling 开 → 显示 temporal_chunk / temporal_overlap
 * 关 → 隐藏对应参数（不占高度、不参与序列化）
 */

const NODE_ID = "VideoSpatialTileSample"; // 对应 nodes.py 中的 class mapping 键名
const NAMESPACE = "UIIIAIII Toolkit";

class _TileToggleControl {
    constructor(node) {
        this.node = node;

        // 收集相关 widget
        this.widgets = {
            spatial: [],
            temporal: [],
        };
        for (const w of node.widgets) {
            if (w.name === "tile_size" || w.name === "overlap") {
                this.widgets.spatial.push(w);
            } else if (w.name === "temporal_chunk" || w.name === "temporal_overlap") {
                this.widgets.temporal.push(w);
            }
        }
        this.spatialToggle = node.widgets.find((w) => w.name === "enable_spatial_tiling");
        this.temporalToggle = node.widgets.find((w) => w.name === "enable_temporal_tiling");
        if (!this.spatialToggle || !this.temporalToggle) {
            return;
        }

        this.spatialVisible = null;
        this.temporalVisible = null;

        this.spatialToggle.callback = (v) => {
            this.setVisibility("spatial", !!v);
        };
        this.temporalToggle.callback = (v) => {
            this.setVisibility("temporal", !!v);
        };

        // 初始化一次（等 widget 布局就绪后）
        requestAnimationFrame(() => {
            this.setVisibility("spatial", !!this.spatialToggle.value);
            this.setVisibility("temporal", !!this.temporalToggle.value);
        });
    }

    setVisibility(kind, visible) {
        const key = kind === "spatial" ? "spatialVisible" : "temporalVisible";
        if (this[key] === visible) return;
        this[key] = visible;

        for (const w of this.widgets[kind]) {
            if (visible) {
                w.computeSize = w._origComputeSize;
                w.serializeValue = w._origSerialize || w.serializeValue;
                if (w.type === "converted-widget") { w.type = w._origType || "number"; }
            } else {
                if (!w._origComputeSize) { w._origComputeSize = w.computeSize; }
                if (!w._origSerialize) { w._origSerialize = w.serializeValue; }
                if (!w._origType) { w._origType = w.type; }
                w.computeSize = () => [0, -4];
                w.serializeValue = () => undefined;
            }
        }
        if (this.node.setSize) { this.node.setSize(); }
        if (this.node.setDirtyCanvas) { this.node.setDirtyCanvas(true, true); }
    }
}

function registerTileToggle() {
    const comfyApp = window.comfyAPI?.app?.app || window.app;
    if (!comfyApp || typeof comfyApp.registerExtension !== "function") {
        setTimeout(registerTileToggle, 500);
        return;
    }

    comfyApp.registerExtension({
        name: "UIIIAIII Toolkit.VideoSpatialTileSampleToggle",
        async beforeRegisterNodeDef(nodeType, nodeData, _app) {
            if (nodeData.name !== NODE_ID) return;

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const res = onNodeCreated ? onNodeCreated.apply(this, []) : undefined;
                try {
                    this._tileToggle = new _TileToggleControl(this);
                } catch (e) {
                    console.error(`[${NAMESPACE}] 分块开关联动初始化失败:`, e);
                }
                return res;
            };
        },
    });
}

registerTileToggle();
