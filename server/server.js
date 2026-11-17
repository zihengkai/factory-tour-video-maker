// Factory Tour Video Maker · 本地服务入口
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, ROOT_DIR, configWarnings } from "./config.js";
import * as store from "./lib/store.js";
import { generateScriptDirect, refineScript } from "./lib/llm.js";
import { synthesizeProject } from "./lib/tts.js";
import { createOpeningTask, pollOpeningTask } from "./lib/video.js";
import { generateCovers, selectCover } from "./lib/image.js";
import { renderProject, summarizeAssets } from "./lib/render.js";
import { ffprobeDuration } from "./lib/media.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const jobs = new Map();

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

// 文件名优先取 URL 查询参数 filename（URL 允许非 ASCII，不触发请求头 Latin-1 校验）；
// 兼容旧版前端放在 X-Filename 请求头里的编码值。
function pickFilename(req) {
  let q = "";
  try { q = new URL(req.url, "http://x").searchParams.get("filename") || ""; } catch { q = ""; }
  const h = req.headers["x-filename"] || "";
  const raw = q || h;
  if (!raw) return "upload.bin";
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      size += c.length;
      if (size > 200 * 1024 * 1024) {
        aborted = true;
        const err = new Error("文件超过 200MB 上限，请压缩后再上传");
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString("utf8"));
}

function assignSentenceIds(script) {
  script.sentences = (script.sentences || []).map((s, i) => ({
    id: `s${i + 1}`,
    en: s.en || "",
    zh: s.zh || "",
    scene: s.scene || "",
    keywords: s.keywords || [],
    start: 0,
    end: 0,
    audioFile: "",
    asset: { kind: "", file: null, transition: "dissolve" },
    ...(s.asset || {}),
  }));
  return script;
}

const STAGE_LABEL = {
  info: "工厂信息", script: "文案生成", voice: "配音",
  assets: "素材挂载", opening: "开场镜头", cover: "封面生成", render: "视频合成",
};

function runStageJob(projectId, stage, fn) {
  const current = jobs.get(projectId);
  if (current?.running) throw new Error(`当前已有任务（${STAGE_LABEL[current.stage] || current.stage}）进行中，请稍候`);
  jobs.set(projectId, { running: true, stage, error: "", cancelled: false });
  (async () => {
    try {
      let p = store.readProject(projectId);
      store.setStage(p, stage, "running");
      store.saveProject(p);
      await fn();
      if (jobs.get(projectId)?.cancelled || !store.projectExists(projectId)) return;
      p = store.readProject(projectId);
      store.setStage(p, stage, "done");
      store.saveProject(p);
      jobs.set(projectId, { running: false, stage, error: "" });
    } catch (e) {
      const msg = e?.message || String(e);
      try {
        const p = store.readProject(projectId);
        store.setStage(p, stage, "failed", msg);
        store.saveProject(p);
      } catch { /* 项目已删除 */ }
      jobs.set(projectId, { running: false, stage, error: msg });
      console.error(`[job ${projectId}/${stage}]`, msg);
    }
  })();
}

function syncOpeningStage(p) {
  const st = p.opening.status === "done" ? "done"
    : p.opening.status === "failed" ? "failed"
    : p.opening.status === "running" ? "running" : "idle";
  store.setStage(p, "opening", st, p.opening.error || "");
}

async function handleApi(req, res, pathname) {
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length === 2 && parts[1] === "config" && req.method === "GET") {
    return sendJson(res, 200, {
      reporter: CONFIG.reporter,
      output: CONFIG.output,
      tts: { speaker: CONFIG.tts.speaker },
    });
  }

  // /api/projects
  if (req.method === "GET" && parts.length === 2 && parts[1] === "projects") {
    return sendJson(res, 200, { projects: store.listProjects() });
  }
  if (req.method === "POST" && parts.length === 2 && parts[1] === "projects") {
    const body = await readJson(req);
    const p = store.createProject(body.company || {});
    return sendJson(res, 200, { project: p });
  }

  const id = parts[2];
  const sub = parts[3];
  const sub2 = parts[4];

  // /api/projects/:id
  if (parts.length === 3 && parts[1] === "projects") {
    if (req.method === "GET") return sendJson(res, 200, { project: store.readProject(id) });
    if (req.method === "DELETE") {
      jobs.set(id, { running: false, stage: "", error: "", cancelled: true });
      store.removeProject(id);
      jobs.delete(id);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "PUT") {
      const body = await readJson(req);
      const p = store.readProject(id);
      if (body.company) {
        p.company = { ...p.company, ...body.company };
        if (!body.draft) store.setStage(p, "info", "done");
      }
      if (body.settings) p.settings = { ...p.settings, ...body.settings };
      if (body.sellingPoints) p.sellingPoints = body.sellingPoints;
      if (body.script) {
        p.script = assignSentenceIds(body.script);
        store.refreshAssetsStage(p);
      }
      store.saveProject(p);
      return sendJson(res, 200, { project: p });
    }
  }

  // /api/projects/:id/script（基于公司介绍直接提炼成稿，不抓取网页）
  if (sub === "script" && req.method === "POST") {
    const body = await readJson(req);
    store.readProject(id);
    runStageJob(id, "script", async () => {
      const seed = store.readProject(id);
      const refine = Boolean(body.instruction && seed.script.sentences.length);
      let script;
      let sp;
      if (refine) {
        script = await refineScript(seed.company, seed.sellingPoints, seed.script, body.instruction);
      } else {
        const direct = await generateScriptDirect(seed.company, { url: "", pages: [], text: "" }, body.instruction || "");
        script = { title: direct.title, sentences: direct.sentences };
        sp = { summary: direct.summary, points: direct.points, rawText: "", pages: [] };
      }
      if (!store.projectExists(id)) return;
      const cur = store.readProject(id);
      cur.script = assignSentenceIds(script);
      if (sp) cur.sellingPoints = sp;
      store.saveProject(cur);
    });
    return sendJson(res, 200, { ok: true, stage: "script" });
  }

  // /api/projects/:id/script/sentence/:sid
  if (sub === "script" && sub2 === "sentence" && req.method === "PUT") {
    const sid = parts[5];
    const body = await readJson(req);
    const p = store.readProject(id);
    const s = p.script.sentences.find((x) => x.id === sid);
    if (!s) return sendJson(res, 404, { error: "句子不存在" });
    Object.assign(s, body.sentence || {});
    store.saveProject(p);
    return sendJson(res, 200, { project: p });
  }

  // /api/projects/:id/tts
  if (sub === "tts" && req.method === "POST") {
    store.readProject(id);
    runStageJob(id, "voice", async () => {
      const updated = await synthesizeProject(store.readProject(id));
      if (!store.projectExists(id)) return;
      store.saveProject(updated);
    });
    return sendJson(res, 200, { ok: true, stage: "voice" });
  }
  // /api/projects/:id/opening
  if (sub === "opening" && req.method === "POST") {
    const p = store.readProject(id);
    await createOpeningTask(p);
    syncOpeningStage(p);
    store.saveProject(p);
    return sendJson(res, 200, { project: p });
  }
  if (sub === "opening" && sub2 === "poll" && req.method === "GET") {
    const p = store.readProject(id);
    await pollOpeningTask(p);
    syncOpeningStage(p);
    store.saveProject(p);
    return sendJson(res, 200, { project: p });
  }

  // /api/projects/:id/cover
  if (sub === "cover" && req.method === "POST") {
    store.readProject(id);
    runStageJob(id, "cover", async () => {
      const updated = await generateCovers(store.readProject(id));
      if (!store.projectExists(id)) return;
      store.saveProject(updated);
    });
    return sendJson(res, 200, { ok: true, stage: "cover" });
  }
  if (sub === "cover" && sub2 === "select" && req.method === "POST") {
    const body = await readJson(req);
    const p = store.readProject(id);
    selectCover(p, body.rel);
    store.saveProject(p);
    return sendJson(res, 200, { project: p });
  }

  // /api/projects/:id/render/check 素材/配音时长对比，不足时前端先拦截
  if (sub === "render" && sub2 === "check" && req.method === "GET") {
    const p = store.readProject(id);
    const voiceFile = store.resolveProjectFile(p.id, p.voice.audioFile);
    let voiceDur = 0;
    if (fs.existsSync(voiceFile)) voiceDur = await ffprobeDuration(voiceFile);
    const openingDur = Math.max(+(p.script.sentences[0]?.end || 0), 1);
    const restDur = Math.max(voiceDur - openingDur, 0);
    const { assetDur, count } = await summarizeAssets(p);
    const gap = Math.max(0, Math.ceil(restDur - assetDur));
    return sendJson(res, 200, {
      voiceDur: +voiceDur.toFixed(1),
      assetDur: +assetDur.toFixed(1),
      restDur: +restDur.toFixed(1),
      openingDur,
      gap,
      count,
      enough: assetDur + 1 >= restDur,
    });
  }

  // /api/projects/:id/render
  if (sub === "render" && req.method === "POST") {
    const p = store.readProject(id);
    p.render.status = "rendering";
    p.render.error = "";
    store.saveProject(p);
    runStageJob(id, "render", async () => {
      const updated = await renderProject(store.readProject(id));
      if (!store.projectExists(id)) return;
      store.saveProject(updated);
    });
    return sendJson(res, 200, { ok: true, stage: "render" });
  }

  // /api/projects/:id/upload/remove 移除素材池中的某一项
  if (sub === "upload" && sub2 === "remove" && req.method === "POST") {
    const body = await readJson(req);
    const p = store.readProject(id);
    p.assets = Array.isArray(p.assets) ? p.assets : [];
    const idx = Number(body.index);
    if (Number.isInteger(idx) && p.assets[idx]) p.assets.splice(idx, 1);
    store.refreshAssetsStage(p);
    store.saveProject(p);
    return sendJson(res, 200, { project: p });
  }

  // /api/projects/:id/upload/:slot （原始字节流，文件名走 ?filename= 查询参数）
  if (sub === "upload" && sub2 && req.method === "POST") {
    const slot = sub2;
    let buf, filename;
    try {
      buf = await readBody(req);
      filename = pickFilename(req);
    } catch (e) {
      console.error(`[upload] 读取请求体失败 slot=${slot}:`, e);
      return sendJson(res, e?.status || 400, { error: e?.message || "读取上传内容失败" });
    }
    try {
      const rel = store.saveUpload(id, slot, filename, buf);
      const p = store.readProject(id);
      if (slot === "gate") {
        p.company.gateImage = rel;
      } else if (slot === "assets") {
        const isImg = /\.(jpe?g|png|webp|bmp)$/i.test(filename);
        p.assets = Array.isArray(p.assets) ? p.assets : [];
        p.assets.push({ kind: isImg ? "image" : "video", file: rel, transition: "dissolve" });
        store.refreshAssetsStage(p);
      } else {
        const s = p.script.sentences.find((x) => x.id === slot);
        if (s) {
          const isImg = /\.(jpe?g|png|webp|bmp)$/i.test(filename);
          s.asset = { kind: isImg ? "image" : "video", file: rel, transition: s.asset?.transition || "dissolve" };
        }
        store.refreshAssetsStage(p);
      }
      store.saveProject(p);
      return sendJson(res, 200, { project: p, file: rel });
    } catch (e) {
      console.error(`[upload] 落盘/更新失败 slot=${slot} file=${filename} bytes=${buf.length}:`, e);
      const status = /不存在|损坏|JSON|非法路径/.test(e.message) ? 400 : 500;
      return sendJson(res, status, { error: e?.message || String(e) });
    }
  }

  // /api/projects/:id/job 后台任务状态与错误
  if (sub === "job" && req.method === "GET") {
    return sendJson(res, 200, jobs.get(id) || { running: false, stage: "", error: "" });
  }

  // /api/projects/:id/file/*
  if (sub === "file") {
    const rel = decodeURIComponent(parts.slice(4).join("/"));
    return serveFile(req, res, id, rel);
  }

  // /api/assets/sfx 音效列表
  if (parts[1] === "assets" && parts[2] === "sfx" && !parts[3]) {
    const dir = path.join(CONFIG.assetsRoot, "sfx");
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => /\.(mp3|wav|m4a)$/i.test(f))
      : [];
    return sendJson(res, 200, { files });
  }

  // /api/assets/bgm 商务 BGM：列表 / 试听 / 上传入库 / 删除
  if (parts[1] === "assets" && parts[2] === "bgm") {
    const bgmDir = path.join(CONFIG.assetsRoot, "bgm");
    fs.mkdirSync(bgmDir, { recursive: true });
    const AUDIO_EXT = /\.(mp3|wav|m4a)$/i;

    // 列表：files 为文件名数组，tracks 带是否内置标记
    if (!parts[3] && req.method === "GET") {
      const names = fs.readdirSync(bgmDir).filter((f) => AUDIO_EXT.test(f));
      const tracks = names.map((name) => ({ name, builtin: !name.startsWith("user-") }));
      return sendJson(res, 200, { files: names, tracks });
    }

    // 试听（带 Range 流）
    if (parts[3] && req.method === "GET") {
      const name = path.basename(decodeURIComponent(parts[3]));
      const file = path.join(bgmDir, name);
      if (!AUDIO_EXT.test(name) || !fs.existsSync(file)) return sendJson(res, 404, { error: "BGM 不存在" });
      return serveAudio(req, res, file);
    }

    // 手动上传入库：原始字节流 + ?filename= 查询参数
    if (!parts[3] && req.method === "POST") {
      let buf;
      try { buf = await readBody(req); } catch (e) { return sendJson(res, e?.status || 400, { error: e?.message }); }
      const filename = pickFilename(req).trim();
      if (!AUDIO_EXT.test(filename)) return sendJson(res, 400, { error: "仅支持 mp3 / wav / m4a 音频文件" });
      if (!buf.length) return sendJson(res, 400, { error: "音频内容为空" });
      const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^user-/, "");
      let target = "user-" + base;
      let n = 1;
      while (fs.existsSync(path.join(bgmDir, target))) {
        target = `user-${base.replace(/(\.[^.]+)$/, `-${n}$1`)}`;
        n++;
      }
      fs.writeFileSync(path.join(bgmDir, target), buf);
      return sendJson(res, 200, { ok: true, file: target });
    }

    // 删除已入库 BGM（内置曲与上传曲均可删除）
    if (parts[3] && req.method === "DELETE") {
      const name = path.basename(decodeURIComponent(parts[3]));
      const file = path.join(bgmDir, name);
      if (!AUDIO_EXT.test(name) || !fs.existsSync(file)) return sendJson(res, 404, { error: "BGM 不存在" });
      fs.rmSync(file);
      return sendJson(res, 200, { ok: true });
    }
  }

  sendJson(res, 404, { error: "接口不存在" });
}

// 通用音频流（支持 Range 断点试听）
function serveAudio(req, res, abs) {
  const type = MIME[path.extname(abs).toLowerCase()] || "audio/mpeg";
  const stat = fs.statSync(abs);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m?.[1] ? parseInt(m[1], 10) : 0;
    let end = m?.[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (start > end) { res.writeHead(416); return res.end(); }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(abs).pipe(res);
  }
}

function serveFile(req, res, id, rel) {
  let abs;
  try {
    abs = store.resolveProjectFile(id, rel);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return sendJson(res, 404, { error: "文件不存在" });
  const type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
  const stat = fs.statSync(abs);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m?.[1] ? parseInt(m[1], 10) : 0;
    let end = m?.[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (start > end) { res.writeHead(416); return res.end(); }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(abs).pipe(res);
  }
}

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const abs = path.join(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache, must-revalidate",
  });
  fs.createReadStream(abs).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,X-Filename" });
      return res.end();
    }
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    sendJson(res, e?.status || 500, { error: e?.message || String(e) });
  }
});

server.listen(CONFIG.server.port, CONFIG.server.host, () => {
  console.log(`Factory Tour Video Maker 已启动: http://${CONFIG.server.host}:${CONFIG.server.port}`);
  const warnings = configWarnings();
  if (warnings.length) {
    console.log("未配置的能力（不影响本机素材上传与合成）:");
    warnings.forEach((w) => console.log(`  - ${w}`));
    console.log("按 README 的“配置”一节填好环境变量后重启即可启用。");
  }
});
