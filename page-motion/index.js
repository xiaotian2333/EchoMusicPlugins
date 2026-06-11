const STORAGE_KEY = "page-motion-settings";

const TRANSITION_PRESETS = {
  slideFade: {
    label: "上滑淡入",
    description: "沿用主页面原本的上滑淡入手感。",
    durationMs: 450,
    easing: "ease-out",
    enterTranslateX: 0,
    enterTranslateY: 6,
    leaveTranslateX: 0,
    leaveTranslateY: 0,
    enterScale: 1,
    leaveScale: 1,
    enterFilter: "none",
    leaveFilter: "none",
  },
  calm: {
    label: "柔和浮入",
    description: "轻微上浮，适合日常使用。",
    durationMs: 300,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    enterTranslateX: 0,
    enterTranslateY: 10,
    leaveTranslateX: 0,
    leaveTranslateY: -6,
    enterScale: 0.99,
    leaveScale: 0.995,
    enterFilter: "none",
    leaveFilter: "none",
  },
  crisp: {
    label: "轻快侧滑",
    description: "横向切换更明显，速度更快。",
    durationMs: 220,
    easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    enterTranslateX: 12,
    enterTranslateY: 0,
    leaveTranslateX: -8,
    leaveTranslateY: 0,
    enterScale: 1,
    leaveScale: 1,
    enterFilter: "none",
    leaveFilter: "none",
  },
  depth: {
    label: "景深淡入",
    description: "加入轻微缩放和模糊，层次感更强。",
    durationMs: 360,
    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    enterTranslateX: 0,
    enterTranslateY: 14,
    leaveTranslateX: 0,
    leaveTranslateY: -8,
    enterScale: 0.975,
    leaveScale: 1.01,
    enterFilter: "blur(2px)",
    leaveFilter: "blur(1px)",
  },
};

const DEFAULT_SETTINGS = {
  enabled: true,
  preset: "slideFade",
  durationMs: TRANSITION_PRESETS.slideFade.durationMs,
  appear: true,
};

const LEGACY_PRESET_KEYS = {
  fade: "slideFade",
};

let runtimeCtx = null;
let state = null;
let transitionDispose = null;
let settingsDispose = null;
let settingsStyleDispose = null;

const SETTINGS_CSS = `
.echo-page-motion-settings {
  display: grid;
  gap: 14px;
  min-width: 0;
}

.echo-page-motion-section {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  background: var(--control-muted-bg);
}

.echo-page-motion-title {
  color: var(--color-text-main);
  font-size: 13px;
  font-weight: 800;
}

.echo-page-motion-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(150px, 220px);
  align-items: center;
  gap: 14px;
}

.echo-page-motion-field.is-switch {
  grid-template-columns: minmax(0, 1fr) auto;
}

.echo-page-motion-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.echo-page-motion-label {
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 700;
}

.echo-page-motion-description {
  color: color-mix(in srgb, var(--color-text-main) 56%, transparent);
  font-size: 11px;
  line-height: 1.5;
}

.echo-page-motion-host-select,
.echo-page-motion-host-slider {
  width: 100%;
  justify-self: end;
}

.echo-page-motion-actions {
  display: flex;
  justify-content: flex-end;
}

@media (max-width: 640px) {
  .echo-page-motion-field,
  .echo-page-motion-field.is-switch {
    grid-template-columns: 1fr;
  }

  .echo-page-motion-host-select,
  .echo-page-motion-host-slider {
    justify-self: stretch;
  }

  .echo-page-motion-actions {
    justify-content: flex-start;
  }
}
`;

const normalizeSettings = (value = {}) => {
  const input = value && typeof value === "object" ? value : {};
  const rawPreset = String(input.preset || "");
  const presetKey = LEGACY_PRESET_KEYS[rawPreset] || rawPreset;
  const preset = TRANSITION_PRESETS[presetKey]
    ? presetKey
    : DEFAULT_SETTINGS.preset;
  const durationMs = Number(input.durationMs);

  return {
    enabled:
      typeof input.enabled === "boolean" ? input.enabled : DEFAULT_SETTINGS.enabled,
    preset,
    durationMs: Number.isFinite(durationMs)
      ? Math.max(80, Math.min(900, Math.round(durationMs)))
      : TRANSITION_PRESETS[preset].durationMs,
    appear:
      typeof input.appear === "boolean" ? input.appear : DEFAULT_SETTINGS.appear,
  };
};

const clearTransition = () => {
  transitionDispose?.();
  transitionDispose = null;
};

const applySettings = () => {
  if (!runtimeCtx || !state) return;

  clearTransition();

  if (!runtimeCtx.theme?.pageTransition?.set) {
    runtimeCtx.toast.warning("当前 EchoMusic 版本不支持页面动效插件能力");
    return;
  }

  if (!state.settings.enabled) {
    transitionDispose = runtimeCtx.theme.pageTransition.set({ enabled: false });
    return;
  }

  const preset = TRANSITION_PRESETS[state.settings.preset] || TRANSITION_PRESETS.slideFade;
  transitionDispose = runtimeCtx.theme.pageTransition.set({
    enabled: true,
    mode: "out-in",
    appear: state.settings.appear,
    durationMs: state.settings.durationMs,
    easing: preset.easing,
    enterOpacity: 0,
    leaveOpacity: 0,
    enterTranslateX: preset.enterTranslateX,
    enterTranslateY: preset.enterTranslateY,
    leaveTranslateX: preset.leaveTranslateX,
    leaveTranslateY: preset.leaveTranslateY,
    enterScale: preset.enterScale,
    leaveScale: preset.leaveScale,
    enterFilter: preset.enterFilter,
    leaveFilter: preset.leaveFilter,
  });
};

const persistSettings = async () => {
  if (!runtimeCtx || !state) return;
  await runtimeCtx.storage.set(STORAGE_KEY, { ...state.settings });
};

const updateSettings = (patch) => {
  if (!state) return;
  state.settings = normalizeSettings({ ...state.settings, ...patch });
  applySettings();
  void persistSettings();
};

const createSettingsComponent = (ctx) => {
  const { defineComponent } = ctx.vue;

  return defineComponent({
    name: "PageMotionSettings",
    setup() {
      const { h, defineAsyncComponent } = ctx.vue;
      const Button = defineAsyncComponent(ctx.ui.components.Button);
      const Select = defineAsyncComponent(ctx.ui.components.Select);
      const Slider = defineAsyncComponent(ctx.ui.components.Slider);
      const Switch = defineAsyncComponent(ctx.ui.components.Switch);
      const presetOptions = Object.entries(TRANSITION_PRESETS).map(([value, preset]) => ({
        label: preset.label,
        value,
      }));

      const switchControl = (key) =>
        h(Switch, {
          modelValue: Boolean(state.settings[key]),
          "onUpdate:modelValue": (value) => {
            updateSettings({ [key]: Boolean(value) });
          },
        });

      const presetSelect = () =>
        h(Select, {
          class: "echo-page-motion-host-select",
          modelValue: state.settings.preset,
          options: presetOptions,
          "onUpdate:modelValue": (value) => {
            const preset = String(value || DEFAULT_SETTINGS.preset);
            updateSettings({
              preset,
              durationMs: TRANSITION_PRESETS[preset]?.durationMs || state.settings.durationMs,
            });
          },
        });

      const durationSlider = () =>
        h(Slider, {
          class: "echo-page-motion-host-slider",
          modelValue: state.settings.durationMs,
          min: 80,
          max: 900,
          step: 10,
          showValue: true,
          valueSuffix: "ms",
          "onUpdate:modelValue": (value) => {
            updateSettings({ durationMs: Number(value) });
          },
        });

      const field = (label, description, control, options = {}) =>
        h("div", { class: ["echo-page-motion-field", options.switch ? "is-switch" : ""] }, [
          h("span", { class: "echo-page-motion-copy" }, [
            h("span", { class: "echo-page-motion-label" }, label),
            description
              ? h("span", { class: "echo-page-motion-description" }, description)
              : null,
          ]),
          control,
        ]);

      const reset = () => {
        updateSettings({ ...DEFAULT_SETTINGS });
      };

      return () => {
        const preset = TRANSITION_PRESETS[state.settings.preset] || TRANSITION_PRESETS.slideFade;

        return h("div", { class: "echo-page-motion-settings" }, [
          h("section", { class: "echo-page-motion-section" }, [
            h("div", { class: "echo-page-motion-title" }, "页面动效"),
            field(
              "启用页面切换",
              "关闭后页面切换不再播放入场动画。",
              switchControl("enabled"),
              { switch: true },
            ),
            field(
              "首次进入也播放",
              "应用启动或进入主界面时同样播放动效。",
              switchControl("appear"),
              { switch: true },
            ),
            field("动效预设", preset.description, presetSelect()),
            field("时长", "控制页面切换速度。", durationSlider()),
          ]),
          h("div", { class: "echo-page-motion-actions" }, [
            h(
              Button,
              {
                type: "button",
                variant: "ghost",
                size: "xs",
                onClick: reset,
              },
              { default: () => "恢复默认" },
            ),
          ]),
        ]);
      };
    },
  });
};

export async function activate(ctx) {
  runtimeCtx = ctx;
  state = ctx.vue.reactive({
    settings: normalizeSettings(await ctx.storage.get(STORAGE_KEY)),
  });

  settingsStyleDispose = ctx.css.inject(SETTINGS_CSS, {
    id: "page-motion-settings",
  });
  settingsDispose = ctx.ui.settings.define({
    title: "页面动效",
    description: "控制 EchoMusic 页面切换的统一入场动画。",
    component: createSettingsComponent(ctx),
  });

  applySettings();
}

export function deactivate() {
  clearTransition();
  settingsDispose?.();
  settingsStyleDispose?.();
  settingsDispose = null;
  settingsStyleDispose = null;
  runtimeCtx = null;
  state = null;
}
