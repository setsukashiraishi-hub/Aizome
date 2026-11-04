// 設定画面：左に項目の一覧、右にその内容。上の検索欄で全項目から探せる
import { h, clear } from "../core/dom";
import { t } from "../core/i18n";
import { settings, type Settings } from "../core/settings";
import { bus } from "../core/events";
import { commands, formatKey } from "../core/commands";
import { ai, dialog, osIntegration, runtimes, sys } from "../core/platform";
import { quickPick } from "./palette";
import { exportSettings, importSettings } from "./settingsTransfer";
import { toast } from "./toast";
import { basename } from "../core/paths";
import { completer } from "../ai/completer";
import { describeAiError, ensureLocalAi, useModelFile, useModelsDir } from "../ai/localAi";
import { listThemes } from "./themes";
import { icon } from "./icons";
import { confirmBox, inputBox } from "./dialog";
import { LANG_CHOICES } from "../core/langDirective";
import { ENCODINGS } from "../core/encodings";

type Key = keyof Settings;

// ───────── 部品

function row(label: string, control: HTMLElement, help?: string, inline = false) {
  return h(
    "div",
    { class: "set-row" + (inline ? " inline" : ""), "data-label": label + " " + (help ?? "") },
    h("div", { class: "set-text" }, h("span", { class: "set-label" }, label), help ? h("span", { class: "set-help" }, help) : null),
    h("div", { class: "set-control" }, control),
  );
}

function select<K extends Key>(key: K, options: { value: string; label: string }[]) {
  const el = h("select", { class: "select" }, ...options.map((o) => h("option", { value: o.value, selected: String(settings.get(key)) === o.value }, o.label)));
  el.addEventListener("change", () => settings.set(key, el.value as Settings[K]));
  return el;
}

function number<K extends Key>(key: K, min: number, max: number, step = 1) {
  const el = h("input", { class: "text-input num", type: "number", min, max, step, value: String(settings.get(key)) });
  el.addEventListener("change", () => {
    const v = Math.min(max, Math.max(min, Number(el.value) || min));
    el.value = String(v);
    settings.set(key, v as Settings[K]);
  });
  return el;
}

function text<K extends Key>(key: K, placeholder = "", type = "text") {
  const el = h("input", { class: "text-input", type, value: String(settings.get(key) ?? ""), placeholder, spellcheck: "false" });
  el.addEventListener("change", () => settings.set(key, el.value.trim() as Settings[K]));
  return el;
}

function toggle<K extends Key>(key: K) {
  const el = h("input", { type: "checkbox", class: "switch", checked: Boolean(settings.get(key)) });
  el.addEventListener("change", () => settings.set(key, el.checked as Settings[K]));
  return el;
}

function range<K extends Key>(key: K, min: number, max: number, step: number, format: (v: number) => string) {
  const out = h("span", { class: "range-value" }, format(Number(settings.get(key))));
  const el = h("input", { class: "range", type: "range", min, max, step, value: String(settings.get(key)) });
  el.addEventListener("input", () => {
    out.textContent = format(Number(el.value));
    settings.set(key, Number(el.value) as Settings[K]);
  });
  return h("div", { class: "range-row" }, el, out);
}

function color(key: "look.bgColor" | "look.accentColor", cssVar: string) {
  const current = () => settings.get(key) || getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  const toHex7 = (v: string) => (/^#[0-9a-f]{6}$/i.test(v) ? v : /^#[0-9a-f]{3}$/i.test(v) ? "#" + v.slice(1).split("").map((c) => c + c).join("") : "#000000");
  const picker = h("input", { class: "color-input", type: "color", value: toHex7(current()) });
  const code = h("input", { class: "text-input mono", type: "text", value: settings.get(key), placeholder: t("settings.themeColor"), spellcheck: "false", maxlength: 7 });
  const reset = h("button", { class: "btn small plain", type: "button", disabled: !settings.get(key) }, t("settings.reset"));
  picker.addEventListener("input", () => {
    code.value = picker.value;
    settings.set(key, picker.value);
    reset.disabled = false;
  });
  code.addEventListener("change", () => {
    const v = code.value.trim();
    if (!v || /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v)) {
      const val = v && !v.startsWith("#") ? "#" + v : v;
      settings.set(key, val);
      picker.value = toHex7(val || current());
      reset.disabled = !val;
    }
  });
  reset.addEventListener("click", () => {
    settings.set(key, "");
    code.value = "";
    requestAnimationFrame(() => (picker.value = toHex7(current())));
    reset.disabled = true;
  });
  return h("div", { class: "field-row color-row" }, picker, code, reset);
}

function button(label: string, onclick: () => unknown, kind = "plain") {
  const b = h("button", { class: `btn small ${kind}`, type: "button" }, label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await onclick();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

// ───────── 各ページ

interface Section {
  id: string;
  label: string;
  icon: string;
  build: () => HTMLElement[];
}

function aiStatusPanel(): HTMLElement {
  const panel = h("div", { class: "ai-check" });
  const line = (ok: boolean | null, label: string, detail?: string) =>
    h(
      "div",
      { class: "ai-check-line " + (ok === null ? "wait" : ok ? "ok" : "ng") },
      h("span", { class: "ai-check-mark", "aria-hidden": "true" }, ok === null ? "…" : ok ? "✓" : "✕"),
      h("div", {}, h("div", { class: "ai-check-label" }, label), detail ? h("div", { class: "ai-check-detail" }, detail) : null),
    );

  const run = async (auto: boolean) => {
    clear(panel);
    panel.append(line(null, t(auto ? "aiCheck.searching" : "aiCheck.checking")));
    if (auto) await ensureLocalAi();
    const provider = settings.get("ai.provider");
    const endpoint = settings.get("ai.endpoint");
    const model = settings.get("ai.model");
    try {
      const d = await ai.diagnose(provider, endpoint, model, settings.get("ai.apiKey") || undefined);
      clear(panel);
      panel.append(
        line(d.reachable, d.reachable ? t("aiCheck.serverOk", { endpoint }) + (d.version ? `（Ollama ${d.version}）` : "") : t("aiCheck.serverNg", { endpoint }), d.reachable ? undefined : describeAiError(d.error ?? "")),
      );
      if (d.reachable) {
        panel.append(
          line(
            d.modelFound,
            d.modelFound ? t("aiCheck.modelOk", { model }) : t("aiCheck.modelNg", { model }),
            d.modelFound ? undefined : d.models.length ? t("aiCheck.pickInstalled") : t("aiCheck.noModels"),
          ),
        );
        if (!d.modelFound && d.models.length) {
          panel.append(
            h(
              "div",
              { class: "ai-model-chips" },
              ...d.models.map((m) =>
                h("button", { class: "chip", type: "button", onclick: () => (settings.set("ai.model", m), completer.setStatus("idle"), void run(false)) }, m),
              ),
            ),
          );
        }
      }
      if (d.reachable && d.modelFound) completer.setStatus(settings.get("ai.enabled") ? "idle" : "off");
    } catch (err) {
      clear(panel);
      panel.append(line(false, t("aiCheck.failed"), describeAiError(String(err))));
    }
  };

  const wrap = h(
    "div",
    { class: "set-row block", "data-label": t("aiCheck.title") },
    h("div", { class: "set-text" }, h("span", { class: "set-label" }, t("aiCheck.title")), h("span", { class: "set-help" }, t("aiCheck.help"))),
    h("div", { class: "set-actions" }, button(t("aiCheck.auto"), () => run(true), "primary"), button(t("aiCheck.check"), () => run(false))),
    panel,
  );
  void run(false);
  return wrap;
}

function modelPicker(): HTMLElement {
  const input = text("ai.model", "qwen2.5-coder:1.5b");
  const list = h("datalist", { id: "ai-models-list" });
  input.setAttribute("list", "ai-models-list");
  completer
    .models()
    .then((ms) => ms.forEach((m) => list.append(h("option", { value: m }))))
    .catch(() => {});
  return h("div", { class: "field-row" }, input, list);
}

/** 「プログラムから開く」と右クリックメニューへの登録（Windows） */
function osRow(): HTMLElement {
  const control = h("div", { class: "field-row" }, h("span", { class: "set-help" }, "…"));
  const r = row(t("set.osIntegration"), control, t("set.osIntegrationHelp"));
  const render = async () => {
    const st = await osIntegration.status().catch(() => ({ supported: false, registered: false }));
    clear(control);
    r.querySelector(".os-default")?.remove();
    if (!st.supported) {
      control.append(h("span", { class: "set-help" }, t("set.osIntegrationAuto")));
      return;
    }
    control.append(
      h("span", { class: "set-help" }, st.registered ? t("set.osRegistered") : t("set.osNotRegistered")),
      button(st.registered ? t("set.osUnregister") : t("set.osRegister"), async () => {
        try {
          await osIntegration.set(!st.registered);
          await render();
        } catch (err) {
          control.append(h("span", { class: "set-help" }, String(err)));
        }
      }, st.registered ? "plain" : "primary"),
    );
    if (!st.registered) return;
    // いつも使うアプリ（既定のアプリ）にする：Windows では本人が選ぶ必要があるので、その画面を開く
    const fail = (err: unknown) => toast(t("set.osDefaultFailed", { err: String(err) }), "error", 8000);
    const types = h(
      "div",
      { class: "os-default" },
      h("p", { class: "set-help" }, t("set.osDefaultHelp")),
      h(
        "div",
        { class: "field-row" },
        ...[".py", ".cs", ".js", ".txt", ".json", ".md"].map((ext) =>
          button(ext, () => void osIntegration.openWith(ext).then(() => toast(t("set.osOpenWithHint", { ext }), "info", 12000)).catch(fail), "plain"),
        ),
        button(t("set.osOtherExt"), async () => {
          const ext = await inputBox({ title: t("set.osOtherExt"), placeholder: ".cpp" });
          if (ext) void osIntegration.openWith(ext).then(() => toast(t("set.osOpenWithHint", { ext }), "info", 12000)).catch(fail);
        }, "plain"),
      ),
      h("div", { class: "field-row" }, button(t("set.osDefaultApps"), () => void osIntegration.openDefaultApps().then(() => toast(t("set.osDefaultAppsHint"), "info", 12000)).catch(fail), "primary")),
    );
    control.after(types);
  };
  void render();
  return r;
}

/** 使う python.exe の場所：入力欄 ＋「選ぶ」「自動」 */
function pythonPathControl(): HTMLElement {
  const input = text("run.pythonPath", t("feat.pythonPath.auto"));
  const pick = button(t("feat.pythonPath.pick"), async () => {
    const p = await dialog.pickExe();
    if (!p) return;
    settings.set("run.pythonPath", p);
    (input as HTMLInputElement).value = p;
  });
  const listBtn = button(t("feat.pythonPath.list"), async () => {
    toast(t("feat.pythonPath.searching"), "info", 3000);
    const found = await runtimes.listPythons().catch(() => [] as Awaited<ReturnType<typeof runtimes.listPythons>>);
    if (!found.length) {
      toast(t("feat.pythonPath.none"), "warn", 6000);
      return;
    }
    const choice = await quickPick(
      found.map((f) => ({ label: `Python ${f.version}`, detail: `${f.path}（${f.source}）`, value: f })),
      t("feat.pythonPath.list"),
    );
    if (!choice) return;
    settings.set("run.pythonPath", choice.path);
    (input as HTMLInputElement).value = choice.path;
  });
  const clearBtn = button(t("feat.pythonPath.clear"), () => {
    settings.set("run.pythonPath", "");
    (input as HTMLInputElement).value = "";
  });
  return h("div", { class: "path-row" }, input, listBtn, pick, clearBtn);
}

function sections(): Section[] {
  const isOpenAI = settings.get("ai.provider") === "openai";
  const bgImage = settings.get("look.bgImage");
  return [
    {
      id: "general",
      label: t("set.general"),
      icon: "sidebar",
      build: () => [
        row(t("settings.language"), select("ui.language", [{ value: "ja", label: "日本語" }, { value: "en", label: "English" }])),
        row(t("settings.theme"), select("ui.theme", listThemes().map((th) => ({ value: th.id, label: th.label })))),
        row(t("settings.zoom"), range("look.zoom", 0.6, 1.8, 0.1, (v) => `${Math.round(v * 100)}%`), t("set.zoomHelp", { key: formatKey("Mod-;") })),
        row(
          t("transfer.row"),
          h("div", { class: "path-row" }, button(t("transfer.export"), () => exportSettings()), button(t("transfer.import"), () => importSettings())),
          t("transfer.rowHelp"),
        ),
      ],
    },
    {
      id: "features",
      label: t("set.features"),
      icon: "puzzle",
      build: () => [
        h("p", { class: "set-help feat-intro", "data-label": t("feat.intro") }, t("feat.intro")),
        h("h2", { class: "set-group-title", "data-label": t("feat.group.run") }, t("feat.group.run")),
        row(
          t("feat.runCwd"),
          select("run.cwd", [
            { value: "file", label: t("feat.runCwd.file") },
            { value: "workspace", label: t("feat.runCwd.workspace") },
            { value: "terminal", label: t("feat.runCwd.terminal") },
          ]),
          t("feat.runCwd.help"),
        ),
        row(t("feat.run_findPython"), toggle("run.findPython"), t("feat.run_findPython.help"), true),
        row(t("feat.pythonPath"), pythonPathControl(), t("feat.pythonPath.help")),
        row(t("feat.run_showFinished"), toggle("run.showFinished"), undefined, true),
        row(t("feat.showTime"), toggle("run.showTime"), undefined, true),
        row(t("feat.watch"), toggle("run.watch"), t("feat.watch.help"), true),
        row(t("feat.watchSeconds"), range("run.watchSeconds", 5, 120, 5, (v) => t("feat.watchSeconds.value", { s: String(v) }))),
        h("h2", { class: "set-group-title", "data-label": t("feat.group.lang") }, t("feat.group.lang")),
        row(t("feat.files_langDirective"), toggle("files.langDirective"), t("feat.files_langDirective.help"), true),
        row(t("feat.files_stripDirective"), toggle("files.stripDirective"), undefined, true),
        row(t("feat.editor_langTag"), toggle("editor.langTag"), undefined, true),
        row(t("feat.files_guessLanguage"), toggle("files.guessLanguage"), undefined, true),
        h("h2", { class: "set-group-title", "data-label": t("feat.group.ai") }, t("feat.group.ai")),
        row(t("feat.ai_enabled"), toggle("ai.enabled"), undefined, true),
        row(t("feat.ai_languageFilter"), toggle("ai.languageFilter"), t("feat.ai_languageFilter.help"), true),
        row(t("feat.ai_syntaxTrim"), toggle("ai.syntaxTrim"), t("feat.ai_syntaxTrim.help"), true),
        row(t("feat.ai_cpuOnly"), toggle("ai.cpuOnly"), t("feat.ai_cpuOnly.help"), true),
        row(t("feat.ai_inline"), toggle("ai.inline"), t("feat.ai_inline.help"), true),
        row(t("feat.editor_buildLens"), toggle("editor.buildLens"), undefined, true),
        h("h2", { class: "set-group-title", "data-label": t("feat.group.editor") }, t("feat.group.editor")),
        row(t("feat.editor_zenkaku"), toggle("editor.zenkaku"), undefined, true),
        row(t("feat.editor_valueHover"), toggle("editor.valueHover"), undefined, true),
        row(t("feat.gotoDefinition"), toggle("editor.gotoDefinition"), t("feat.gotoDefinition.help"), true),
        row(t("feat.indentFollow"), toggle("editor.indentFollow"), t("feat.indentFollow.help"), true),
        row(t("feat.clipHistory"), toggle("clip.history"), t("feat.clipHistory.help"), true),
        row(t("feat.checkTools"), toggle("run.checkTools"), t("feat.checkTools.help"), true),
        row(t("feat.notifyChanged"), toggle("run.notifyChanged"), t("feat.notifyChanged.help"), true),
        row(t("feat.formatter"), toggle("editor.externalFormatter"), t("feat.formatter.help"), true),
        row(t("feat.sideAuto"), toggle("ui.sidebarAutoCollapse"), t("feat.sideAuto.help"), true),
        row(t("feat.liveCheck"), toggle("editor.liveCheck"), t("feat.liveCheck.help"), true),
        row(t("feat.pythonCheck"), toggle("editor.pythonCheck"), t("feat.pythonCheck.help"), true),
        row(t("feat.inlineErrors"), toggle("editor.inlineErrors"), t("feat.inlineErrors.help"), true),
        row(t("feat.importHelp"), toggle("editor.importHelp"), t("feat.importHelp.help"), true),
        row(t("feat.hoverDelay"), range("editor.hoverDelay", 0, 1500, 50, (v) => t("feat.hoverDelay.value", { s: (v / 1000).toFixed(2) })), t("feat.hoverDelay.help")),
        row(t("feat.files_guessEncoding"), toggle("files.guessEncoding"), undefined, true),
        row(t("set.suggestList"), select("editor.suggestList", [{ value: "smart", label: t("set.suggestList.smart") }, { value: "off", label: t("set.suggestList.off") }])),
        row(t("set.explain"), select("editor.explain", [{ value: "ai", label: t("set.explain.ai") }, { value: "rules", label: t("set.explain.rules") }, { value: "off", label: t("set.explain.off") }])),
        h("h2", { class: "set-group-title", "data-label": t("feat.group.ui") }, t("feat.group.ui")),
        row(t("feat.ui_traceButton"), toggle("ui.traceButton"), t("feat.ui_traceButton.help"), true),
        row(t("feat.ui_topTools"), toggle("ui.topTools"), undefined, true),
        row(t("feat.ui_dictButton"), toggle("ui.dictButton"), t("feat.ui_dictButton.help"), true),
        row(t("feat.ui_sideSwitch"), toggle("ui.sideSwitch"), undefined, true),
        row(t("feat.ui_selectionCount"), toggle("ui.selectionCount"), undefined, true),
        row(t("feat.fileGroups"), toggle("ui.fileGroups"), t("feat.fileGroups.help"), true),
        row(t("feat.saveHistory"), toggle("ui.saveHistory"), t("feat.saveHistory.help"), true),
        row(t("feat.ui_errorButton"), toggle("ui.errorButton"), undefined, true),
        row(t("feat.terminal_smartCopy"), toggle("terminal.smartCopy"), t("feat.terminal_smartCopy.help"), true),
      ],
    },
    {
      id: "look",
      label: t("set.look"),
      icon: "spark",
      build: () => [
        row(t("settings.bgColor"), color("look.bgColor", "--bg"), t("settings.bgColorHelp")),
        row(t("settings.accentColor"), color("look.accentColor", "--accent")),
        row(
          t("settings.bgImage"),
          h(
            "div",
            { class: "field-row" },
            button(bgImage ? t("settings.bgImageChange") : t("settings.bgImagePick"), async () => {
              const p = await dialog.pickImage();
              if (p) settings.set("look.bgImage", p);
            }, "primary"),
            bgImage ? button(t("settings.bgImageRemove"), () => settings.set("look.bgImage", "")) : null!,
          ),
          bgImage ? basename(bgImage) : t("settings.bgImageNone"),
        ),
        ...(bgImage
          ? [
              row(t("settings.bgOpacity"), range("look.bgOpacity", 0.3, 1, 0.02, (v) => `${Math.round(v * 100)}%`), t("settings.bgOpacityHelp")),
              row(t("settings.bgDim"), range("look.bgDim", 0, 0.9, 0.05, (v) => `${Math.round(v * 100)}%`)),
              row(t("settings.bgBlur"), range("look.bgBlur", 0, 24, 1, (v) => `${v}px`)),
              row(
                t("settings.bgFit"),
                select("look.bgFit", [
                  { value: "cover", label: t("settings.fit.cover") },
                  { value: "contain", label: t("settings.fit.contain") },
                  { value: "center", label: t("settings.fit.center") },
                  { value: "tile", label: t("settings.fit.tile") },
                ]),
              ),
            ]
          : []),
      ],
    },
    {
      id: "editor",
      label: t("settings.editor"),
      icon: "file",
      build: () => [
        row(t("settings.fontSize"), number("editor.fontSize", 10, 28)),
        row(t("settings.fontFamily"), text("editor.fontFamily", "JetBrains Mono"), t("settings.fontFamilyHelp")),
        row(
          t("set.suggestFont"),
          select("editor.suggestFont", [
            { value: "kyokasho", label: t("set.suggestFont.kyokasho") },
            { value: "bizud", label: t("set.suggestFont.bizud") },
            { value: "code", label: t("set.suggestFont.code") },
          ]),
          t("set.suggestFontHelp"),
        ),
        row(
          t("set.suggestList"),
          select("editor.suggestList", [
            { value: "smart", label: t("set.suggestList.smart") },
            { value: "off", label: t("set.suggestList.off") },
          ]),
          t("set.suggestListHelp"),
        ),
        row(
          t("set.listKey"),
          select("editor.listKey", [
            { value: "tab", label: t("set.listKey.tab") },
            { value: "enter", label: t("set.listKey.enter") },
          ]),
          t("set.listKeyHelp"),
        ),
        row(
          t("set.aiAcceptKey"),
          select("ai.acceptKey", [
            { value: "double", label: t("set.aiAcceptKey.double") },
            { value: "rshift", label: t("set.aiAcceptKey.rshift") },
            { value: "single", label: t("set.aiAcceptKey.single") },
          ]),
          t("set.aiAcceptKeyHelp"),
        ),
        row(t("set.zenkaku"), toggle("editor.zenkaku"), t("set.zenkakuHelp"), true),
        row(
          t("side.label"),
          select("editor.sideView", [
            { value: "explain", label: t("side.explain") + " — " + t("side.explainTitle") },
            { value: "values", label: t("side.values") + " — " + t("side.valuesTitle") },
            { value: "output", label: t("side.output") + " — " + t("side.outputTitle") },
            { value: "auto", label: t("side.auto") + " — " + t("side.autoTitle") },
            { value: "off", label: t("side.off") },
          ]),
        ),
        row(
          t("set.explain"),
          select("editor.explain", [
            { value: "ai", label: t("set.explain.ai") },
            { value: "rules", label: t("set.explain.rules") },
            { value: "off", label: t("set.explain.off") },
          ]),
          t("set.explainHelp"),
        ),
        row(t("feat.hoverDelay"), range("editor.hoverDelay", 0, 1500, 50, (v) => t("feat.hoverDelay.value", { s: (v / 1000).toFixed(2) })), t("feat.hoverDelay.help")),
        row(t("settings.tabSize"), number("editor.tabSize", 1, 8)),
        row(t("settings.wordWrap"), toggle("editor.wordWrap"), undefined, true),
        row(t("settings.lineNumbers"), toggle("editor.lineNumbers"), undefined, true),
      ],
    },
    {
      id: "files",
      label: t("set.files"),
      icon: "folder",
      build: () => [
        row(
          t("settings.autoSave"),
          select("editor.autoSave", [
            { value: "off", label: t("settings.autoSave.off") },
            { value: "delay", label: t("settings.autoSave.delay") },
            { value: "focus", label: t("settings.autoSave.focus") },
          ]),
        ),
        row(
          t("set.newFileLanguage"),
          select("files.newFileLanguage", LANG_CHOICES.map((c) => ({ value: c.ext, label: c.label }))),
          t("set.newFileLanguageHelp"),
        ),
        row(
          t("set.encoding"),
          select("files.encoding", ENCODINGS.map((e) => ({ value: e.id, label: e.label }))),
          t("set.encodingHelp"),
        ),
        row(t("set.guessEncoding"), toggle("files.guessEncoding"), t("set.guessEncodingHelp"), true),
        row(
          t("set.eol"),
          select("files.eol", [
            { value: "lf", label: "LF（\\n）" },
            { value: "crlf", label: "CRLF（\\r\\n・Windows のメモ帳など）" },
          ]),
          t("set.eolHelp"),
        ),
        row(t("settings.trimWhitespace"), toggle("editor.trimTrailingWhitespace"), undefined, true),
        row(t("settings.finalNewline"), toggle("editor.insertFinalNewline"), undefined, true),
        row(t("settings.restoreTabs"), toggle("editor.restoreTabs"), undefined, true),
      ],
    },
    {
      id: "ai",
      label: t("set.ai"),
      icon: "spark",
      build: () => [
        row(t("settings.aiEnabled"), toggle("ai.enabled"), undefined, true),
        aiStatusPanel(),
        row(t("settings.model"), modelPicker(), t("settings.modelHelp")),
        row(
          t("set.loadModel"),
          h(
            "div",
            { class: "field-row wrap" },
            button(t("set.pickGguf"), async () => {
              const p = await dialog.pickModelFile();
              if (p) await useModelFile(p);
            }, "primary"),
            button(t("set.pickModelsDir"), async () => {
              const p = await dialog.pickFolder();
              if (p) await useModelsDir(p);
            }),
          ),
          t("set.loadModelHelp"),
        ),
        row(
          t("settings.provider"),
          select("ai.provider", [
            { value: "ollama", label: "Ollama" },
            { value: "openai", label: t("settings.openaiCompat") },
          ]),
        ),
        row(t("settings.endpoint"), text("ai.endpoint", isOpenAI ? "http://127.0.0.1:8080" : "http://127.0.0.1:11434")),
        ...(isOpenAI ? [row(t("settings.apiKey"), text("ai.apiKey", t("settings.apiKeyPlaceholder"), "password"))] : []),
        row(t("settings.debounce"), number("ai.debounceMs", 50, 2000, 10), t("settings.debounceHelp")),
        row(t("settings.maxTokens"), number("ai.maxTokens", 16, 512, 8)),
      ],
    },
    {
      id: "build",
      label: t("set.build"),
      icon: "play",
      build: () => [
        row(t("build.keepComments"), toggle("build.keepComments"), t("set.keepCommentsHelp"), true),
        row(t("cmd.aiBuildTemplate"), button(t("set.insertTemplate"), () => commands.execute("ai.buildTemplate")), t("set.buildHelp")),
      ],
    },
    {
      id: "terminal",
      label: t("settings.terminal"),
      icon: "terminal",
      build: () => [
        row(t("settings.shell"), text("terminal.shell", t("settings.shellPlaceholder")), t("settings.shellHelp")),
        row(t("settings.fontSize"), number("terminal.fontSize", 9, 24)),
      ],
    },
    {
      id: "about",
      label: t("set.about"),
      icon: "refresh",
      build: () => {
        const version = h("span", {}, "…");
        sys.appInfo().then((i) => (version.textContent = i.version)).catch(() => (version.textContent = "—"));
        return [
          row(t("set.version"), h("div", { class: "field-row" }, version, button(t("cmd.checkUpdates"), () => commands.execute("app.checkUpdates"), "primary"))),
          row(t("set.autoUpdate"), toggle("update.autoCheck"), t("set.autoUpdateHelp"), true),
          osRow(),
          row(t("help.shortcuts"), button(t("set.showShortcuts"), () => commands.execute("help.shortcuts"))),
          row(t("set.downloadPage"), h("code", { class: "set-code" }, "https://setsukashiraishi-hub.github.io/Aizome/"), t("set.downloadHelp")),
          row(t("set.reset"), button(t("set.resetButton"), async () => {
            if (await confirmBox(t("set.reset"), t("set.resetConfirm"), t("set.resetButton"), true)) {
              localStorage.removeItem("aizome.settings.v1");
              location.reload();
            }
          }), t("set.resetHelp")),
        ];
      },
    },
  ];
}

// ───────── 画面

class SettingsPage {
  private el: HTMLElement | null = null;
  private current = "general";
  private query = "";

  get isOpen() {
    return !!this.el;
  }

  open(section?: string) {
    if (section) this.current = section;
    if (!this.el) {
      this.el = h("div", { class: "settings-page", role: "dialog", "aria-label": t("view.settings") });
      document.body.append(this.el);
      document.addEventListener("keydown", this.onKey, true);
    }
    this.render();
  }

  close() {
    this.el?.remove();
    this.el = null;
    this.query = "";
    document.removeEventListener("keydown", this.onKey, true);
  }

  toggle(section?: string) {
    if (this.el && (!section || section === this.current)) this.close();
    else this.open(section);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !document.querySelector(".modal-backdrop, .palette-backdrop, .menu")) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  refresh() {
    if (this.el) this.render();
  }

  private render() {
    const el = this.el!;
    const focusedSearch = document.activeElement?.classList.contains("set-search");
    clear(el);
    const all = sections();
    const search = h("input", { class: "text-input set-search", type: "search", placeholder: t("set.search"), value: this.query, spellcheck: "false", "aria-label": t("set.search") });
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderContent(content, all);
    });
    const nav = h(
      "nav",
      { class: "set-nav", "aria-label": t("view.settings") },
      ...all.map((s) =>
        h(
          "button",
          {
            class: "set-nav-item" + (s.id === this.current && !this.query ? " active" : ""),
            type: "button",
            onclick: () => {
              this.current = s.id;
              this.query = "";
              this.render();
            },
          },
          h("span", { html: icon(s.icon, 15) }),
          h("span", {}, s.label),
        ),
      ),
    );
    const content = h("div", { class: "set-content" });
    el.append(
      h(
        "div",
        { class: "set-side" },
        h("div", { class: "set-head" }, h("h2", {}, t("view.settings")), h("button", { class: "icon-btn", type: "button", title: t("common.close"), "aria-label": t("common.close"), html: icon("x", 16), onclick: () => this.close() })),
        search,
        nav,
      ),
      content,
    );
    this.renderContent(content, all);
    if (focusedSearch) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  }

  private renderContent(content: HTMLElement, all: Section[]) {
    clear(content);
    const q = this.query.trim().toLowerCase();
    if (!q) {
      const s = all.find((x) => x.id === this.current) ?? all[0];
      content.append(h("h1", { class: "set-title" }, s.label), h("div", { class: "set-list" }, ...s.build()));
      this.el?.querySelectorAll(".set-nav-item").forEach((b, i) => b.classList.toggle("active", all[i] === s));
      return;
    }
    this.el?.querySelectorAll(".set-nav-item").forEach((b) => b.classList.remove("active"));
    let hits = 0;
    for (const s of all) {
      const rows = s.build().filter((r) => (r.dataset.label ?? r.textContent ?? "").toLowerCase().includes(q) || s.label.toLowerCase().includes(q));
      if (!rows.length) continue;
      hits += rows.length;
      content.append(h("h2", { class: "set-group-title" }, s.label), h("div", { class: "set-list" }, ...rows));
    }
    if (!hits) content.append(h("p", { class: "set-empty" }, t("set.noMatch")));
  }
}

export const settingsPage = new SettingsPage();

// 表示言語やテーマ、背景画像の有無が変わったら描き直す
bus.on("settings:changed", ({ key }) => {
  if (["ui.language", "ai.provider", "look.bgImage", "ui.theme"].includes(key)) requestAnimationFrame(() => settingsPage.refresh());
});
