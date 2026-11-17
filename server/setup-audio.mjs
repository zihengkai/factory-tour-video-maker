// 一次性音频入库：下载免费授权的 BGM / 音效母带，并用 ffmpeg 派生出「商务宣传片」音效族。
//
//   node server/setup-audio.mjs            # 缺什么补什么
//   node server/setup-audio.mjs --force    # 全部重新下载/派生
//   node server/setup-audio.mjs --sfx-only # 只处理音效（BGM 已自备时用）
//
// 母带来源：Mixkit Stock（https://mixkit.co），Mixkit Stock Music Free License /
// Sound Effects Free License，可商用、免署名；派生文件仅做本地 ffmpeg 处理。
// 派生产物与 server/lib/render.js 的 SFX_FAMILIES / SFX_VOLUME 一一对应，改派生配方要同步改音量表。
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT_DIR } from "./config.js";
import { ffmpegBin } from "./lib/media.js";

const execFileP = promisify(execFile);
const FORCE = process.argv.includes("--force");
const SFX_ONLY = process.argv.includes("--sfx-only");

const AUDIO_DIR = path.join(ROOT_DIR, "assets", "audio");
const BGM_DIR = path.join(AUDIO_DIR, "bgm");
const SFX_DIR = path.join(AUDIO_DIR, "sfx");
fs.mkdirSync(BGM_DIR, { recursive: true });
fs.mkdirSync(SFX_DIR, { recursive: true });

// 商务 / 克制 / 企业风的 BGM 清单（全部来自 Mixkit 免费授权库）
const BGM = [
  { file: "bgm-motivating-mornings.mp3", url: "https://assets.mixkit.co/music/33/33.mp3", title: "Motivating Mornings", artist: "Ahjay Stelino", tag: "Corporate" },
  { file: "bgm-close-up.mp3", url: "https://assets.mixkit.co/music/1167/1167.mp3", title: "Close Up", artist: "Michael Ramir C.", tag: "Corporate Music" },
  { file: "bgm-infinity.mp3", url: "https://assets.mixkit.co/music/440/440.mp3", title: "Infinity", artist: "Arulo", tag: "Corporate Music" },
  { file: "bgm-stylz.mp3", url: "https://assets.mixkit.co/music/102/102.mp3", title: "Stylz", artist: "Ahjay Stelino", tag: "Corporate Music" },
  { file: "bgm-your-breath.mp3", url: "https://assets.mixkit.co/music/634/634.mp3", title: "Your Breath", artist: "Eugenio Mininni", tag: "Corporate Music" },
  { file: "bgm-its-love.mp3", url: "https://assets.mixkit.co/music/834/834.mp3", title: "It's Love", artist: "Michael Ramir C.", tag: "Corporate Music" },
  { file: "bgm-placeit-world.mp3", url: "https://assets.mixkit.co/music/724/724.mp3", title: "PlaceIt World 01", artist: "Lily J", tag: "Corporate Music" },
  { file: "bgm-running-out-time.mp3", url: "https://assets.mixkit.co/music/77/77.mp3", title: "Running Out of Time", artist: "Ahjay Stelino", tag: "Corporate Music" },
  { file: "bgm-lofi-04.mp3", url: "https://assets.mixkit.co/music/766/766.mp3", title: "Lo-Fi 04", artist: "Lily J", tag: "Corporate Music" },
  { file: "bgm-digital-clouds.mp3", url: "https://assets.mixkit.co/music/175/175.mp3", title: "Digital Clouds", artist: "Alejandro Magana (A. M.)", tag: "Chillout" },
  { file: "bgm-curiosity.mp3", url: "https://assets.mixkit.co/music/480/480.mp3", title: "Curiosity", artist: "Diego Nava", tag: "Chillout" },
];

// 母带音效：一条 whoosh、一条 transition、一条 impact，派生其余变体
const SOURCES = [
  { file: "sfx-whoosh.mp3", url: "https://assets.mixkit.co/active_storage/sfx/1489/1489-preview.mp3", title: "Whoosh 1489", category: "whoosh" },
  { file: "sfx-transition.mp3", url: "https://assets.mixkit.co/active_storage/sfx/166/166-preview.mp3", title: "Transition 166", category: "transition" },
  { file: "sfx-impact.mp3", url: "https://assets.mixkit.co/active_storage/sfx/498/498-preview.mp3", title: "Impact 498", category: "impact" },
];

// 派生表：一条母带 + 一个 ffmpeg 滤镜链 → 一支商务变体
// 设计意图：深（更低沉）/ 软（更轻更闷）/ 短（更利落），全部落在“气流扫过”的听感里，
// 不含叮咚、金币、点击这类游戏提示音——那类音效会毁掉商务片质感。
const DERIVED = [
  { file: "sfx-whoosh-deep.mp3", from: "sfx-whoosh.mp3", filter: "lowpass=f=700,volume=1.02", note: "whoosh 压低频，做章节切的厚重感" },
  { file: "sfx-whoosh-soft.mp3", from: "sfx-whoosh.mp3", filter: "lowpass=f=2400,volume=0.62", note: "whoosh 收薄，轻扫过" },
  { file: "sfx-whoosh-short.mp3", from: "sfx-whoosh.mp3", filter: "atrim=0:1.15,asetpts=PTS-STARTPTS,afade=t=out:st=0.95:d=0.2,volume=0.9", note: "whoosh 截短，卡点用" },
  { file: "sfx-transition-deep.mp3", from: "sfx-transition.mp3", filter: "lowpass=f=520,volume=1.02", note: "transition 低沉版" },
  { file: "sfx-transition-soft.mp3", from: "sfx-transition.mp3", filter: "lowpass=f=2600,volume=0.7", note: "transition 轻软版，卡片入场用" },
  { file: "sfx-impact-low.mp3", from: "sfx-impact.mp3", filter: "lowpass=f=380,asetrate=48000*0.85,aresample=48000,volume=1.0", note: "impact 下沉版，收尾用" },
  { file: "sfx-riser.mp3", from: "sfx-whoosh.mp3", filter: "areverse,lowpass=f=2000,volume=0.95", note: "反向 whoosh，做上扬铺垫（可选）" },
];

async function download(url, dest) {
  const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

async function run(args) {
  await execFileP(ffmpegBin(), ["-y", "-hide_banner", "-loglevel", "error", ...args]);
}

async function duration(file) {
  try {
    const { stdout } = await execFileP(ffmpegBin().replace(/ffmpeg\.exe$|ffmpeg$/i, (m) => m.replace("ffmpeg", "ffprobe")), [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
    ]);
    return Number(stdout.trim()).toFixed(1);
  } catch {
    return "?";
  }
}

// 量峰值（dBFS）：音量表就是按这个值反算出来的
async function peakDb(file) {
  try {
    const { stderr } = await execFileP(ffmpegBin(), ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
    const m = /max_volume:\s*([-\d.]+)\s*dB/.exec(stderr || "");
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

const credits = [
  "# 音频素材授权清单",
  "",
  "来源：Mixkit Stock（https://mixkit.co），Mixkit Stock Music Free License / Sound Effects Free License，可商用、免署名。",
  "本目录的 MP3 由 `node server/setup-audio.mjs` 下载/派生，不入版本库；换机器执行同一条命令即可复现。",
  "",
  "## BGM",
  "",
];

let ok = 0;
let fail = 0;

if (!SFX_ONLY) {
  for (const t of BGM) {
    const dest = path.join(BGM_DIR, t.file);
    if (!FORCE && fs.existsSync(dest)) {
      console.log(`skip BGM ${t.file}`);
      credits.push(`- ${t.title} — ${t.artist}（${t.tag}）｜${t.file}｜${await duration(dest)}s｜${t.url}`);
      continue;
    }
    try {
      await download(t.url, dest);
      const d = await duration(dest);
      credits.push(`- ${t.title} — ${t.artist}（${t.tag}）｜${t.file}｜${d}s｜${t.url}`);
      console.log(`BGM OK ${t.file}`);
      ok++;
    } catch (e) {
      console.log(`BGM FAIL ${t.file} ${e.message}`);
      fail++;
    }
  }
}

credits.push("", "## 音效母带", "");
for (const s of SOURCES) {
  const dest = path.join(SFX_DIR, s.file);
  if (!FORCE && fs.existsSync(dest)) {
    console.log(`skip SFX ${s.file}`);
    credits.push(`- ${s.title}（${s.category}）｜${s.file}｜${await duration(dest)}s｜${s.url}`);
    continue;
  }
  try {
    await download(s.url, dest);
    const d = await duration(dest);
    credits.push(`- ${s.title}（${s.category}）｜${s.file}｜${d}s｜${s.url}`);
    console.log(`SFX OK ${s.file}`);
    ok++;
  } catch (e) {
    console.log(`SFX FAIL ${s.file} ${e.message}`);
    fail++;
  }
}

credits.push("", "## 派生变体（本机 ffmpeg 处理，无新增第三方素材）", "");
for (const d of DERIVED) {
  const src = path.join(SFX_DIR, d.from);
  const dest = path.join(SFX_DIR, d.file);
  if (!fs.existsSync(src)) { console.log(`SKIP ${d.file} 缺母带 ${d.from}`); continue; }
  if (!FORCE && fs.existsSync(dest)) {
    console.log(`skip ${d.file}`);
    credits.push(`- ${d.file} ← ${d.from}｜${d.note}｜\`${d.filter}\``);
    continue;
  }
  try {
    await run(["-i", src, "-af", d.filter, "-c:a", "libmp3lame", "-q:a", "2", dest]);
    credits.push(`- ${d.file} ← ${d.from}｜${d.note}｜\`${d.filter}\``);
    console.log(`DERIVE OK ${d.file}`);
    ok++;
  } catch (e) {
    console.log(`DERIVE FAIL ${d.file} ${e.message}`);
    fail++;
  }
}

fs.writeFileSync(path.join(AUDIO_DIR, "CREDITS.md"), credits.join("\n") + "\n", "utf8");

// 打印每支音效的峰值与建议增益（target ≈ 0.45 线性，约 -6.9dB 相对满刻度）
console.log("\n音效峰值与建议 volume（渲染器按此标定，改动后同步改 render.js 的 SFX_VOLUME）:");
console.log("file\tpeak_dB\tsuggest_vol");
for (const f of fs.readdirSync(SFX_DIR).filter((n) => n.endsWith(".mp3")).sort()) {
  const p = await peakDb(path.join(SFX_DIR, f));
  const vol = p === null ? "?" : (0.45 / Math.pow(10, p / 20)).toFixed(2);
  console.log(`${f}\t${p === null ? "?" : p.toFixed(1)}\t${vol}`);
}

console.log(`\n完成：成功 ${ok} 项，失败 ${fail} 项。BGM 在 assets/audio/bgm/，音效在 assets/audio/sfx/。`);
