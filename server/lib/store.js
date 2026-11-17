// 项目本地存储：每个项目一个目录，project.json 为状态真源
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CONFIG } from "../config.js";

const ROOT = CONFIG.projectsRoot;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function projectDir(id) {
  return path.join(ROOT, id);
}

export function projectPaths(id) {
  const dir = projectDir(id);
  return {
    dir,
    json: path.join(dir, "project.json"),
    uploads: path.join(dir, "uploads"),
    audio: path.join(dir, "audio"),
    assets: path.join(dir, "assets"),
    ai: path.join(dir, "ai"),
    export: path.join(dir, "export"),
  };
}

function sanitizeName(name) {
  return String(name || "factory")
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "factory";
}

function emptyProject(company = {}) {
  const now = new Date().toISOString();
  return {
    id: "",
    createdAt: now,
    updatedAt: now,
    company: {
      nameZh: company.nameZh || "",
      nameEn: company.nameEn || "",
      brand: company.brand || "",
      website: company.website || "",
      intro: company.intro || "",
      gateImage: "",
    },
    sellingPoints: { points: [], summary: "", rawText: "" },
    script: { title: { en: "", zh: "" }, sentences: [] },
    voice: { speaker: CONFIG.tts.speaker, audioFile: "", ready: false },
    assets: [],
    opening: { status: "idle", taskId: "", videoFile: "", prompt: "", error: "" },
    cover: { status: "idle", imageFile: "", candidates: [], prompt: "", error: "" },
    render: { status: "idle", file: "", duration: 0, exportedAt: "", error: "" },
    stages: {
      info: { status: "idle", error: "", updatedAt: "" },
      script: { status: "idle", error: "", updatedAt: "" },
      voice: { status: "idle", error: "", updatedAt: "" },
      assets: { status: "idle", error: "", updatedAt: "" },
      opening: { status: "idle", error: "", updatedAt: "" },
      cover: { status: "idle", error: "", updatedAt: "" },
      render: { status: "idle", error: "", updatedAt: "" },
    },
    settings: { bgm: "", bgmVolume: 50, sfx: true, aspect: "16:9", subtitleEn: true, subtitleZh: true },
  };
}

// 记录某一环节状态：idle / running / done / failed
export function setStage(p, key, status, error = "") {
  p.stages = p.stages || {};
  p.stages[key] = { status, error: error || "", updatedAt: new Date().toISOString() };
  return p.stages[key];
}

// 由统一素材池推导素材环节状态
export function refreshAssetsStage(p) {
  const mounted = Array.isArray(p.assets) && p.assets.length > 0;
  return setStage(p, "assets", mounted ? "done" : "idle");
}

export function deriveStatus(p) {
  if (p.render.file) return "rendered";
  const assetReady = Array.isArray(p.assets) && p.assets.length > 0;
  if (p.cover.imageFile && p.voice.audioFile && assetReady && p.opening.videoFile) return "ready-to-render";
  if (p.voice.audioFile && assetReady) return "assets-mounted";
  if (p.voice.audioFile) return "voice-done";
  if (p.script.sentences.length) return "script-done";
  return "draft";
}

export function createProject(company = {}) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const p = emptyProject(company);
  p.id = id;
  const paths = projectPaths(id);
  ensureDir(paths.uploads);
  ensureDir(paths.audio);
  ensureDir(paths.assets);
  ensureDir(paths.ai);
  ensureDir(paths.export);
  saveProject(p);
  return p;
}

export function listProjects() {
  if (!fs.existsSync(ROOT)) return [];
  const out = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const p = readProject(entry.name);
      out.push({
        id: p.id,
        nameZh: p.company.nameZh,
        nameEn: p.company.nameEn,
        brand: p.company.brand,
        website: p.company.website,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        status: deriveStatus(p),
        coverUrl: p.cover.imageFile ? `/api/projects/${p.id}/file/${encodeURIComponent(p.cover.imageFile)}` : "",
        videoUrl: p.render.file ? `/api/projects/${p.id}/file/${encodeURIComponent(p.render.file)}` : "",
        gateUrl: p.company.gateImage ? `/api/projects/${p.id}/file/${encodeURIComponent(p.company.gateImage)}` : "",
      });
    } catch {
      // 跳过损坏目录
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function readProject(id) {
  const paths = projectPaths(id);
  if (!fs.existsSync(paths.json)) throw new Error("项目不存在");
  const raw = JSON.parse(fs.readFileSync(paths.json, "utf8"));
  return { ...emptyProject(raw.company), ...raw, id };
}

export function saveProject(p) {
  p.updatedAt = new Date().toISOString();
  const paths = projectPaths(p.id);
  ensureDir(paths.dir);
  fs.writeFileSync(paths.json, JSON.stringify(p, null, 2), "utf8");
  return p;
}

export function updateProject(id, patch) {
  const p = readProject(id);
  const merged = { ...p, ...patch, id };
  saveProject(merged);
  return merged;
}

export function removeProject(id) {
  const dir = projectDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

export function projectExists(id) {
  return fs.existsSync(projectPaths(id).json);
}

// 校验相对路径不逃逸出项目目录
export function resolveProjectFile(id, rel) {
  const paths = projectPaths(id);
  const abs = path.normalize(path.join(paths.dir, rel));
  if (!abs.startsWith(paths.dir)) throw new Error("非法路径");
  return abs;
}

export function saveUpload(id, slot, filename, buffer) {
  const paths = projectPaths(id);
  const ext = path.extname(filename).toLowerCase().slice(0, 8) || ".bin";
  const safeSlot = sanitizeName(slot);
  const name = `${safeSlot}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const targetDir = slot === "gate" ? paths.uploads : paths.assets;
  ensureDir(targetDir);
  const rel = path.relative(paths.dir, path.join(targetDir, name));
  fs.writeFileSync(path.join(targetDir, name), buffer);
  return rel.split(path.sep).join("/");
}

export { sanitizeName };
