(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const webview = window.chrome && window.chrome.webview;
  const CHANNEL = "lyra-editor";
  const ASSETS_ORIGIN = "https://lyra-book-assets.local";
  const EXT_ORIGIN = "https://lyra-extensions.local";
  const state = {
    plugins: [],
    plugin: null,
    root: "",
    rootName: "",
    project: false,
    rel: "",
    title: "",
    text: "",
    files: [],
    pluginReady: false,
    saveTimer: 0,
    loadToken: 0,
  };
  const pending = new Map();
  let seq = 0;

  function host(type, extra) {
    return new Promise((resolve) => {
      if (!webview) { resolve({ ok: false, error: "不在璃鸢镜编辑器宿主中" }); return; }
      const requestId = "h-" + (++seq) + "-" + Date.now();
      pending.set(requestId, resolve);
      webview.postMessage(Object.assign({ type: type, requestId: requestId }, extra || {}));
      setTimeout(() => {
        if (pending.has(requestId)) { pending.delete(requestId); resolve({ ok: false, error: "宿主响应超时" }); }
      }, 20000);
    });
  }

  if (webview) {
    webview.addEventListener("message", (event) => {
      const d = event.data || {};
      if (d.type === "editor.plugins.result") {
        state.plugins = Array.isArray(d.plugins) ? d.plugins : [];
        renderPluginTabs();
        if (!state.plugins.length) {
          $("welcomeText").textContent = "还没有安装编辑器插件。安装 HTML 编辑器插件后即可在这里编辑 HTML。";
          $("statusbar").textContent = "未安装 editor-plugin 扩展";
        }
        return;
      }
      if (d.type === "editor.autoOpen") {
        state.root = d.root || "";
        state.rootName = d.rootName || "";
        state.project = !!d.project;
        state.files = Array.isArray(d.files) ? d.files : [];
        state.pluginReady = false;
        const frame = $("pluginFrame");
        frame.dataset.loaded = "0";
        openDocument(d.rel || "", decodeBase64(d.data));
        return;
      }
      const requestId = d.requestId;
      const resolve = pending.get(requestId);
      if (resolve) { pending.delete(requestId); resolve(d); }
    });
    host("editor.plugins").catch(() => {});
  }

  function pluginUrl(p) {
    const entry = (p.entry || "index.html").replace(/^\/+/, "");
    return EXT_ORIGIN + "/" + encodeURIComponent(p.id) + "/" + entry +
      "?embedded=1&v=301&extensionsOrigin=" + encodeURIComponent(EXT_ORIGIN);
  }

  function renderPluginTabs() {
    const box = $("pluginTabs");
    box.innerHTML = "";
    if (state.plugins.length <= 1) return;
    state.plugins.forEach((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "plugin-tab" + (state.plugin && state.plugin.id === p.id ? " active" : "");
      b.textContent = p.name || p.id;
      b.addEventListener("click", () => selectPlugin(p));
      box.appendChild(b);
    });
  }

  function selectPlugin(p) {
    if (state.plugin && state.plugin.id === p.id) return;
    state.plugin = p;
    renderPluginTabs();
    const frame = $("pluginFrame");
    frame.dataset.loaded = "0";
    state.pluginReady = false;
    if (state.rel) {
      frame.hidden = false;
      $("welcome").hidden = true;
      frame.src = pluginUrl(p);
    }
  }

  function renderFileList() {
    const side = $("sidebar");
    const list = $("fileList");
    side.hidden = !state.project || !state.files.length;
    list.innerHTML = "";
    if (!state.project) return;
    state.files.forEach((f) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "file-row" + (f.rel === state.rel ? " active" : "");
      b.textContent = f.name || f.rel;
      b.title = f.rel;
      b.addEventListener("click", () => { if (f.rel !== state.rel) openRel(f.rel).catch(showError); });
      list.appendChild(b);
    });
  }

  function currentDir() {
    const i = state.rel.lastIndexOf("/");
    return i >= 0 ? state.rel.slice(0, i) : "";
  }

  function baseHref() {
    const dir = currentDir();
    return ASSETS_ORIGIN + "/" + (dir ? dir.replace(/\/+$/, "") + "/" : "");
  }

  function updateChrome() {
    $("fileLabel").textContent = state.rel ? (state.rootName ? state.rootName + " / " : "") + state.rel : "";
    $("statusbar").textContent = state.rel ? (state.rel + " · 自动保存已开启") : "就绪";
    renderFileList();
  }

  function decodeBase64(data) {
    const bin = atob(data || "");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function sendPlugin(type, extra) {
    const frame = $("pluginFrame");
    try {
      if (frame.contentWindow) frame.contentWindow.postMessage(Object.assign({ channel: CHANNEL, type: type }, extra || {}), "*");
    } catch { }
  }

  function sendDocument() {
    if (!state.plugin || !state.rel || !state.pluginReady) return;
    sendPlugin("init", {
      html: state.text,
      title: state.title || state.rel.split("/").pop(),
      assetMode: "external",
      baseHref: baseHref(),
    });
  }

  function ensurePlugin() {
    if (!state.plugins.length) return false;
    if (!state.plugin) {
      state.plugin = state.plugins[0];
      renderPluginTabs();
    }
    const frame = $("pluginFrame");
    if (frame.dataset.loaded !== "1") {
      frame.dataset.loaded = "1";
      state.pluginReady = false;
      frame.hidden = false;
      $("welcome").hidden = true;
      frame.onload = () => { state.pluginReady = false; };
      frame.src = pluginUrl(state.plugin);
    } else {
      frame.hidden = false;
      $("welcome").hidden = true;
    }
    return true;
  }

  async function openRel(rel) {
    if (!rel) return;
    const res = await host("editor.read", { rel: rel });
    if (!res || !res.ok) throw new Error((res && res.error) || "读取文件失败");
    openDocument(rel, decodeBase64(res.data));
  }

  function openDocument(rel, text) {
    state.rel = rel;
    state.title = rel.split("/").pop();
    state.text = text || "";
    state.loadToken += 1;
    updateChrome();
    if (!ensurePlugin()) {
      $("welcome").hidden = false;
      return;
    }
    if (state.pluginReady) sendDocument();
  }

  function showError(err) {
    $("statusbar").textContent = "错误：" + (err && err.message ? err.message : err);
  }

  async function pickFile() {
    const res = await host("editor.pickFile");
    if (!res || !res.ok) { $("statusbar").textContent = "打开失败：" + ((res && res.error) || "未选择"); return; }
    state.root = res.root || "";
    state.rootName = res.name || "";
    state.project = false;
    state.files = [];
    state.pluginReady = false;
    $("pluginFrame").dataset.loaded = "0";
    openDocument(res.rel || "", decodeBase64(res.data));
  }

  async function pickFolder() {
    const res = await host("editor.pickFolder");
    if (!res || !res.ok) { $("statusbar").textContent = "打开失败：" + ((res && res.error) || "未选择"); return; }
    state.root = res.root || "";
    state.rootName = res.rootName || res.name || "";
    state.project = true;
    state.files = Array.isArray(res.files) ? res.files : [];
    state.rel = "";
    state.pluginReady = false;
    $("pluginFrame").dataset.loaded = "0";
    renderFileList();
    if (res.entryRel) await openRel(res.entryRel);
    else {
      $("welcomeText").textContent = "项目里没有找到 HTML 文件。";
      $("welcome").hidden = false;
    }
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => { saveNow().catch(showError); }, 500);
  }

  async function saveNow() {
    if (!state.rel) return;
    const res = await host("editor.write", { rel: state.rel, data: encodeBase64(state.text) });
    if (!res || !res.ok) throw new Error((res && res.error) || "保存失败");
    $("statusbar").textContent = state.rel + " · 已保存";
  }

  function withCurrentDir(value) {
    if (!value) return "";
    if (state.project && currentDir() && !/^[a-zA-Z]:[\\/]/.test(value) && !value.startsWith("//")) {
      return currentDir().replace(/\/+$/, "") + "/" + String(value).replace(/^\/+/, "");
    }
    return String(value).replace(/^\/+/, "");
  }

  function stripCurrentDir(value) {
    const dir = currentDir();
    if (dir && value && value.startsWith(dir + "/")) return value.slice(dir.length + 1);
    return value;
  }

  async function handleFileRequest(d) {
    try {
      const command = String(d.command || "");
      const extra = Object.assign({}, d);
      delete extra.channel; delete extra.type; delete extra.requestId; delete extra.command;
      if (extra.path) extra.path = withCurrentDir(extra.path);
      if (extra.from) extra.from = withCurrentDir(extra.from);
      if (extra.to) extra.to = withCurrentDir(extra.to);
      let op = "";
      if (command === "host.file.save") op = "save";
      else if (command === "host.file.delete") op = "delete";
      else if (command === "host.file.rename") op = "rename";
      if (!op) { sendPlugin("file-result", { requestId: d.requestId, ok: false, error: "不支持的请求" }); return; }
      const payload = { op: op };
      if (op === "save") { payload.rel = extra.path || ""; payload.data = extra.data || ""; }
      if (op === "delete") payload.rel = extra.path || "";
      if (op === "rename") { payload.from = extra.from || ""; payload.to = extra.to || ""; }
      const res = await host("editor.fileOp", payload);
      sendPlugin("file-result", { requestId: d.requestId, ok: !!(res && res.ok), error: (res && res.error) || "", path: (res && res.path) || "" });
    } catch (e) {
      sendPlugin("file-result", { requestId: d.requestId, ok: false, error: String(e && e.message ? e.message : e) });
    }
  }

  async function handleAssetRequest(d) {
    try {
      const res = await host("editor.saveAsset", {
        name: d.name || "image",
        data: d.data || "",
        dir: currentDir(),
      });
      if (!res || !res.ok) throw new Error((res && res.error) || "保存图片失败");
      sendPlugin("asset-result", { requestId: d.requestId, ok: true, path: stripCurrentDir(res.rel || "") });
    } catch (e) {
      sendPlugin("asset-result", { requestId: d.requestId, ok: false, error: String(e && e.message ? e.message : e) });
    }
  }

  function hrefToRel(href) {
    try {
      const u = new URL(href, location.href);
      if (u.host !== "lyra-book-assets.local") return "";
      if (!/\.html?$/i.test(u.pathname)) return "";
      return decodeURIComponent(u.pathname).replace(/^\/+/, "");
    } catch { return ""; }
  }

  window.addEventListener("message", (event) => {
    const frame = $("pluginFrame");
    if (!frame || event.source !== frame.contentWindow) return;
    const d = event.data || {};
    if (d.channel !== CHANNEL) return;
    if (d.type === "ready") {
      state.pluginReady = true;
      sendDocument();
    } else if (d.type === "change") {
      state.text = d.html || "";
      scheduleSave();
    } else if (d.type === "file-request") {
      handleFileRequest(d).catch(showError);
    } else if (d.type === "asset-request") {
      handleAssetRequest(d).catch(showError);
    } else if (d.type === "open-file") {
      const rel = hrefToRel(d.href);
      if (rel && rel !== state.rel) openRel(rel).catch(showError);
    } else if (d.type === "theme") {
      // 插件自己的主题只影响插件内部；宿主保持深色。
    }
  });

  $("openFileBtn").addEventListener("click", () => pickFile().catch(showError));
  $("welcomeFileBtn").addEventListener("click", () => pickFile().catch(showError));
  $("openFolderBtn").addEventListener("click", () => pickFolder().catch(showError));
  $("welcomeFolderBtn").addEventListener("click", () => pickFolder().catch(showError));
})();