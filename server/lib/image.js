// 封面生成：大门照（压缩后的参考图）+ 记者形象文字提示词 + 1:1 方形固定商务版式
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { CONFIG } from "../config.js";
import { resolveProjectFile } from "./store.js";
import { runFfmpeg } from "./media.js";

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  return { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[ext] || "image/jpeg";
}

// 参考图先经 ffmpeg 缩到长边 1024、转 JPEG，避免原始大 PNG/base64 体积过大被代理层忽略
async function compressGate(abs) {
  const tmp = path.join(os.tmpdir(), `gate-${crypto.randomBytes(3).toString("hex")}.jpg`);
  try {
    await runFfmpeg(["-i", abs, "-vf", "scale=1024:-2", "-q:v", "4", tmp], { timeout: 30000 });
    const buf = fs.readFileSync(tmp);
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function gateDataUrl(project) {
  if (!project.company.gateImage) return null;
  const abs = resolveProjectFile(project.id, project.company.gateImage);
  if (!fs.existsSync(abs)) return null;
  try {
    return await compressGate(abs);
  } catch {
    // 压缩失败回退原图 base64（保留可读格式）
    return `data:${mimeOf(abs)};base64,${fs.readFileSync(abs).toString("base64")}`;
  }
}

function pickYear(points) {
  const hist = points.find((p) => p.category === "history");
  const m = /(19|20)\d{2}/.exec(hist?.value || hist?.zhValue || "");
  return m ? m[0] : "";
}

export function buildCoverPrompt(project) {
  const brand = project.company.brand || project.company.nameEn || project.company.nameZh;
  const tagline = project.sellingPoints.summary || "";
  const year = pickYear(project.sellingPoints.points);
  const yearLine = year
    ? `第3行 · 历史标识：主标题正下方，"Since ${year}" 橙色 #F58220，中等粗细，字距略加宽。`
    : "";

  return [
    "高端企业探厂视频封面，1:1 方形构图（1024×1024），排版精致有秩序，工厂实景为视觉主角，国际 B2B 商务质感。",
    "【背景】参考图为工厂大门/厂区外景，作为整张封面的实景背景满铺铺满，保留建筑外观、厂牌、道路、绿化与天光的真实样貌与色彩；不要全图罩染、不要去饱和、不要暗角、不要虚化，不要把参考图里的大门换成别的建筑。仅在画面左上约 55% 区域叠加白到透明的渐变白纱：最左上角白色不透明度约 75%，向画面中心平滑过渡到完全透明，用于衬托文字。",
    `【人物】${CONFIG.reporter.en}；抠出干净半身像（腰部以上），置于画面右下三分之一处，从底边向上延伸至约 82% 画面高度，面部与手势朝向镜头；轮廓加约 5 像素白色描边（贴纸效果），配极轻柔投影；不遮挡厂房大门主体，不变形，无多余人物。`,
    "【几何装饰】人物身后两条粗壮斜向平行四边形色带，从右上角斜切至右下方，一条实心橙色 #F58220、一条纯白色，平行紧邻、层级在人物后方；右上角补一小块橙色斜切角收边。不要圆环、波浪、边框、纹理或光效粒子。",
    "【文字排版】全部文字集中在左上半区，单列左对齐，自上而下，行距宽松、层级分明，不重叠不错位，文字区不超过画面宽度 55%：",
    '第1行 · 顶部徽章：橙色 #F58220 实心圆角小标签，白色小号大写、字距加宽英文 "' + CONFIG.branding.program + '"，宽度紧贴文字。',
    `第2行 · 主标题：徽章下方留明显间距，英文 "${brand}" 特粗窄身无衬线大写，纯黑 #111111，Extra Bold，字号巨大醒目，为唯一视觉焦点。`,
    yearLine,
    tagline ? `第4行 · 行业说明：英文 "${tagline}" 常规字重无衬线，深灰 #3A3A3A，字号约主标题 20%，单独成行。` : "",
    `第5行 · 中文标语：中文 "${CONFIG.branding.coverZh}" 常规简体中文，中性中灰 #7A7A7A，字号约主标题 18%，存在感弱于英文但清晰可读。`,
    '第6行 · 行动按钮：文字区底部左侧，橙色 #F58220 实心圆角矩形按钮，内含左侧深色 #111111 播放三角图标与白色大写英文 "VIEW MORE"，小巧精致，宽度仅包住内容。',
    "【硬性要求】全图只允许上述文字；英文按给定拼写精确输出，中文为清晰简体字形；配色仅限橙 #F58220、黑 #111111、深灰 #3A3A3A、中灰 #7A7A7A、白；扁平矢量装饰，边缘锐利。不要水印、不要 logo、不要 AI 生成字样、不要文字溢出、不要人物变形、不要多余人物。",
  ].filter(Boolean).join("\n");
}

async function savePayload(project, payload, index) {
  const rel = `ai/cover-${index + 1}.png`;
  const abs = resolveProjectFile(project.id, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (Buffer.isBuffer(payload)) {
    fs.writeFileSync(abs, payload);
  } else if (/^data:/.test(payload)) {
    fs.writeFileSync(abs, Buffer.from(payload.split(",")[1], "base64"));
  } else {
    const r = await fetch(payload);
    fs.writeFileSync(abs, Buffer.from(await r.arrayBuffer()));
  }
  return rel;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(url, body, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${CONFIG.image.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(t);
  }
}

async function postForm(url, fd, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // multipart：不手动设 Content-Type，由 fetch 自动带 boundary
    return await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${CONFIG.image.key}` },
      body: fd,
    });
  } finally {
    clearTimeout(t);
  }
}

// 可重试的服务端/限流状态码；400/401/403 属请求或鉴权问题，不重试
const RETRYABLE = new Set([429, 500, 502, 503, 529]);
const BACKOFF = [0, 8000, 16000, 28000];

function parseImageItem(j) {
  const item = j.data?.[0];
  if (!item) return null;
  return item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : null);
}

// 主路径：images/edits（multipart image[]），大门照作为参考图被真正采用
async function tryEdits(prompt, dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  const fd = new FormData();
  fd.append("model", CONFIG.image.model);
  fd.append("prompt", prompt);
  fd.append("size", CONFIG.image.size);
  fd.append("n", "1");
  fd.append("image[]", new Blob([buf], { type: m[1] }), "gate.jpg");

  for (let i = 0; i < BACKOFF.length; i++) {
    await sleep(BACKOFF[i]);
    let r;
    try {
      r = await postForm(`${CONFIG.image.base}/images/edits`, fd);
    } catch (e) {
      if (i === BACKOFF.length - 1) throw e;
      continue;
    }
    if (r.ok) return parseImageItem(await r.json());
    const text = await r.text();
    if (RETRYABLE.has(r.status) && i < BACKOFF.length - 1) continue;
    throw new Error(`封面 HTTP ${r.status}: ${text.slice(0, 160)}`);
  }
  return null;
}

// 兜底路径：images/generations 纯文生图（该端点不接收参考图字段）
async function tryGenerations(prompt) {
  const body = { model: CONFIG.image.model, prompt, size: CONFIG.image.size, n: 1 };
  for (let i = 0; i < BACKOFF.length; i++) {
    await sleep(BACKOFF[i]);
    let r;
    try {
      r = await postJson(`${CONFIG.image.base}/images/generations`, body);
    } catch (e) {
      if (i === BACKOFF.length - 1) throw e;
      continue;
    }
    if (r.ok) return parseImageItem(await r.json());
    const text = await r.text();
    if (RETRYABLE.has(r.status) && i < BACKOFF.length - 1) continue;
    throw new Error(`封面 HTTP ${r.status}: ${text.slice(0, 160)}`);
  }
  return null;
}

async function fetchOnePayload(prompt, dataUrl) {
  // 有大门照时走 edits 参考图编辑；失败再回退纯文生图 generations
  if (dataUrl) {
    const edit = await tryEdits(prompt, dataUrl);
    if (edit) return edit;
  }
  const gen = await tryGenerations(prompt);
  if (gen) return gen;
  throw new Error("封面生成失败：图像服务暂不可用（并发/上游限制），请稍后重试");
}

export async function generateCovers(project) {
  const prompt = buildCoverPrompt(project);
  const dataUrl = await gateDataUrl(project);
  project.cover.prompt = prompt;

  // 只生成一张封面，节省算力；不再做多候选三选一
  const payload = await fetchOnePayload(prompt, dataUrl);
  const rel = await savePayload(project, payload, 0);

  project.cover.candidates = [rel];
  project.cover.imageFile = rel;
  project.cover.status = "done";
  project.cover.error = "";
  return project;
}

export function selectCover(project, rel) {
  if (!project.cover.candidates.includes(rel)) throw new Error("封面候选不存在");
  project.cover.imageFile = rel;
  return project;
}
