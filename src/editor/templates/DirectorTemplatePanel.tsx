import { useMemo, useState } from "react";
import { Box, Home, Shapes, Sparkles, Trees, X } from "lucide-react";
import { useDirectorStore } from "../store/directorStore";
import {
  DIRECTOR_TEMPLATES,
  type DirectorTemplateCategory,
} from "./directorTemplates";

const CATEGORY_TABS: Array<DirectorTemplateCategory | "全部"> = [
  "全部",
  "室内",
  "室外",
  "特色",
  "抽象",
  "自由搭建",
];

const CATEGORY_ICONS = {
  室内: Home,
  室外: Trees,
  特色: Sparkles,
  抽象: Shapes,
  自由搭建: Box,
} as const;

export function DirectorTemplatePanel({ onClose }: { onClose: () => void }) {
  const replaceProject = useDirectorStore((state) => state.replaceProject);
  const setTimelinePanelOpen = useDirectorStore((state) => state.setTimelinePanelOpen);
  const [category, setCategory] = useState<DirectorTemplateCategory | "全部">("全部");
  const [selectedId, setSelectedId] = useState(DIRECTOR_TEMPLATES[0]?.id ?? "");

  const templates = useMemo(
    () =>
      category === "全部"
        ? DIRECTOR_TEMPLATES
        : DIRECTOR_TEMPLATES.filter((template) => template.category === category),
    [category]
  );
  // 切换分类后原选中项可能不在列表里：自动回落到当前分类的第一个模板
  const selected =
    templates.find((template) => template.id === selectedId) ?? templates[0] ?? null;

  function applyTemplate() {
    if (!selected) return;
    // build() 每次都返回全新的工程与轨道：模板本身只读，改动场景不会污染预置
    const project = selected.build();
    replaceProject(project);
    // 模板自带演示动画，直接打开时间轴即可播放 / 导出视频
    if ((project.timeline?.tracks.length ?? 0) > 0) {
      setTimelinePanelOpen(true);
    }
    onClose();
  }

  return (
    <div
      className="template-modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="template-modal" role="dialog" aria-label="场景模板">
        <header className="template-modal-header">
          <div className="template-modal-heading">
            <h2 className="template-modal-title">场景模板</h2>
            <p className="template-modal-subtitle">
              参考 director-desk 的预置场景，套用后可直接修改
            </p>
          </div>
          <button
            aria-label="关闭模板"
            className="top-bar-action-button template-modal-close"
            type="button"
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} strokeWidth={1.8} />
          </button>
        </header>

        <div className="template-tabs" role="tablist" aria-label="模板分类">
          {CATEGORY_TABS.map((tab) => (
            <button
              key={tab}
              aria-selected={category === tab}
              className={`template-tab${category === tab ? " is-active" : ""}`}
              role="tab"
              type="button"
              onClick={() => setCategory(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="template-grid" role="group" aria-label="模板列表">
          {templates.map((template) => {
            const Icon = CATEGORY_ICONS[template.category];
            const active = selected?.id === template.id;

            return (
              <button
                key={template.id}
                aria-label={`选择模板 ${template.name}`}
                aria-pressed={active}
                className={`template-card${active ? " is-selected" : ""}`}
                type="button"
                onClick={() => setSelectedId(template.id)}
                onDoubleClick={applyTemplate}
              >
                <span
                  aria-hidden="true"
                  className="template-card-visual"
                  data-category={template.category}
                >
                  <Icon size={22} strokeWidth={1.6} />
                </span>
                <span className="template-card-type">{template.category}</span>
                <strong className="template-card-name">{template.name}</strong>
                <small className="template-card-detail">{template.detail}</small>
              </button>
            );
          })}
        </div>

        <footer className="template-modal-footer">
          <span className="template-modal-hint">
            套用会替换当前场景，可用 Ctrl+Z 撤销
          </span>
          <button
            className="template-apply-button"
            type="button"
            disabled={!selected}
            onClick={applyTemplate}
          >
            套用模板
          </button>
        </footer>
      </section>
    </div>
  );
}
