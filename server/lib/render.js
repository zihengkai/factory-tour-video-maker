// ffmpeg 合成：场景归一化 → 拼接 → 混音（配音主轨 + 商务 BGM 垫底）→ 双语字幕烧录 → 导出
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { projectPaths, resolveProjectFile } from "./store.js";
import { runFfmpeg, ffprobeDuration } from "./media.js";

const FPS = CONFIG.output.fps;

// 按项目设置解析画幅：16:9（1280×720）或 1:1（1280×1280，画面置顶、底部黑条衬托字幕）
function resolveFormat(project) {
  const key = project.settings?.aspect === "1:1" ? "1:1" : "16:9";
  const fmt = CONFIG.output.formats[key] || CONFIG.output.formats["16:9"];
  return { key, width: fmt.width, height: fmt.height, isSquare: key === "1:1" };
}

function fmtTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cc = Math.round((s % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cc).padStart(2, "0")}`;
}

function assEscape(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

function highlightKeywords(en, keywords) {
  let out = assEscape(en);
  for (const kw of keywords || []) {
    if (!kw) continue;
    const safe = assEscape(kw).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(safe, "gi"), `{\\c&H002082F5&}$&{\\c&H00FFFFFF&}`);
  }
  return out;
}

function pickYear(points) {
  const hist = points.find((p) => p.category === "history");
  const m = /(19|20)\d{2}/.exec(hist?.value || hist?.zhValue || "");
  return m ? m[0] : "";
}

// 顶部标题：主标题 = 品牌大写 + Since 年份；次标题 = 固定栏目标语（仅 1:1 叠加）
function titleLines(project) {
  const brand = String(project.company.brand || project.company.nameEn || "").trim().toUpperCase();
  const year = pickYear(project.sellingPoints?.points || []);
  const main = year ? `${brand}  Since ${year}` : brand;
  const sub = `${CONFIG.branding.program}  ·  ${CONFIG.branding.programZh}`;
  return { main, sub };
}

function trimLines(lines) {
  return lines.map((l) => l.trim()).filter(Boolean);
}

// 长句按标点/空格边界拆成上下句，避免在一个字幕块里折成多行堆叠，也不切断单词或数字
// 切完还要复查：标点段可能仍然过长（如 "...1975, we bring 50 years ... worldwide."），再按空格切一层
function splitLine(text, maxChars) {
  const first = splitLineOnce(text, maxChars);
  const out = [];
  for (const p of first) {
    if (p.length > maxChars) out.push(...splitLineOnce(p, maxChars));
    else out.push(p);
  }
  // 断句别把冠词/介词甩在上一行末尾（"... ensures a" / "production capacity ..." 读起来是断的）
  for (let i = 0; i < out.length - 1; i++) {
    const m = out[i].match(/([A-Za-z]+)$/);
    if (!m || !WEAK_TAIL.has(m[1].toLowerCase())) continue;
    const w = m[1];
    out[i] = out[i].slice(0, out[i].length - w.length).trim();
    out[i + 1] = `${w} ${out[i + 1]}`.trim();
  }
  return out.filter(Boolean);
}

const WEAK_TAIL = new Set(["a", "an", "the", "of", "to", "in", "for", "and", "or", "with", "at", "by", "on", "from", "that", "is", "are", "as", "its", "their"]);

function splitLineOnce(text, maxChars) {
  const t = String(text || "").trim();
  if (!t) return [""];
  if (t.length <= maxChars) return [t];

  // 1) 优先在标点后切，贪心合并到不超阈值；数字千分位逗号（如 53,000）不算断点
  const cuts = [];
  for (let i = 0; i < t.length; i++) {
    if (/[,，;；、·]/.test(t[i])) {
      const prev = t[i - 1] || "";
      const next = t[i + 1] || "";
      if (!(/\d/.test(prev) && /\d/.test(next))) cuts.push(i + 1);
    }
  }
  if (cuts.length) {
    const parts = [];
    let prev = 0;
    for (const c of cuts) {
      parts.push(t.slice(prev, c));
      prev = c;
    }
    parts.push(t.slice(prev));
    const lines = [];
    let cur = "";
    for (const p of parts) {
      if ((cur + p).length <= maxChars) cur += p;
      else {
        if (cur) lines.push(cur);
        cur = p;
      }
    }
    if (cur) lines.push(cur);
    if (lines.length > 1) return trimLines(lines);
  }

  // 2) 含空格的文本（英文等）：在最接近中点的空格处断，不切断单词
  const spaces = [...t.matchAll(/\s/g)].map((m) => m.index);
  if (spaces.length) {
    const mid = Math.ceil(t.length / 2);
    const cut = spaces.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a), spaces[0]);
    return trimLines([t.slice(0, cut), t.slice(cut)]);
  }

  // 3) 中文等无空格文本：对半切
  const half = Math.ceil(t.length / 2);
  return trimLines([t.slice(0, half), t.slice(half)]);
}

// 按比例切成 n 段，切点优先落在标点、空格与常见句首词上，避免把中文词切成两半
const ZH_HEADS = ["确保", "提供", "覆盖", "拥有", "服务", "专注", "坚持", "实现", "通过", "以及", "并", "为", "在", "与", "和", "及", "以"];
function splitEven(text, n) {
  const t = String(text || "").trim();
  if (!t || n <= 1) return [t];
  const out = [];
  let start = 0;
  for (let i = 1; i < n; i++) {
    const remain = n - i; // 后面还要切出的段数
    const ideal = start + Math.round((t.length - start) / (remain + 1));
    const minLen = 6; // 任何一段都不留孤零零的两三个字
    const maxPos = t.length - minLen * remain;
    // 切点池：优先标点后，其次空格后，最后才是纯按字数均分
    const puncts = [];
    const spaces = [];
    for (let c = start + minLen; c <= maxPos; c++) {
      const prev = t[c - 1] || "";
      const next = t[c] || "";
      const thousand = /\d/.test(prev) && /\d/.test(next);
      if (!thousand && /[,，。;；、]/.test(prev)) puncts.push(c);
      if (t[c] === " " && next !== " ") spaces.push(c + 1);
    }
    const pool = puncts.length ? puncts : spaces.length ? spaces : [];
    let cut;
    if (pool.length) {
      cut = pool.reduce((a, b) => (Math.abs(b - ideal) < Math.abs(a - ideal) ? b : a), pool[0]);
    } else {
      cut = Math.min(Math.max(ideal, start + minLen), maxPos);
    }
    if (cut <= start || cut >= t.length) cut = ideal;
    out.push(t.slice(start, cut).trim());
    start = cut;
  }
  out.push(t.slice(start).trim());
  return out.filter(Boolean);
}

// 句子过长时按字数上限拆成 N 段，时段在原句内均分；中英段数必须一致，避免出现只有单语的段落
function splitSentence(s, enMax, zhMax) {
  let enParts = splitLine(s.en, enMax);
  let zhParts = splitLine(s.zh, zhMax);
  const n = Math.max(enParts.length, zhParts.length);
  if (enParts.length < n) enParts = splitEven(s.en, n);
  if (zhParts.length < n) zhParts = splitEven(s.zh, n);
  const span = Math.max((s.end - s.start) / n, 0.1);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      start: s.start + span * i,
      end: s.start + span * (i + 1),
      en: enParts[i] || "",
      zh: zhParts[i] || "",
      keywords: i === 0 ? s.keywords : [],
    });
  }
  return out;
}

// ---- 卖点卡（弹幕）规范：参照 HyperFrames overlays.md / motion.md ----
// 卡片 = 深色底板 + 品牌橙色竖条 + 大字重关键词；入场 0.22s 左移淡入、出场 0.2s 淡出；
// 单卡静态停留不超过 6s（静态卡超过约 8s 会读成死画面），一屏只出现一张。
// 字宽按本机 libass 实测标定：中文 ≈0.93em、小写 ≈0.40em（GDI MeasureString 会偏高约 30%，不能直接用）
function estTextWidth(text, fs, spacing = 1) {
  let w = 0;
  for (const ch of [...String(text || "")]) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) w += fs * 0.93;
    else if (ch === " ") w += fs * 0.26;
    else if (/[A-Z]/.test(ch)) w += fs * 0.5;
    else if (/[a-z]/.test(ch)) w += fs * 0.4;
    else if (/[0-9]/.test(ch)) w += fs * 0.5;
    else w += fs * 0.33;
  }
  return w + spacing * [...String(text || "")].length;
}

function cardPlain(keywords) {
  return (keywords || []).filter(Boolean).slice(0, 2).join("  ·  ");
}

// 关键词分色：主词白色，次词品牌橙（规范：一个强调词用品牌色承载含义）
function cardRich(keywords) {
  const list = (keywords || []).filter(Boolean).slice(0, 2).map(assEscape);
  if (!list.length) return "";
  const sep = "{\\c&H00A8A8A8&}  ·  ";
  return `{\\c&H00FFFFFF&}${list[0]}` + (list[1] ? `${sep}{\\c&H002082F5&}${list[1]}` : "");
}

function cardGeometry(text, fmt) {
  const fs = fmt.isSquare ? 40 : 34;
  const cardTop = fmt.isSquare ? 182 : 30; // 1:1 主体从 y=170 起，卡片落在画面内
  const left = 36;
  const barW = 5;
  const textX = left + barW + 14;
  const maxW = fmt.width - textX - 48;
  let plain = String(text || "");
  let tw = estTextWidth(plain, fs);
  if (tw > maxW) {
    plain = plain.slice(0, Math.max(6, Math.floor((plain.length * maxW) / tw)));
    tw = estTextWidth(plain, fs);
  }
  const plateX = left - 12;
  const plateW = Math.round(tw + (textX - plateX) + 24);
  const plateH = Math.round(fs * 1.6);
  const barH = plateH - 16;
  const barTop = cardTop + 8;
  const textY = cardTop + Math.round((plateH - fs * 1.28) / 2);
  return { fs, cardTop, plateX, plateW, plateH, barLeft: left, barW, barTop, barH, textX, textY, plain };
}

// 底板 / 色条用 ASS 矢量绘制（本机 libass 不渲染 BorderStyle 3 底色块，绘制矩形稳定）
function drawRect(x, y, w, h, colorBgr, alphaHex) {
  return `{\\an7\\move(${x - 26},${y},${x},${y},0,220)\\fad(160,200)\\p1\\bord0\\shad0\\1c&H${colorBgr}&\\1a&H${alphaHex}&}m 0 0 l ${w} 0 l ${w} ${h} l 0 ${h} l 0 0{\\p0}`;
}

// 字幕按语言各自成段：同一种语言内部按标点/空格切成单行，再按字数比例分配该句时长。
// 中英段数不必相等——强行等分会把中文词切碎（“智能工/厂确保”），各走各的时间轴更自然。
function langSegments(project, key, maxChars) {
  const out = [];
  for (const s of project.script.sentences) {
    const text = String(s[key] || "").trim();
    if (!text) continue;
    const parts = splitLine(text, maxChars);
    const weights = parts.map((p) => Math.max(1, [...p].length));
    const totalW = weights.reduce((a, b) => a + b, 0);
    const span = Math.max((s.end || 0) - (s.start || 0), 0.1);
    let acc = 0;
    for (let i = 0; i < parts.length; i++) {
      const base = s.start || 0;
      // 字幕不从 0s 起跳，被第一帧就压上字会很突然（规范建议 0.1–0.3s 切入）
      const lead = base === 0 && i === 0 ? 0.12 : 0;
      const start = base + (span * acc) / totalW + lead;
      acc += weights[i];
      const end = base + (span * acc) / totalW;
      out.push({ start, end, text: parts[i], keywords: s.keywords || [] });
    }
  }
  return out;
}

// 卖点卡出场计划：开场镜头段不出卡；每张卡延后 0.15s 入场（字幕不要卡在 0s 上），最长停留 6s
function planCards(project, fmt) {
  const cards = [];
  project.script.sentences.forEach((s, si) => {
    if (si === 0 || !s.keywords?.length) return;
    const start = (s.start || 0) + 0.15;
    const end = Math.min(s.end || 0, start + 6);
    if (end - start < 1) return;
    cards.push({ start, end, keywords: s.keywords, text: cardPlain(s.keywords) });
  });
  return cards;
}

function buildAss(project, fmt) {
  const showEn = project.settings?.subtitleEn !== false;
  const showZh = project.settings?.subtitleZh !== false;
  // 1:1 布局：顶部标题区 + 中部视频 + 底部字幕区；字幕上移贴近主体下方，单行展示
  const enSize = fmt.isSquare ? 38 : 32;
  const zhSize = fmt.isSquare ? 36 : 28;
  const enMargin = fmt.isSquare ? 320 : 72;
  const zhMargin = fmt.isSquare ? 258 : 34;
  const cardFs = fmt.isSquare ? 40 : 34;

  const styles = [
    "[Script Info]",
    "Title: Factory Tour Bilingual Subtitles",
    `PlayResX: ${fmt.width}`,
    `PlayResY: ${fmt.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: En,Microsoft YaHei,${enSize},&H00FFFFFF,&H000000FF,&H00141414,&H64000000,-1,0,0,0,100,100,0,0,1,1.2,0.6,2,60,60,${enMargin},1`,
    `Style: Zh,Microsoft YaHei,${zhSize},&H00FFFFFF,&H000000FF,&H00141414,&H64000000,-1,0,0,0,100,100,0.5,0,1,1.2,0.5,2,60,60,${zhMargin},1`,
    // 卖点卡文字：大字重白色 + 轻描边压住明暗底，位置由事件内 \pos/\move 精确控制
    `Style: Card,Microsoft YaHei,${cardFs},&H00FFFFFF,&H000000FF,&H00101014,&H00000000,-1,0,0,0,100,100,1,0,1,1.8,0.6,7,36,36,182,1`,
  ];

  // 1:1 顶部标题样式：栏目小标 / 品牌大字 / 中文栏目名，分层排版（黑底上用字重与字距做层次）
  if (fmt.isSquare) {
    styles.push(
      "Style: TitleEyebrow,Microsoft YaHei,19,&H009BA1AB,&H000000FF,&H00141414,&H00000000,0,0,0,0,100,100,7,0,1,0.6,0.3,8,60,60,0,1",
      "Style: TitleMain,Microsoft YaHei,64,&H00FFFFFF,&H000000FF,&H00141414,&H00000000,-1,0,0,0,100,100,4,0,1,1.6,0.7,8,60,60,0,1",
      "Style: TitleZh,Microsoft YaHei,23,&H00B9BEC7,&H000000FF,&H00141414,&H00000000,0,0,0,0,100,100,7,0,1,0.8,0.4,8,60,60,0,1"
    );
  }
  styles.push("", "[Events]");

  // 顶部标题全程显示（仅 1:1）：三层锁定版式
  //   ① 栏目小标：橙色小方块 + 栏目名（小字距宽、灰白），做杂志刊头的收口
  //   ② 品牌大字：品牌名 64px 粗体 + 内联橙色 "Since 年份"，一次读清品牌与年份
  //   ③ 中文栏目名：小字灰色，与上排形成主次层级
  //   ④ 底部 1px 细线把标题区与画面区分开（黑底上的一条界线，比整块色条克制）
  if (fmt.isSquare) {
    const total = Math.max(...project.script.sentences.map((s) => s.end || 0), 1);
    const cx = Math.round(fmt.width / 2);
    const brand = String(project.company.brand || project.company.nameEn || "").trim().toUpperCase();
    const year = pickYear(project.sellingPoints?.points || []);
    const eyebrow = CONFIG.branding.program;
    const zhTag = CONFIG.branding.programZh;

    const eyebrowW = Math.round(estTextWidth(eyebrow, 19, 7));
    const sq = 7; // 栏目名左侧的橙色小方块，作为刊头记号
    const gap = 12;
    const clusterW = sq + gap + eyebrowW;
    const sqX = cx - Math.round(clusterW / 2);
    const textX = sqX + sq + gap;
    const plainRect = (x, y, w, h, colorBgr, alphaHex) =>
      `{\\an7\\pos(${x},${y})\\fad(500,300)\\p1\\bord0\\shad0\\1c&H${colorBgr}&\\1a&H${alphaHex}&}m 0 0 l ${w} 0 l ${w} ${h} l 0 ${h} l 0 0{\\p0}`;

    styles.push(`Dialogue: 0,0:00:00.00,${fmtTime(total)},TitleEyebrow,,0,0,0,,{\\an7\\pos(${textX},22)\\fad(500,300)}${assEscape(eyebrow)}`);
    styles.push(`Dialogue: 0,0:00:00.00,${fmtTime(total)},TitleEyebrow,,0,0,0,,${plainRect(sqX, 26, sq, sq, "002082F5", "00")}`);

    const brandEsc = assEscape(brand);
    const mainLine = year
      ? `{\\an8\\pos(${cx},50)\\fad(700,300)}${brandEsc}{\\fsp1\\fs22\\c&H002082F5&}   SINCE ${assEscape(year)}{\\c&H00FFFFFF&}`
      : `{\\an8\\pos(${cx},50)\\fad(700,300)}${brandEsc}`;
    styles.push(`Dialogue: 0,0:00:00.00,${fmtTime(total)},TitleMain,,0,0,0,,${mainLine}`);

    styles.push(`Dialogue: 0,0:00:00.00,${fmtTime(total)},TitleZh,,0,0,0,,{\\an8\\pos(${cx},120)\\fad(800,300)}${assEscape(zhTag)}`);
    styles.push(`Dialogue: 0,0:00:00.00,${fmtTime(total)},TitleZh,,0,0,0,,${plainRect(60, 156, fmt.width - 120, 1, "00262A31", "00")}`);
  }

  // 卖点卡：底板 + 橙色竖条 + 关键词三层同时入场/出场，落点固定在主体画面内
  for (const c of planCards(project, fmt)) {
    const geo = cardGeometry(c.text, fmt);
    const t0 = fmtTime(c.start);
    const t1 = fmtTime(c.end);
    styles.push(`Dialogue: 0,${t0},${t1},Card,,0,0,0,,${drawRect(geo.plateX, geo.cardTop, geo.plateW, geo.plateH, "0016100F", "38")}`);
    styles.push(`Dialogue: 0,${t0},${t1},Card,,0,0,0,,${drawRect(geo.barLeft, geo.barTop, geo.barW, geo.barH, "002082F5", "00")}`);
    const mv = `\\an7\\move(${geo.textX - 26},${geo.textY},${geo.textX},${geo.textY},0,220)\\fad(160,200)`;
    styles.push(`Dialogue: 0,${t0},${t1},Card,,0,0,0,,{${mv}}${cardRich(c.keywords)}`);
  }

  for (const p of langSegments(project, "en", fmt.isSquare ? 58 : 52)) {
    if (!showEn) break;
    styles.push(`Dialogue: 0,${fmtTime(p.start)},${fmtTime(p.end)},En,,0,0,0,,${highlightKeywords(p.text, p.keywords)}`);
  }
  // 中文按整句一行（32 字以内都能单行放下），英文按标点/空格分片；中文整句在场，观众始终读到完整语义
  for (const p of langSegments(project, "zh", 32)) {
    if (!showZh) break;
    styles.push(`Dialogue: 0,${fmtTime(p.start)},${fmtTime(p.end)},Zh,,0,0,0,,${assEscape(p.text)}`);
  }
  return styles.join("\n");
}

const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".bmp"];
// 提供给单测：校验中英分段是否成对、是否切在词中间
export { splitSentence, splitEven, planCards, planSfx, buildAss };
// 图片素材固定展示秒数；视频素材按原始完整时长取用，不裁剪单段、不循环复用
const IMAGE_HOLD = 3;

// 汇总素材池总时长：视频取原始时长，图片按固定展示时长
export async function summarizeAssets(project) {
  const assets = Array.isArray(project.assets) ? project.assets : [];
  let assetDur = 0;
  for (const a of assets) {
    const abs = resolveProjectFile(project.id, a.file);
    const isImg = a.kind === "image" || IMAGE_EXT.includes(path.extname(a.file || "").toLowerCase());
    assetDur += isImg ? IMAGE_HOLD : (await ffprobeDuration(abs)) || 0;
  }
  return { assetDur, count: assets.length };
}

async function prepareClips(project) {
  const paths = projectPaths(project.id);
  const clipsDir = path.join(paths.export, "clips");
  fs.mkdirSync(clipsDir, { recursive: true });
  const listLines = [];
  const fmt = resolveFormat(project);
  const { width: W, height: H, isSquare } = fmt;

  // 开场镜头占第一句时段；其余素材按完整时长依次拼接，成片按配音总时长兜底截断
  const first = project.script.sentences[0];
  const openingDur = Math.max(+(first?.end || 0), 1);

  let totalDur = openingDur;
  const voiceFile = resolveProjectFile(project.id, project.voice.audioFile);
  if (fs.existsSync(voiceFile)) totalDur = await ffprobeDuration(voiceFile);
  const restDur = Math.max(totalDur - openingDur, 0);

  // 1:1 时 16:9 画面置于标题区与字幕区之间（y=170，高 720），上下留黑边；16:9 画面居中黑边
  const padY = isSquare ? "170" : "(oh-ih)/2";
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:${padY}:color=black,fps=${FPS},setsar=1`;

  async function makeClip(rel, dur, idx) {
    const out = path.join(clipsDir, `clip-${idx}.mp4`);
    if (rel && fs.existsSync(resolveProjectFile(project.id, rel))) {
      const src = resolveProjectFile(project.id, rel);
      const isImg = IMAGE_EXT.includes(path.extname(src).toLowerCase());
      const args = isImg
        ? ["-loop", "1", "-t", String(dur || IMAGE_HOLD), "-i", src, "-vf", vf, "-an", "-r", String(FPS), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out]
        : ["-i", src, "-vf", vf, "-an", "-r", String(FPS), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out];
      await runFfmpeg(args);
    } else {
      await runFfmpeg([
        "-f", "lavfi", "-i", `color=c=0x1a1d21:s=${W}x${H}:d=${dur}:r=${FPS}`,
        "-vf", vf, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out,
      ]);
    }
    listLines.push(`file '${path.basename(out)}'`);
    const real = (await ffprobeDuration(out)) || dur || 0;
    made.push({ file: out, dur: real });
  }

  const made = [];

  // 0：AI 开场镜头
  await makeClip(project.opening.videoFile, openingDur, 0);

  // 1…：统一素材池，每个素材按完整时长依次使用一遍，不裁剪单段、不循环复用；无素材时占位铺满
  const assets = Array.isArray(project.assets) ? project.assets : [];
  if (assets.length) {
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      const isImg = a.kind === "image" || IMAGE_EXT.includes(path.extname(a.file || "").toLowerCase());
      await makeClip(a.file, isImg ? IMAGE_HOLD : 0, i + 1);
    }
  } else {
    await makeClip("", restDur, 1);
  }

  // 转场（参照 HyperFrames motion.md）：素材之间用交叉溶解，开场段接第一段用短淡黑做章节切；
  // 素材总时长必须留出转场重叠的余量，余量不足时退回硬切，保证成片长度不被转场吃掉。
  const TD_OPEN = 0.26;
  const TD_MAIN = 0.18;
  const cuts = made.length - 1;
  const clipTotal = made.reduce((sum, c) => sum + c.dur, 0);
  const overlapNeed = cuts > 0 ? TD_OPEN + TD_MAIN * Math.max(0, cuts - 1) : 0;
  const silent = path.join(paths.export, "silent.mp4");
  const cutTimes = [];

  if (cuts > 0 && clipTotal - totalDur >= overlapNeed + 1) {
    const parts = [];
    const inputs = [];
    for (let i = 0; i < made.length; i++) {
      inputs.push("-i", made[i].file);
      parts.push(`[${i}:v]setpts=PTS-STARTPTS[c${i}]`);
    }
    let acc = made[0].dur;
    let label = "c0";
    for (let k = 1; k < made.length; k++) {
      const td = k === 1 ? TD_OPEN : TD_MAIN;
      const offset = Math.max(0, acc - td);
      const trans = k === 1 ? "fadeblack" : "fade";
      const outLabel = `x${k}`;
      parts.push(`[${label}][c${k}]xfade=transition=${trans}:duration=${td}:offset=${offset.toFixed(3)}[${outLabel}]`);
      cutTimes.push(offset + td / 2);
      acc = acc + made[k].dur - td;
      label = outLabel;
    }
    parts.push(`[${label}]format=yuv420p[vout]`);
    await runFfmpeg([
      ...inputs,
      "-filter_complex", parts.join(";"),
      "-map", "[vout]",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-crf", "20", "-r", String(FPS),
      "-t", totalDur.toFixed(2), silent,
    ], { timeout: 600000 });
  } else {
    const listFile = path.join(clipsDir, "clips.txt");
    fs.writeFileSync(listFile, listLines.join("\n"), "utf8");
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", silent]);
    let acc = 0;
    for (let k = 0; k < made.length - 1; k++) {
      acc += made[k].dur;
      cutTimes.push(acc);
    }
  }

  return { silent, fmt, totalDur, cutTimes };
}

function pickBgm(project) {
  const name = project.settings?.bgm;
  if (!name) return null;
  const bgmDir = path.join(CONFIG.assetsRoot, "bgm");
  const file = path.join(bgmDir, path.basename(name));
  return fs.existsSync(file) ? file : null;
}

function writeScriptDocs(project) {
  const paths = projectPaths(project.id);
  const rows = project.script.sentences.map((s, i) => ({
    no: i + 1, en: s.en, zh: s.zh, keywords: (s.keywords || []).join(", "), scene: s.scene || "",
  }));
  const md = [
    `# ${project.company.nameEn || project.company.nameZh} 探厂脚本`,
    "",
    `品牌：${project.company.brand}　官网：${project.company.website}`,
    "",
    "| # | English | 中文 | 关键词 | 画面 |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.no} | ${r.en} | ${r.zh} | ${r.keywords} | ${r.scene} |`),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(paths.export, "script.md"), md, "utf8");

  const csv = ["\uFEFF序号,English,中文,关键词,画面", ...rows.map((r) =>
    [r.no, `"${r.en.replace(/"/g, '""')}"`, `"${r.zh.replace(/"/g, '""')}"`, `"${r.keywords}"`, r.scene].join(",")
  )].join("\n");
  fs.writeFileSync(path.join(paths.export, "script.csv"), csv, "utf8");
}

// ---- 音效规划（参照 HyperFrames sound.md）----
// 每个音效都要有画面成因：切点→转场族、卖点卡落点→点缀族、收尾→全片仅一次 impact。
// 同一族内多个文件轮换且不与上一处重复——同一个 whoosh 铺满全片是最典型的模板感来源。
const SFX_FAMILIES = {
  // 切点：深/浅/软三档气流感，全是宣传片式的"扫过"，不含任何叮咚
  cut: ["sfx-whoosh.mp3", "sfx-whoosh-deep.mp3", "sfx-whoosh-soft.mp3", "sfx-transition.mp3", "sfx-transition-deep.mp3"],
  // 卡片落点：轻软的短扫，卡一出现带一阵风，不发清脆金属音
  card: ["sfx-whoosh-short.mp3", "sfx-transition-soft.mp3", "sfx-transition-deep.mp3", "sfx-whoosh-soft.mp3"],
  // 收尾：低频落锤或上扬后再收，全片只用一次
  payoff: ["sfx-impact.mp3", "sfx-impact-low.mp3"],
};

// 每支音效文件的混音增益：按素材实测峰值换算（`npm run setup-audio` 会打印建议值），
// 让不同素材落在同一听感区间，而不是所有文件都套一个统一音量——本身满的 transition 与本身轻的短扫，
// 统一音量时后者等于没响。收尾 impact 刻意比切点低一档，落在最后一句上是托住，不是砸下来。
// 不使用 sparkle / click 这类清亮金币感音效（与商务宣传基调冲突），需要的可自行放入 sfx/ 并改 SFX_FAMILIES。
const SFX_VOLUME = {
  "sfx-whoosh.mp3": 0.53,
  "sfx-whoosh-deep.mp3": 0.55,
  "sfx-whoosh-soft.mp3": 0.89,
  "sfx-whoosh-short.mp3": 0.60,
  "sfx-transition.mp3": 0.46,
  "sfx-transition-deep.mp3": 0.47,
  "sfx-transition-soft.mp3": 0.66,
  "sfx-impact.mp3": 0.45,
  "sfx-impact-low.mp3": 0.45,
  "sfx-riser.mp3": 0.59,
};

// 真随机取一支，并避开最近 3 秒内刚响过的那几支——连着两次同一个音是最容易被听出来的模板感
function pickRandom(files, history, ms) {
  if (!files.length) return "";
  const recent = history.filter((h) => Math.abs(ms - h.ms) < 3000).map((h) => h.file);
  const pool = files.filter((f) => !recent.includes(f));
  const list = pool.length ? pool : files;
  return list[Math.floor(Math.random() * list.length)];
}

function planSfx(project, fmt, cutTimes, totalDur) {
  const out = [];
  const history = [];
  const last = project.script.sentences[project.script.sentences.length - 1];
  const payoffMs = last ? Math.round(((last.start || 0) + 0.15) * 1000) : -1;
  const push = (file, ms) => {
    if (!file) return;
    out.push({ file, ms, vol: SFX_VOLUME[file] ?? 0.4 });
    history.push({ file, ms });
  };

  // 卡片音优先占位：每张卖点卡入场只响一次，且这一支与最近几处不同
  const cards = planCards(project, fmt).filter((c) => c.start < totalDur - 0.3);
  const cardMs = cards.map((c) => Math.round(c.start * 1000));
  for (const c of cards) {
    const ms = Math.round((c.start + 0.04) * 1000);
    // 收尾 impact 前后不再叠卡片音，避免两处音头挤在一起
    if (payoffMs >= 0 && Math.abs(ms - payoffMs) < 800) continue;
    push(pickRandom(SFX_FAMILIES.card, history, ms), ms);
  }

  // 切点音只在"这一刀没有卡片同时入场"时补；两处音效至少隔 1.6s，避免一路叮叮当当
  for (const t of cutTimes || []) {
    if (!t || t < 0.4 || t >= totalDur - 0.3) continue;
    const ms = Math.round((t + 0.06) * 1000);
    if (payoffMs >= 0 && Math.abs(ms - payoffMs) < 900) continue;
    if (cardMs.some((cm) => Math.abs(ms - cm) < 700)) continue;
    if (out.some((e) => Math.abs(e.ms - ms) < 1600)) continue;
    push(pickRandom(SFX_FAMILIES.cut, history, ms), ms);
  }

  if (last && (last.start || 0) < totalDur - 0.5) push(pickRandom(SFX_FAMILIES.payoff, history, payoffMs), payoffMs);
  return out.sort((a, b) => a.ms - b.ms);
}

export async function renderProject(project) {
  const paths = projectPaths(project.id);
  fs.mkdirSync(paths.export, { recursive: true });

  // 合成前硬校验：素材总时长需覆盖开场之后的配音时长，不足则拦截，不进入剪辑
  const voiceFile = resolveProjectFile(project.id, project.voice.audioFile);
  if (!fs.existsSync(voiceFile)) throw new Error("配音音轨不存在，请先生成配音");
  const totalDurRaw = await ffprobeDuration(voiceFile);
  const openingDur = Math.max(+(project.script.sentences[0]?.end || 0), 1);
  const restDur = Math.max(totalDurRaw - openingDur, 0);
  const { assetDur } = await summarizeAssets(project);
  if (assetDur + 1 < restDur) {
    const gap = Math.ceil(restDur - assetDur);
    throw new Error(`素材总时长 ${assetDur.toFixed(1)} 秒，不足配音剩余 ${restDur.toFixed(1)} 秒，还差约 ${gap} 秒，请先补充视频/图片素材后再合成`);
  }

  const { silent, fmt, totalDur: clipDur, cutTimes } = await prepareClips(project);
  const assRel = "export/subs.ass";
  fs.writeFileSync(resolveProjectFile(project.id, assRel), buildAss(project, fmt), "utf8");

  const totalDur = totalDurRaw || clipDur;
  const bgm = pickBgm(project);
  const bgmVol = Math.min(1, Math.max(0, (project.settings?.bgmVolume ?? 50) / 100));

  const silentRel = path.relative(paths.dir, silent).split(path.sep).join("/");
  const voiceRel = path.relative(paths.dir, voiceFile).split(path.sep).join("/");
  const inputs = ["-i", silentRel, "-i", voiceRel];
  const filterParts = ["[0:v]subtitles=export/subs.ass[vout]"];
  const maps = ["-map", "[vout]"];

  // 音频轨：配音主轨 + BGM 垫底 + 有因可循的音效（规范：每个音效都要有画面上的成因）
  const audioLabels = ["1:a"];
  let inputIdx = 2;

  if (bgm) {
    inputs.push("-stream_loop", "-1", "-i", bgm);
    filterParts.push(
      `[${inputIdx}:a]volume=${bgmVol.toFixed(2)},afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(0, totalDur - 2).toFixed(2)}:d=2[bgm]`
    );
    audioLabels.push("bgm");
    inputIdx++;
  }

  if (project.settings.sfx !== false) {
    const sfxDir = path.join(CONFIG.assetsRoot, "sfx");
    // 音效分工：切点用 whoosh/transition 轮换、卡片落点用 sparkle/click/transition 轮换、收尾用一次 impact
    const plan = planSfx(project, fmt, cutTimes, totalDur);
    const byFile = new Map();
    for (const e of plan) {
      if (!byFile.has(e.file)) byFile.set(e.file, []);
      byFile.get(e.file).push(e);
    }
    let sfxSeq = 0;
    for (const [file, list] of byFile) {
      const abs = path.join(sfxDir, file);
      if (!fs.existsSync(abs)) continue;
      // 只播一次：绝不能用 -stream_loop 循环音效输入，否则每个音效会从头到尾无限重复，
      // 13 处落点会被铺成一条连续音墙，听感就是"全程同一个声音且很密"
      inputs.push("-i", abs);
      const idx = inputIdx++;
      const labels = list.map(() => `sx${sfxSeq++}`);
      if (labels.length > 1) {
        filterParts.push(`[${idx}:a]asplit=${labels.length}${labels.map((l) => `[${l}]`).join("")}`);
        list.forEach((e, i) => {
          filterParts.push(`[${labels[i]}]adelay=${e.ms}|${e.ms},volume=${e.vol.toFixed(2)}[o${labels[i]}]`);
          audioLabels.push(`o${labels[i]}`);
        });
      } else {
        const l = labels[0];
        filterParts.push(`[${idx}:a]adelay=${list[0].ms}|${list[0].ms},volume=${list[0].vol.toFixed(2)}[o${l}]`);
        audioLabels.push(`o${l}`);
      }
    }
  }

  filterParts.push(
    `${audioLabels.map((l) => `[${l}]`).join("")}amix=inputs=${audioLabels.length}:duration=first:dropout_transition=2:normalize=0[amixed]`
  );
  // 音效峰值叠在配音上会顶到满刻度，末级加一道限制器，把整片压在 −1.5dB 以下，避免削顶
  filterParts.push("[amixed]alimiter=limit=0.84:attack=5:release=60:level=false[aout]");
  maps.push("-map", "[aout]");

  const outFile = path.join(paths.export, "final.mp4");
  await runFfmpeg(
    [
      ...inputs,
      "-filter_complex", filterParts.join(";"),
      ...maps,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-movflags", "+faststart", "-t", totalDur.toFixed(2), outFile,
    ],
    { timeout: 600000, cwd: paths.dir }
  );

  if (project.cover.imageFile) {
    const coverAbs = resolveProjectFile(project.id, project.cover.imageFile);
    if (fs.existsSync(coverAbs)) fs.copyFileSync(coverAbs, path.join(paths.export, "cover.png"));
  }
  writeScriptDocs(project);

  project.render.file = "export/final.mp4";
  project.render.duration = +totalDur.toFixed(2);
  project.render.exportedAt = new Date().toISOString();
  project.render.status = "done";
  project.render.error = "";
  return project;
}
