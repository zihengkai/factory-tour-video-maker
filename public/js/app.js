// 探厂短视频工具 · 前端逻辑
const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");

const state = {
  view: "list",
  projects: [],
  current: null,
  step: 1,
  config: { reporter: { zh: "", en: "" }, output: {} },
  bgmTracks: [],
};

const STEPS = [
  [1, "工厂信息", "info"],
  [2, "探厂文案", "script"],
  [3, "英文配音", "voice"],
  [4, "分镜素材", "assets"],
  [5, "开场镜头", "opening"],
  [6, "视频封面", "cover"],
  [7, "合成导出", "render"],
];

const STAGE_PILL = { idle: "待处理", running: "进行中", done: "已完成", failed: "失败" };

// 全局单例轮询定时器：新轮询前先停旧的，避免叠加请求或对已删项目残留轮询
let pollTimer = null;
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function stageOf(p, key) {
  return p.stages?.[key] || { status: "idle", error: "" };
}
function stagePill(key) {
  const s = stageOf(state.current, key);
  return `<span class="pill st-${s.status}">${STAGE_PILL[s.status]}</span>`;
}
function stageAlert(key) {
  const s = stageOf(state.current, key);
  if (s.status === "running") return `<div class="alert info">任务进行中，请稍候，页面会自动刷新…</div>`;
  if (s.status === "failed") return `<div class="alert err">${esc(s.error || "任务失败，请重试")}</div>`;
  return "";
}
function stageRunning(key) {
  return stageOf(state.current, key).status === "running";
}

const STATUS_LABEL = {
  draft: "草稿",
  "script-done": "文案已生成",
  "voice-done": "配音完成",
  "assets-mounted": "素材已挂载",
  "ready-to-render": "待合成",
  rendered: "已合成",
};

const SCENES = ["gate", "overview", "workshop", "production_line", "lab", "products", "certification", "team", "outro"];
const TRANSITIONS = [["dissolve", "叠化"], ["slide", "轻推"], ["cut", "硬切"]];

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

function fileUrl(id, rel) {
  if (!rel) return "";
  return `/api/projects/${id}/file/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

async function uploadFile(id, slot, file) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  let r;
  try {
    r = await fetch(`/api/projects/${id}/upload/${encodeURIComponent(slot)}?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: file,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e?.name === "AbortError" ? "上传超时（超过 3 分钟）" : `网络中断：${e?.message || "无法连接本地服务"}`);
  } finally {
    clearTimeout(timer);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `上传失败 HTTP ${r.status}`);
  return j;
}

// 点击 + 拖拽上传区；支持单文件 onFile 与批量 onFiles 两种回调
function bindDropzone(el, { accept, onFile, onFiles }) {
  el.classList.add("dropzone");
  const emit = (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    if (onFiles) onFiles(list);
    else list.forEach((f) => onFile(f));
  };
  el.addEventListener("click", () => {
    if (el.classList.contains("busy")) return;
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = accept;
    inp.multiple = true;
    inp.onchange = () => emit(inp.files);
    inp.click();
  });
  ["dragover", "dragenter"].forEach((ev) =>
    el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((ev) =>
    el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.remove("dragging"); }));
  el.addEventListener("drop", (e) => {
    emit(e.dataTransfer.files);
  });
}

async function handleUpload(el, slot, file) {
  const okType = /^image\/|^video\//.test(file.type) ||
    /\.(jpe?g|png|webp|bmp|mp4|mov|mkv|webm|avi)$/i.test(file.name);
  if (!okType) return toast("仅支持图片或视频文件");
  const prevText = el.textContent;
  el.classList.add("busy");
  el.textContent = "上传中…";
  try {
    await uploadFile(state.current.id, slot, file);
    await refreshProject();
    toast("素材已上传");
    renderStep();
  } catch (e) {
    toast(e.message);
    el.classList.remove("busy");
    el.textContent = prevText;
  }
}

// 分环节轮询：done / failed 后回调刷新当前面板
function pollStage(stage, onDone) {
  const meta = STEPS.find((s) => s[2] === stage);
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const j = await api(`/api/projects/${state.current.id}`);
      state.current = j.project;
      const st = stageOf(state.current, stage).status;
      if (st === "done") { stopPolling(); toast(`${meta[1]}已完成，可进入下一环节`); onDone(); }
      else if (st === "failed") { stopPolling(); onDone(); }
    } catch { /* 下一轮重试 */ }
  }, 3000);
  setTimeout(() => stopPolling(), 600000);
}

// ---------- 项目列表 ----------
async function loadList() {
  const j = await api("/api/projects");
  state.projects = j.projects;
  renderList();
}

function renderList() {
  $("#btn-home").classList.add("hidden");
  app.innerHTML = `
    <div class="list-head">
      <h2>全部探厂项目</h2>
      <button class="btn" id="btn-new">+ 新建项目</button>
    </div>
    <div class="grid">
      ${state.projects.map((p) => `
        <div class="proj-card">
          <div class="proj-cover">
            ${p.coverUrl ? `<img src="${p.coverUrl}" alt="封面" />` : p.gateUrl ? `<img src="${p.gateUrl}" alt="大门" />` : `<div class="placeholder">暂无封面</div>`}
          </div>
          <div class="proj-body">
            <div class="proj-name">${esc(p.nameZh || p.nameEn || "未命名工厂")}</div>
            <div class="proj-meta">${esc(p.brand || "")}${p.website ? ` · ${esc(p.website)}` : ""}</div>
            <span class="badge ${p.status}">${STATUS_LABEL[p.status] || p.status}</span>
            <div class="proj-actions">
              <button class="btn sm ghost" data-open="${p.id}">打开</button>
              ${p.videoUrl ? `<button class="btn sm ghost" data-play="${p.videoUrl}">播放成片</button>` : ""}
              <button class="btn sm danger" data-del="${p.id}">删除</button>
            </div>
          </div>
        </div>`).join("")}
      ${!state.projects.length ? `<div class="hint">还没有项目，点击右上角「新建项目」开始制作第一条探厂视频。</div>` : ""}
    </div>`;

  $("#btn-new").onclick = async () => {
    const j = await api("/api/projects", { method: "POST", body: JSON.stringify({ company: {} }) });
    await openProject(j.project.id);
  };
  app.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openProject(b.dataset.open)));
  app.querySelectorAll("[data-play]").forEach((b) => (b.onclick = () => {
    const w = window.open(b.dataset.play, "_blank");
    w?.focus();
  }));
  app.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm("确认删除该项目及其全部素材与成片？")) return;
    stopPolling();
    await api(`/api/projects/${b.dataset.del}`, { method: "DELETE" });
    toast("项目已删除");
    loadList();
  }));
}

// ---------- 工作台 ----------
async function openProject(id) {
  stopPolling();
  const j = await api(`/api/projects/${id}`);
  state.current = j.project;
  state.view = "ws";
  state.step = 1;
  $("#btn-home").classList.remove("hidden");
  renderWorkspace();
}

async function refreshProject() {
  const j = await api(`/api/projects/${state.current.id}`);
  state.current = j.project;
}

function renderWorkspace() {
  const p = state.current;
  $("#btn-home").onclick = () => { stopPolling(); state.view = "list"; loadList(); };
  app.innerHTML = `
    <div class="ws">
      <nav class="steps">
        ${STEPS.map(([n, label, key]) => {
          const st = stageOf(p, key).status;
          return `
          <div class="step-item ${state.step === n ? "active" : ""}" data-step="${n}">
            <span class="no">0${n}</span><span class="step-label">${label}</span>
            <span class="dot st-${st}" title="${STAGE_PILL[st]}"></span>
          </div>`;
        }).join("")}
      </nav>
      <section class="panel" id="panel"></section>
    </div>`;
  app.querySelectorAll("[data-step]").forEach((el) => (el.onclick = () => { state.step = Number(el.dataset.step); renderWorkspace(); }));
  renderStep();
}

function renderStep() {
  const panel = $("#panel");
  const renderers = [null, step1Info, step3Script, step4Voice, step5Assets, step6Opening, step7Cover, step8Render];
  renderers[state.step](panel);
  appendStepNav(panel);
  const key = STEPS[state.step - 1][2];
  if (stageRunning(key)) {
    if (key === "opening") pollOpening(state.current, panel);
    else pollStage(key, () => renderStep());
  }
}

// 面板底部：上一步 / 下一步 + 环节完成提示
function appendStepNav(panel) {
  const [n, , key] = STEPS[state.step - 1];
  const st = stageOf(state.current, key).status;
  const canNext = st === "done";
  const hint = st === "done" ? "本环节已完成，可进入下一环节"
    : st === "running" ? "本环节进行中，请稍候…"
    : "完成本环节后，点击下一步继续";
  const nav = document.createElement("div");
  nav.className = "step-nav";
  nav.innerHTML = `
    <button class="btn ghost sm" id="nav-prev" ${state.step === 1 ? "disabled" : ""}>← 上一步</button>
    <span class="hint">${hint}</span>
    <button class="btn sm" id="nav-next" ${canNext && state.step < 8 ? "" : "disabled"}>下一步 →</button>`;
  panel.appendChild(nav);
  $("#nav-prev").onclick = () => { if (state.step > 1) { state.step--; renderWorkspace(); } };
  $("#nav-next").onclick = () => { if (canNext && state.step < 8) { state.step++; renderWorkspace(); } };
}

function saveCompany(extra = {}, draft = false) {
  return api(`/api/projects/${state.current.id}`, {
    method: "PUT",
    body: JSON.stringify({ company: collectCompany(), draft, ...extra }),
  });
}

function collectCompany() {
  const g = (id) => $(`#${id}`)?.value.trim() || "";
  return {
    nameZh: g("f-nameZh"),
    nameEn: g("f-nameEn"),
    brand: g("f-brand"),
    website: g("f-website"),
    intro: g("f-intro"),
  };
}

// 1 工厂信息
function step1Info(panel) {
  const c = state.current.company;
  panel.innerHTML = `
    <div class="panel-head"><h3 style="margin:0">工厂信息</h3>${stagePill("info")}</div>
    <div class="form-grid">
      <div class="field"><label>公司中文名</label><input id="f-nameZh" value="${esc(c.nameZh)}" placeholder="如：某某精密制造有限公司" /></div>
      <div class="field"><label>公司英文名</label><input id="f-nameEn" value="${esc(c.nameEn)}" placeholder="如：Acme Precision Manufacturing Co., Ltd." /></div>
      <div class="field"><label>品牌名</label><input id="f-brand" value="${esc(c.brand)}" placeholder="如：ACME" /></div>
      <div class="field"><label>官网网址</label><input id="f-website" value="${esc(c.website)}" placeholder="https://www.example.com" /></div>
      <div class="field full"><label>公司介绍（尽量填全文字资料）</label><textarea id="f-intro" placeholder="主营产品、历史定位、规模/产能、智能制造、研发与标准、认证品控、主要市场、荣誉等，资料越全文案越准">${esc(c.intro)}</textarea></div>
      <div class="field full">
        <label>工厂大门 / 厂区照片</label>
        <div class="dropzone" id="gate-upload">点击选择，或将大门照片拖拽到此处（JPG / PNG / WebP）</div>
        ${c.gateImage ? `<img class="preview-img" src="${fileUrl(state.current.id, c.gateImage)}" alt="大门照片" />` : ""}
      </div>
    </div>
    <div style="margin-top:18px; display:flex; gap:10px; align-items:center;">
      <button class="btn" id="btn-save-info">保存信息并下一步</button>
      <span class="hint">保存后自动进入第 2 步；第 2 步由你手动点击按钮生成文案。</span>
    </div>`;

  // 输入内容防抖自动存为草稿，刷新或重新渲染都不丢失；草稿不提前标记环节完成
  const draftIds = ["f-nameZh", "f-nameEn", "f-brand", "f-website", "f-intro"];
  let draftTimer;
  const autosaveDraft = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(async () => {
      try {
        const j = await saveCompany({}, true);
        state.current.company = j.project.company;
      } catch { /* 草稿静默失败，不打断输入 */ }
    }, 700);
  };
  draftIds.forEach((id) => $("#" + id)?.addEventListener("input", autosaveDraft));

  bindDropzone($("#gate-upload"), {
    accept: "image/*",
    onFile: async (f) => {
      // 拖入图片前先把当前已填文字存盘，避免刷新面板时被空值覆盖
      await saveCompany({}, true).catch(() => {});
      handleUpload($("#gate-upload"), "gate", f);
    },
  });
  $("#btn-save-info").onclick = async () => {
    try {
      clearTimeout(draftTimer);
      await saveCompany();
      await refreshProject();
      toast("信息已保存，进入下一环节");
      state.step = 2;
      renderWorkspace();
    } catch (e) { toast(e.message); }
  };
}

// 文案环节内展示本次提炼的核心卖点（只读摘要）
function pointsSummary(p) {
  const sp = p.sellingPoints || { points: [], summary: "" };
  if (!sp.points?.length && !sp.summary) return "";
  const chips = sp.points
    .map((pt) => `<span class="tag orange">${esc(pt.zhLabel || pt.label || "")}${pt.zhValue ? ` · ${esc(pt.zhValue)}` : ""}</span>`)
    .join("");
  return `<details class="sp-summary" style="margin-bottom:16px;">
    <summary class="hint">本次提炼的核心卖点（${sp.points.length} 项）</summary>
    ${sp.summary ? `<div class="hint" style="margin-top:6px;">${esc(sp.summary)}</div>` : ""}
    <div style="margin-top:8px; display:flex; flex-wrap:wrap; gap:6px;">${chips}</div>
  </details>`;
}

// 2 探厂文案（基于公司介绍一次成稿）
function step3Script(panel) {
  const p = state.current;
  const running = stageRunning("script");
  const words = p.script.sentences.reduce((n, s) => n + (s.en ? s.en.split(/\s+/).filter(Boolean).length : 0), 0);
  panel.innerHTML = `
    <div class="panel-head">
      <h3 style="margin:0">探厂文案（英文口播 + 中文译文）</h3>
      <span class="hint">当前英文约 ${words} 词 · 目标 120–150 词 / 约 60 秒</span>
      ${stagePill("script")}
    </div>
    <div class="alert info">基于你填写的公司介绍和文字资料，快速提炼核心竞争力并一次性生成中英探厂文案；本环节手动触发，完成后再进入下一步。请尽量把公司主营、规模、产能、认证、市场等资料在第 1 步填全。</div>
    ${stageAlert("script")}
    <div style="display:flex; gap:10px; margin-bottom:16px; flex-wrap:wrap;">
      <button class="btn" id="btn-gen-script" ${running ? "disabled" : ""}>${running ? "生成中…" : p.script.sentences.length ? "重新生成文案" : "基于公司介绍生成文案"}</button>
    </div>
    ${pointsSummary(p)}
    <div class="field full" style="margin-bottom:16px;">
      <label>按意见优化（可选）</label>
      <textarea id="refine-note" placeholder="如：更突出产能和认证；语气更沉稳；压缩到 45 秒"></textarea>
      <button class="btn ghost sm" id="btn-refine" style="margin-top:8px;" ${running ? "disabled" : ""}>应用优化意见</button>
    </div>
    <div id="script-body"></div>`;

  const body = $("#script-body");
  renderScriptRows(body, p);

  $("#btn-gen-script").onclick = async () => {
    try {
      await api(`/api/projects/${p.id}/script`, { method: "POST", body: JSON.stringify({}) });
      await refreshProject();
      renderStep();
    } catch (e) { toast(e.message); }
  };
  $("#btn-refine").onclick = async () => {
    const instruction = $("#refine-note").value.trim();
    if (!instruction) return toast("请先填写优化意见");
    try {
      await api(`/api/projects/${p.id}/script`, { method: "POST", body: JSON.stringify({ instruction }) });
      await refreshProject();
      renderStep();
    } catch (e) { toast(e.message); }
  };
}

function renderScriptRows(body, p) {
  if (!p.script.sentences.length) {
    body.innerHTML = `<div class="hint">暂无文案，点击上方「基于公司介绍生成文案」。</div>`;
    return;
  }
  body.innerHTML = p.script.sentences.map((s) => `
    <div class="sentence-row" data-sid="${s.id}">
      <div class="row-head">
        <strong>句 ${s.id.slice(1)}</strong>
        <span class="hint">${s.start?.toFixed(1) || "0.0"}s – ${s.end?.toFixed(1) || "0.0"}s</span>
      </div>
      <div class="field"><label>英文口播</label><textarea data-en>${esc(s.en)}</textarea></div>
      <div class="field" style="margin-top:8px;"><label>中文译文</label><textarea data-zh>${esc(s.zh)}</textarea></div>
      <div class="row-actions" style="margin-top:8px;">
        <select data-scene>${SCENES.map((sc) => `<option value="${sc}" ${s.scene === sc ? "selected" : ""}>${sc}</option>`).join("")}</select>
        <span class="hint">关键词：${(s.keywords || []).map((k) => `<span class="tag orange">${esc(k)}</span>`).join("") || "—"}</span>
      </div>
    </div>`).join("");

  body.querySelectorAll(".sentence-row").forEach((row) => {
    const sid = row.dataset.sid;
    const save = async () => {
      const sentence = {
        en: row.querySelector("[data-en]").value,
        zh: row.querySelector("[data-zh]").value,
        scene: row.querySelector("[data-scene]").value,
      };
      await api(`/api/projects/${state.current.id}/script/sentence/${sid}`, {
        method: "PUT",
        body: JSON.stringify({ sentence }),
      });
    };
    row.querySelector("[data-en]").onblur = save;
    row.querySelector("[data-zh]").onblur = save;
    row.querySelector("[data-scene]").onchange = save;
  });
}

// 4 英文配音
function step4Voice(panel) {
  const p = state.current;
  const running = stageRunning("voice");
  panel.innerHTML = `
    <div class="panel-head"><h3 style="margin:0">英文配音</h3>${stagePill("voice")}</div>
    <div class="alert info">默认英文女声（音色由环境变量 TTS_SPEAKER 配置），整段探厂文案一次合成一条口播音轨。</div>
    ${stageAlert("voice")}
    <div style="display:flex; gap:10px; margin-bottom:16px;">
      <button class="btn" id="btn-tts" ${running ? "disabled" : ""}>${running ? "配音中…" : p.voice.ready ? "重新生成整条配音" : "生成英文配音"}</button>
    </div>
    ${p.voice.audioFile ? `<audio class="media-player" controls src="${fileUrl(p.id, p.voice.audioFile)}"></audio>` : ""}
    <div id="voice-rows" style="margin-top:16px;"></div>`;

  const rows = $("#voice-rows");
  rows.innerHTML = p.script.sentences.map((s) => `
    <div class="sentence-row">
      <div class="row-head"><strong>句 ${s.id.slice(1)}</strong><span class="hint">${s.start?.toFixed(1) || "0"} – ${s.end?.toFixed(1) || "0"}s</span></div>
      <div class="zh">${esc(s.zh)}</div>
    </div>`).join("");

  $("#btn-tts").onclick = async () => {
    try {
      await api(`/api/projects/${p.id}/tts`, { method: "POST" });
      await refreshProject();
      renderStep();
    } catch (e) { toast(e.message); }
  };
}

// 5 分镜素材
function step5Assets(panel) {
  const p = state.current;
  const assets = Array.isArray(p.assets) ? p.assets : [];
  panel.innerHTML = `
    <div class="panel-head"><h3 style="margin:0">分镜素材挂载</h3>${stagePill("assets")}</div>
    <div class="alert info">把所有实拍视频、工厂图片一次性拖入下方这一个上传框；系统按配音总时长把各素材均分展示（每段约 2–4 秒转场），开场镜头 + 素材画面铺满整条音轨，画面总长与配音一致。</div>
    ${stageAlert("assets")}
    <div class="dropzone" id="asset-drop">点击选择，或将视频 / 图片批量拖到此处</div>
    <div id="asset-list" style="margin-top:16px;"></div>`;

  const list = $("#asset-list");
  list.innerHTML = assets.map((a, i) => `
    <div class="sentence-row">
      <div class="row-head"><strong>素材 ${i + 1}</strong><span class="badge rendered">${a.kind === "video" ? "视频" : "图片"}</span></div>
      <div class="row-actions" style="margin-top:10px; align-items:center; gap:10px;">
        ${a.kind === "image"
          ? `<img class="preview-img" src="${fileUrl(p.id, a.file)}" />`
          : `<video class="preview-video" controls src="${fileUrl(p.id, a.file)}"></video>`}
        <button class="btn sm danger" data-del="${i}">移除</button>
      </div>
    </div>`).join("");

  bindDropzone($("#asset-drop"), {
    accept: "image/*,video/*",
    onFiles: async (files) => {
      const ok = files.filter((f) => /^image\/|^video\//.test(f.type) || /\.(jpe?g|png|webp|bmp|mp4|mov|mkv|webm|avi)$/i.test(f.name));
      if (!ok.length) return toast("仅支持图片或视频文件");
      const drop = $("#asset-drop");
      drop.classList.add("busy");
      const failed = [];
      let done = 0;
      for (let i = 0; i < ok.length; i++) {
        const f = ok[i];
        drop.textContent = `上传中… ${i + 1}/${ok.length}`;
        try {
          await uploadFile(state.current.id, "assets", f);
          done++;
        } catch (e) {
          failed.push(`${f.name}（${e.message}）`);
        }
      }
      await refreshProject();
      renderStep();
      if (failed.length) {
        const head = failed.slice(0, 3).join("、");
        toast(`成功 ${done} 个，失败 ${failed.length} 个：${head}${failed.length > 3 ? " 等" : ""}`);
      } else {
        toast(`已上传 ${done} 个素材`);
      }
    },
  });

  list.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    try {
      await api(`/api/projects/${p.id}/upload/remove`, { method: "POST", body: JSON.stringify({ index: Number(b.dataset.del) }) });
      await refreshProject();
      renderStep();
    } catch (e) { toast(e.message); }
  }));
}

// 6 开场镜头
function step6Opening(panel) {
  const p = state.current;
  const running = stageRunning("opening");
  panel.innerHTML = `
    <div class="panel-head"><h3 style="margin:0">AI 开场镜头（大门照 + 记者形象提示词）</h3>${stagePill("opening")}</div>
    <div class="alert info">不上传人物三视图：以大门照片为首帧，按固定记者形象文字提示词调用视频模型生成开场镜头。</div>
    ${stageAlert("opening")}
    <div class="kv">
      <dt>记者形象</dt><dd>${esc(state.config.reporter.zh)}</dd>
    </div>
    ${p.company.gateImage ? `<img class="preview-img" src="${fileUrl(p.id, p.company.gateImage)}" style="max-width:360px;" />` : `<div class="hint">请先在第 1 步上传大门照片。</div>`}
    <div style="margin:14px 0; display:flex; gap:10px;">
      <button class="btn" id="btn-opening" ${p.company.gateImage && !running ? "" : "disabled"}>${running ? "生成中…" : "生成开场镜头"}</button>
    </div>
    ${p.opening.videoFile ? `<video class="preview-video" controls src="${fileUrl(p.id, p.opening.videoFile)}"></video>` : ""}
    ${p.opening.prompt ? `<details style="margin-top:12px;"><summary class="hint">查看本次开场提示词</summary><div class="hint" style="margin-top:6px; white-space:pre-wrap;">${esc(p.opening.prompt)}</div></details>` : ""}`;

  $("#btn-opening").onclick = async () => {
    try {
      await api(`/api/projects/${p.id}/opening`, { method: "POST" });
      await refreshProject();
      renderStep();
    } catch (e) { toast(e.message); }
  };
}

async function pollOpening(p, panel) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const j = await api(`/api/projects/${p.id}/opening/poll`);
      state.current = j.project;
      if (j.project.opening.status === "done") {
        stopPolling();
        toast("开场镜头已完成，可进入下一环节");
        renderStep();
      } else if (j.project.opening.status === "failed") {
        stopPolling();
        renderStep();
      }
    } catch (e) { stopPolling(); toast(e.message); }
  }, 4000);
}

// 7 视频封面（单张生成，不再三选一）
function step7Cover(panel) {
  const p = state.current;
  const running = stageRunning("cover");
  panel.innerHTML = `
    <div class="panel-head"><h3 style="margin:0">视频封面（1:1 · 1024×1024）</h3>${stagePill("cover")}</div>
    <div class="alert info">大门照作背景 + 固定记者形象提示词，按固定商务版式一次生成一张封面。</div>
    ${stageAlert("cover")}
    <div style="margin-bottom:16px;"><button class="btn" id="btn-cover" ${running ? "disabled" : ""}>${running ? "生成中…" : p.cover.imageFile ? "重新生成封面" : "生成封面"}</button></div>
    <div id="cover-box">
      ${p.cover.imageFile
        ? `<img class="preview-img" style="max-width:480px;" src="${fileUrl(p.id, p.cover.imageFile)}" alt="视频封面" />`
        : `<div class="hint">暂无封面。</div>`}
    </div>
    ${p.cover.prompt ? `<details style="margin-top:12px;"><summary class="hint">查看封面提示词</summary><div class="hint" style="margin-top:6px; white-space:pre-wrap;">${esc(p.cover.prompt)}</div></details>` : ""}`;

  $("#btn-cover").onclick = async () => {
    try {
      await api(`/api/projects/${p.id}/cover`, { method: "POST" });
      await refreshProject();
      renderStep();
    } catch (e) { toast(e.message); }
  };
}

// 8 合成导出
async function step8Render(panel) {
  if (!state.bgmTracks.length) {
    try {
      const j = await api("/api/assets/bgm");
      state.bgmTracks = j.tracks || (j.files || []).map((f) => ({ name: f, builtin: true }));
    } catch { state.bgmTracks = []; }
  }
  const p = state.current;
  const running = stageRunning("render");
  const vol = p.settings.bgmVolume ?? 50;
  const aspect = p.settings.aspect === "1:1" ? "1:1" : "16:9";

  // 素材总时长 vs 配音时长对比，不足则拦截合成
  let durCheck = null;
  try { durCheck = await api(`/api/projects/${p.id}/render/check`); } catch { durCheck = null; }
  const insufficient = !!(durCheck && !durCheck.enough);

  panel.innerHTML = `
    <div class="panel-head"><h3 style="margin:0">合成与导出</h3>${stagePill("render")}</div>
    <div class="form-grid" style="margin-bottom:16px;">
      <div class="field"><label>商务 BGM</label>
        <div class="bgm-row">
          <select id="set-bgm">
            <option value="">不配乐</option>
            ${state.bgmTracks.map((t) => `<option value="${esc(t.name)}" ${p.settings.bgm === t.name ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
          </select>
          <button class="btn sm ghost" id="btn-bgm-play" type="button">试听</button>
          <button class="btn sm danger" id="btn-bgm-del" type="button" ${p.settings.bgm ? "" : "disabled"}>删除</button>
        </div>
        <input type="file" id="bgm-upload" accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a" hidden />
        <button class="btn sm ghost" id="btn-bgm-upload" type="button" style="margin-top:8px;">+ 上传 BGM 存入系统库</button>
        <audio id="bgm-audio" class="media-player" controls style="margin-top:8px; display:none;"></audio>
      </div>
      <div class="field"><label>BGM 音量（默认 50%）</label>
        <div class="vol-row">
          <input type="range" id="set-vol" min="0" max="100" step="5" value="${vol}" />
          <span class="hint" id="vol-label">${vol}%</span>
        </div>
      </div>
      <div class="field"><label>音效</label>
        <select id="set-sfx">
          <option value="true" ${p.settings.sfx !== false ? "selected" : ""}>启用克制转场 / 提示音</option>
          <option value="false" ${p.settings.sfx === false ? "selected" : ""}>关闭音效</option>
        </select>
      </div>
      <div class="field"><label>画幅</label>
        <select id="set-aspect">
          <option value="16:9" ${aspect === "16:9" ? "selected" : ""}>16:9 · 1280×720（横屏）</option>
          <option value="1:1" ${aspect === "1:1" ? "selected" : ""}>1:1 · 1280×1280（方形，顶部标题 · 底部字幕）</option>
        </select>
      </div>
    </div>
    ${stageAlert("render")}
    ${durCheck ? (durCheck.enough
      ? `<div class="alert info">已挂载素材 ${durCheck.count} 个，共 ${durCheck.assetDur.toFixed(1)} 秒；配音时长 ${durCheck.voiceDur.toFixed(1)} 秒，画面素材时长充足，可合成。</div>`
      : `<div class="alert err">已挂载素材 ${durCheck.count} 个，共 ${durCheck.assetDur.toFixed(1)} 秒；配音时长 ${durCheck.voiceDur.toFixed(1)} 秒，还差约 ${durCheck.gap} 秒，请先补充视频 / 图片素材后再合成。</div>`) : ""}
    <div style="display:flex; gap:10px; margin-bottom:16px;">
      <button class="btn" id="btn-render" ${running || insufficient ? "disabled" : ""}>${running ? "合成中…" : "开始合成成片"}</button>
    </div>
    ${p.render.file ? `
      <video class="preview-video" controls src="${fileUrl(p.id, p.render.file)}"></video>
      <div class="proj-actions" style="margin-top:14px;">
        <a class="btn sm ghost" href="${fileUrl(p.id, p.render.file)}" download>下载成片 MP4</a>
        <a class="btn sm ghost" href="${fileUrl(p.id, "export/cover.png")}" download>下载封面</a>
        <a class="btn sm ghost" href="${fileUrl(p.id, "export/script.md")}" download>脚本文档 MD</a>
        <a class="btn sm ghost" href="${fileUrl(p.id, "export/script.csv")}" download>脚本表格 CSV</a>
      </div>` : ""}`;

  const audio = $("#bgm-audio");
  const sel = $("#set-bgm");
  const volInput = $("#set-vol");

  async function refreshBgmList() {
    const j = await api("/api/assets/bgm");
    state.bgmTracks = j.tracks || (j.files || []).map((f) => ({ name: f, builtin: true }));
  }

  async function saveSettings() {
    await api(`/api/projects/${p.id}`, {
      method: "PUT",
      body: JSON.stringify({
        settings: {
          bgm: sel.value,
          bgmVolume: Number(volInput.value),
          sfx: $("#set-sfx").value === "true",
          aspect: $("#set-aspect").value,
        },
      }),
    });
    await refreshProject();
  }

  // 试听当前选中 BGM
  $("#btn-bgm-play").onclick = () => {
    const name = sel.value;
    if (!name) return toast("请先选择一首 BGM");
    audio.style.display = "block";
    audio.src = `/api/assets/bgm/${encodeURIComponent(name)}`;
    audio.play().catch(() => toast("试听失败，请检查音频文件"));
  };

  volInput.oninput = () => { $("#vol-label").textContent = `${volInput.value}%`; };
  volInput.onchange = saveSettings;

  // 删除已入库 BGM
  $("#btn-bgm-del").onclick = async () => {
    const name = sel.value;
    if (!name) return;
    if (!confirm(`确认删除 BGM「${name}」？`)) return;
    try {
      await api(`/api/assets/bgm/${encodeURIComponent(name)}`, { method: "DELETE" });
      await refreshBgmList();
      if (p.settings.bgm === name) p.settings.bgm = "";
      await saveSettings();
      toast("BGM 已删除");
      renderStep();
    } catch (e) { toast(e.message); }
  };

  // 上传 BGM 入库
  $("#btn-bgm-upload").onclick = () => $("#bgm-upload").click();
  $("#bgm-upload").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = await fetch(`/api/assets/bgm?filename=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await refreshBgmList();
      p.settings.bgm = j.file;
      await saveSettings();
      toast("BGM 已存入系统库");
      renderStep();
    } catch (err) { toast(err.message); }
    e.target.value = "";
  };

  sel.onchange = () => {
    if (!sel.value) { audio.pause(); audio.style.display = "none"; }
    saveSettings();
  };
  $("#set-sfx").onchange = saveSettings;
  $("#set-aspect").onchange = saveSettings;

  $("#btn-render").onclick = async () => {
    if (insufficient) { toast("素材时长不足，请先补充视频 / 图片素材"); return; }
    try {
      await saveSettings();
      await api(`/api/projects/${p.id}/render`, { method: "POST" });
      await refreshProject();
      renderStep();
    } catch (e) { toast(e.message); }
  };
}

// 启动
(async () => {
  try {
    const cfg = await api("/api/config");
    state.config = cfg;
  } catch { /* 忽略 */ }
  loadList();
})();
