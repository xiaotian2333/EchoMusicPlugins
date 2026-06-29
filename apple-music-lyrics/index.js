const STORAGE_KEY = "apple-music-lyrics-settings";

const DEFAULT_SETTINGS = {
  enabled: true,
  bounce: 84,
  scale: 3,
  damping: 24,
  range: 4,
  springScroll: true,
};

let state = null;
let effectDispose = null;
let settingsDispose = null;
let settingsStyleDispose = null;
let saveTimer = 0;
let lastFrameTime = 0;
let frameId = 0;

const mountedHosts = new Set();

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, Number(value) || 0));

const derivative = (fn) => {
  const h = 0.001;
  return (x) => (fn(x + h) - fn(x - h)) / (2 * h);
};

const solveSpring = (from, velocity, to, params) => {
  const soft = params?.soft ?? false;
  const stiffness = params?.stiffness ?? 100;
  const damping = params?.damping ?? 10;
  const mass = params?.mass ?? 1;
  const delta = to - from;

  if (soft || 1 <= damping / (2 * Math.sqrt(stiffness * mass))) {
    const angularFrequency = -Math.sqrt(stiffness / mass);
    const leftover = -angularFrequency * delta - velocity;
    return (time) =>
      to - (delta + time * leftover) * Math.E ** (time * angularFrequency);
  }

  const dampingFrequency = Math.sqrt(4 * mass * stiffness - damping ** 2);
  const leftover = (damping * delta - 2 * mass * velocity) / dampingFrequency;
  const dfm = 0.5 * dampingFrequency / mass;
  const dm = (-0.5 * damping) / mass;
  return (time) =>
    to -
    (Math.cos(time * dfm) * delta + Math.sin(time * dfm) * leftover) *
      Math.E ** (time * dm);
};

const normalizeSettings = (value) => {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    enabled: source.enabled ?? DEFAULT_SETTINGS.enabled,
    bounce: clamp(source.bounce ?? DEFAULT_SETTINGS.bounce, 0, 100),
    scale: clamp(source.scale ?? DEFAULT_SETTINGS.scale, 0, 12),
    damping: clamp(source.damping ?? DEFAULT_SETTINGS.damping, 0, 100),
    range: clamp(source.range ?? DEFAULT_SETTINGS.range, 1, 8),
    springScroll: source.springScroll ?? DEFAULT_SETTINGS.springScroll,
  };
};

class SpringValue {
  constructor(value = 0) {
    this.value = value;
    this.target = value;
    this.time = 0;
    this.params = {};
    this.solver = () => this.target;
    this.getVelocity = () => 0;
    this.getAcceleration = () => 0;
  }

  setParams(params) {
    const nextParams = {
      ...this.params,
      ...params,
      mass: Math.max(0.1, Number(params.mass ?? this.params.mass ?? 1) || 1),
      stiffness: Math.max(
        1,
        Number(params.stiffness ?? this.params.stiffness ?? 100) || 100,
      ),
      damping: Math.max(0, Number(params.damping ?? this.params.damping ?? 10) || 0),
    };
    const unchanged =
      this.params.mass === nextParams.mass &&
      this.params.stiffness === nextParams.stiffness &&
      this.params.damping === nextParams.damping &&
      this.params.soft === nextParams.soft;
    this.params = nextParams;
    if (!unchanged) this.resetSolver();
  }

  resetSolver() {
    const velocity = this.getVelocity(this.time);
    this.time = 0;
    this.solver = solveSpring(this.value, velocity, this.target, this.params);
    this.getVelocity = derivative(this.solver);
    this.getAcceleration = derivative(this.getVelocity);
  }

  setValue(value) {
    this.value = Number(value) || 0;
    this.target = this.value;
    this.time = 0;
    this.solver = () => this.target;
    this.getVelocity = () => 0;
    this.getAcceleration = () => 0;
  }

  setTarget(value) {
    const nextTarget = Number(value) || 0;
    if (Math.abs(nextTarget - this.target) < 0.0001) return;
    this.target = nextTarget;
    this.resetSolver();
  }

  update(deltaSeconds) {
    this.time += deltaSeconds;
    this.value = this.solver(this.time);
    if (this.settled()) this.setValue(this.target);
  }

  settled() {
    return (
      Math.abs(this.value - this.target) < 0.01 &&
      Math.abs(this.getVelocity(this.time)) < 0.01 &&
      Math.abs(this.getAcceleration(this.time)) < 0.01
    );
  }
}

const scheduleSave = (ctx) => {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    if (!state) return;
    void ctx.storage.set(STORAGE_KEY, normalizeSettings(state.settings));
  }, 240);
};

const getLineStartMs = (line) => {
  const charStart = line?.characters?.[0]?.startTime;
  if (Number.isFinite(charStart)) return charStart;
  return Math.round((Number(line?.time) || 0) * 1000);
};

const computeDynamicStiffness = (snapshot, currentIndex) => {
  const lines = snapshot?.lines ?? [];
  const currentStart = getLineStartMs(lines[currentIndex]);
  const previousStart = getLineStartMs(lines[currentIndex - 1]);
  if (!Number.isFinite(currentStart) || !Number.isFinite(previousStart)) {
    return 90;
  }

  const interval = clamp(currentStart - previousStart, 100, 800);
  let ratio = 1 - (interval - 100) / 700;
  ratio = Math.pow(ratio, 0.2);
  return 170 + ratio * 50;
};

const getSpringParams = (snapshot) => {
  const settings = state?.settings ?? DEFAULT_SETTINGS;
  const dampingBias = settings.damping / 100;
  const currentIndex = Number(snapshot?.currentIndex);
  const dynamicStiffness =
    Number.isFinite(currentIndex) && currentIndex >= 0
      ? computeDynamicStiffness(snapshot, currentIndex)
      : 90;
  const bounceBias = settings.bounce / 100;
  const stiffness = 110 + (dynamicStiffness - 90) * (0.72 + bounceBias * 0.5);
  const dampingScale = 0.72 + dampingBias * 1.38;
  const damping =
    stiffness <= 95 ? 12 : Math.sqrt(stiffness) * dampingScale;

  return {
    scroll: {
      mass: 0.9,
      stiffness,
      damping,
    },
    scale: {
      mass: 2,
      stiffness: 100,
      damping: 12 + dampingBias * 22,
    },
  };
};

const ensureRowState = (entry, row) => {
  let rowState = entry.rows.get(row);
  if (rowState) return rowState;

  rowState = {
    scale: new SpringValue(1),
    opacity: new SpringValue(1),
    line: row.querySelector("[data-echo-lyric-line]"),
  };
  entry.rows.set(row, rowState);
  return rowState;
};

const applyHostSettings = (entry) => {
  if (!state) return;
  const settings = state.settings;
  entry.host.root.dataset.echoAmBounceEnabled =
    settings.enabled ? "true" : "false";
};

const applyTargets = (entry, snapshot, force = false) => {
  if (!state) return;
  entry.snapshot = snapshot;
  const settings = state.settings;
  const enabled = settings.enabled && snapshot?.hasLyrics;
  const currentIndex = Number(snapshot?.currentIndex);
  const previousIndex = entry.currentIndex;
  const hasCurrent = Number.isFinite(currentIndex) && currentIndex >= 0;
  const changed = previousIndex !== currentIndex;
  const springParams = getSpringParams(snapshot);
  const rows = entry.host.scroller.querySelectorAll("[data-echo-lyric-row]");
  const aliveRows = new Set(rows);
  const firstLine = snapshot?.lines?.[0];
  const lastLine = snapshot?.lines?.[(snapshot?.lines?.length ?? 0) - 1];
  const targetKey = [
    enabled,
    currentIndex,
    rows.length,
    getLineStartMs(firstLine),
    getLineStartMs(lastLine),
    String(firstLine?.text || "").slice(0, 12),
    String(lastLine?.text || "").slice(0, 12),
    snapshot?.reducedMotion ? "reduce" : "motion",
    settings.bounce,
    settings.scale,
    settings.damping,
    settings.range,
    settings.springScroll,
  ].join("|");

  if (!force && entry.targetKey === targetKey) return;
  entry.targetKey = targetKey;

  for (const row of Array.from(entry.rows.keys())) {
    if (!aliveRows.has(row)) entry.rows.delete(row);
  }

  rows.forEach((row) => {
    const index = Number(row.getAttribute("data-echo-lyric-index") || -1);
    const distance = hasCurrent ? index - currentIndex : 0;
    const absDistance = Math.abs(distance);
    const rowState = ensureRowState(entry, row);
    const active = enabled && distance === 0;
    const near = enabled && absDistance <= settings.range;
    const targetScale = active
      ? 1
      : near
        ? 1 - Math.min(absDistance, 4) * (settings.scale / 100)
        : 1 - settings.scale / 100;
    const targetOpacity = enabled
      ? active
        ? 1
        : near
          ? Math.max(0.28, 0.78 - absDistance * 0.1)
          : 0.22
      : 1;

    rowState.scale.setParams(springParams.scale);
    rowState.opacity.setParams({
      mass: 1,
      stiffness: 120,
      damping: 20,
    });

    rowState.scale.setTarget(enabled ? targetScale : 1);
    rowState.opacity.setTarget(targetOpacity);
  });

  entry.scroll.setParams(springParams.scroll);
  if (!enabled || !settings.springScroll) {
    entry.scrollActive = false;
    entry.scroll.setValue(entry.host.scroller.scrollTop);
    entry.scrollInitialized = false;
  }

  if (changed || force) {
    entry.currentIndex = currentIndex;
  }

  startAnimationLoop();
};

const updateRowStyles = (entry, deltaSeconds) => {
  if (!state) return;
  const settings = state.settings;
  const enabled = settings.enabled && entry.snapshot?.hasLyrics;
  let active = false;

  if (enabled && settings.springScroll && entry.scrollActive) {
    if (
      entry.scrollFinalTarget !== null &&
      performance.now() >= entry.scrollFinalTargetAt
    ) {
      entry.scroll.setTarget(entry.scrollFinalTarget);
      entry.scrollFinalTarget = null;
      entry.scrollFinalTargetAt = 0;
    }
    entry.scroll.update(deltaSeconds);
    if (Math.abs(entry.host.scroller.scrollTop - entry.scroll.value) > 0.1) {
      entry.host.scroller.scrollTop = entry.scroll.value;
    }
    if (entry.scroll.settled()) {
      entry.host.scroller.scrollTop = entry.scroll.target;
      entry.scrollActive = false;
    } else {
      active = true;
    }
  }

  for (const [row, rowState] of Array.from(entry.rows.entries())) {
    if (!row.isConnected) {
      entry.rows.delete(row);
      continue;
    }

    rowState.scale.update(deltaSeconds);
    rowState.opacity.update(deltaSeconds);
    active =
      active ||
      !rowState.scale.settled() ||
      !rowState.opacity.settled();

    if (!enabled) {
      row.style.removeProperty("--echo-am-bounce-opacity");
      rowState.line?.style.removeProperty("--echo-am-bounce-scale");
      continue;
    }

    row.style.setProperty(
      "--echo-am-bounce-opacity",
      rowState.opacity.value.toFixed(3),
    );
    rowState.line?.style.setProperty(
      "--echo-am-bounce-scale",
      rowState.scale.value.toFixed(4),
    );
  }

  return active;
};

const animationTick = (time) => {
  if (!lastFrameTime) lastFrameTime = time;
  const deltaSeconds = Math.min(0.05, Math.max(0.001, (time - lastFrameTime) / 1000));
  lastFrameTime = time;

  let active = false;
  for (const entry of mountedHosts) {
    active = updateRowStyles(entry, deltaSeconds) || active;
  }

  if (mountedHosts.size > 0 && active) {
    frameId = window.requestAnimationFrame(animationTick);
  } else {
    frameId = 0;
    lastFrameTime = 0;
  }
};

const startAnimationLoop = () => {
  if (frameId) return;
  lastFrameTime = 0;
  frameId = window.requestAnimationFrame(animationTick);
};

const mountAppleMusicBounce = (host) => {
  const entry = {
    host,
    snapshot: host.getSnapshot(),
    rows: new Map(),
    scroll: new SpringValue(host.scroller.scrollTop),
    scrollInitialized: false,
    scrollActive: false,
    scrollFinalTarget: null,
    scrollFinalTargetAt: 0,
    currentIndex: Number.NaN,
    syncFrame: 0,
    unsubscribe: null,
    autoScrollDispose: null,
  };

  const scheduleSync = (snapshot) => {
    entry.snapshot = snapshot;
    if (entry.syncFrame) return;
    entry.syncFrame = window.requestAnimationFrame(() => {
      entry.syncFrame = 0;
      applyTargets(entry, entry.snapshot);
    });
  };

  mountedHosts.add(entry);
  applyHostSettings(entry);
  applyTargets(entry, entry.snapshot, true);
  entry.autoScrollDispose = host.setAutoScrollHandler?.((request) => {
    if (!state) return false;
    const settings = state.settings;
    const enabled = settings.enabled && settings.springScroll && request.snapshot?.hasLyrics;
    entry.snapshot = request.snapshot;
    if (!enabled || !request.smooth) {
      entry.scrollActive = false;
      entry.scroll.setValue(host.scroller.scrollTop);
      entry.scrollInitialized = false;
      return false;
    }

    entry.scroll.setParams(getSpringParams(request.snapshot).scroll);
    if (!entry.scrollInitialized) {
      entry.scroll.setValue(host.scroller.scrollTop);
      entry.scrollInitialized = true;
    }
    const targetTop = Math.max(0, Number(request.targetTop) || 0);
    const currentTop = host.scroller.scrollTop;
    const distance = targetTop - currentTop;
    const direction = Math.sign(distance);
    const motionFactor = request.snapshot?.reducedMotion ? 0.25 : 1;
    const overshoot =
      direction *
      Math.min(56, Math.abs(distance) * 0.22) *
      (settings.bounce / 100) *
      motionFactor;
    if (request.snapshot?.reducedMotion || Math.abs(distance) < 12) {
      entry.scroll.setTarget(targetTop);
      entry.scrollFinalTarget = null;
      entry.scrollFinalTargetAt = 0;
    } else {
      entry.scroll.setTarget(targetTop + overshoot);
      entry.scrollFinalTarget = targetTop;
      entry.scrollFinalTargetAt = performance.now() + 115;
    }
    entry.scrollActive = true;
    startAnimationLoop();
    return true;
  });
  entry.unsubscribe = host.subscribe(scheduleSync);

  return () => {
    mountedHosts.delete(entry);
    entry.unsubscribe?.();
    entry.autoScrollDispose?.();
    if (entry.syncFrame) window.cancelAnimationFrame(entry.syncFrame);
    entry.host.root.removeAttribute("data-echo-am-bounce-enabled");
    const rows = entry.host.scroller.querySelectorAll("[data-echo-lyric-row]");
    rows.forEach((row) => {
      row.style.removeProperty("--echo-am-bounce-opacity");
      row
        .querySelector("[data-echo-lyric-line]")
        ?.style.removeProperty("--echo-am-bounce-scale");
    });
  };
};

const APPLE_MUSIC_BOUNCE_CSS = `
.echo-am-lyrics[data-echo-am-bounce-enabled="true"] [data-echo-lyric-row] {
  opacity: var(--echo-am-bounce-opacity, 1);
  will-change: opacity;
}

.echo-am-lyrics[data-echo-am-bounce-enabled="true"] [data-echo-lyric-line] {
  transform: scale(var(--echo-am-bounce-scale, 1));
  transform-origin: left center;
  will-change: transform;
}

.echo-am-lyrics[data-echo-am-bounce-enabled="false"] [data-echo-lyric-row] {
  opacity: 1;
}
`;

const SETTINGS_CSS = `
.echo-am-settings {
  display: grid;
  gap: 14px;
  color: var(--color-text-main);
}

.echo-am-settings-row {
  display: grid;
  gap: 7px;
}

.echo-am-settings-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.echo-am-settings-title {
  font-size: 13px;
  font-weight: 760;
}

.echo-am-settings-hint {
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.echo-am-settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
`;

const updateSettings = (ctx, patch) => {
  if (!state) return;
  state.settings = normalizeSettings({ ...state.settings, ...patch });
  for (const entry of mountedHosts) {
    applyHostSettings(entry);
    applyTargets(entry, entry.snapshot, true);
  }
  scheduleSave(ctx);
};

const createSettingsComponent = (ctx) =>
  ctx.vue.defineComponent({
    name: "AppleMusicLyricsSettings",
    setup() {
      const { defineAsyncComponent, h } = ctx.vue;
      const Button = defineAsyncComponent(ctx.ui.components.Button);
      const Slider = defineAsyncComponent(ctx.ui.components.Slider);
      const Switch = defineAsyncComponent(ctx.ui.components.Switch);

      const slider = (label, key, min, max, hint) =>
        h("div", { class: "echo-am-settings-row" }, [
          h("div", { class: "echo-am-settings-line" }, [
            h("span", { class: "echo-am-settings-title" }, label),
            h("span", { class: "echo-am-settings-hint" }, String(state.settings[key])),
          ]),
          h(Slider, {
            modelValue: state.settings[key],
            min,
            max,
            step: 1,
            "onUpdate:modelValue": (value) =>
              updateSettings(ctx, { [key]: Number(value) }),
          }),
          hint ? h("div", { class: "echo-am-settings-hint" }, hint) : null,
        ]);

      const toggle = (label, key, hint) =>
        h("div", { class: "echo-am-settings-row" }, [
          h("label", { class: "echo-am-settings-line" }, [
            h("span", { class: "echo-am-settings-title" }, label),
            h(Switch, {
              modelValue: Boolean(state.settings[key]),
              "onUpdate:modelValue": (value) =>
                updateSettings(ctx, { [key]: Boolean(value) }),
            }),
          ]),
          hint ? h("div", { class: "echo-am-settings-hint" }, hint) : null,
        ]);

      return () =>
        h("div", { class: "echo-am-settings" }, [
          toggle("启用弹跳", "enabled", "只影响页面歌词的行切换运动。"),
          toggle(
            "弹簧滚动",
            "springScroll",
            "接管自动跟随滚动，让整列歌词像 Apple Music 一样弹簧追随。",
          ),
          slider("弹跳力度", "bounce", 0, 100, "控制切换歌词时的回弹幅度和动态 stiffness。"),
          slider("当前行缩放", "scale", 0, 12, "接近 Apple Music 当前行轻微放大的手感。"),
          slider("阻尼", "damping", 0, 100, "越低越有弹性，越高越稳。"),
          slider("影响范围", "range", 1, 8, "当前行附近多少行参与淡入淡出和缩放。"),
          h("div", { class: "echo-am-settings-actions" }, [
            h(
              Button,
              {
                variant: "outline",
                size: "xs",
                onClick: () => updateSettings(ctx, DEFAULT_SETTINGS),
              },
              { default: () => "恢复默认" },
            ),
          ]),
        ]);
    },
  });

export async function activate(ctx) {
  state = ctx.vue.reactive({
    settings: normalizeSettings(await ctx.storage.get(STORAGE_KEY)),
  });

  settingsStyleDispose = ctx.css.inject(SETTINGS_CSS, {
    id: "apple-music-lyrics-settings",
  });

  settingsDispose = ctx.ui.settings.define({
    title: "Apple Music 歌词弹跳",
    description: "调整页面歌词切换时的 Apple Music 式弹簧回弹手感。",
    component: createSettingsComponent(ctx),
  });

  effectDispose = ctx.lyricEffects.register({
    id: "apple-music-bounce",
    title: "Apple Music 歌词弹跳",
    scope: "page",
    layer: "style",
    order: 80,
    className: "echo-am-lyrics",
    css: APPLE_MUSIC_BOUNCE_CSS,
    mount: mountAppleMusicBounce,
  });
}

export function deactivate() {
  if (saveTimer) window.clearTimeout(saveTimer);
  if (frameId) window.cancelAnimationFrame(frameId);
  saveTimer = 0;
  frameId = 0;
  lastFrameTime = 0;
  effectDispose?.();
  settingsDispose?.();
  settingsStyleDispose?.();
  effectDispose = null;
  settingsDispose = null;
  settingsStyleDispose = null;
  state = null;
  mountedHosts.clear();
}
