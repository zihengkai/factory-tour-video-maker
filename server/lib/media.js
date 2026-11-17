// 本机 ffmpeg / ffprobe 封装
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileP = promisify(execFile);

// 本机 PATH 偶尔缺少 ffmpeg 目录，这里按优先级自动定位可执行文件，不依赖 PATH
function resolveBin(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [
    process.env[`${name.toUpperCase()}_PATH`],
    process.env.FFMPEG_DIR ? path.join(process.env.FFMPEG_DIR, exe) : "",
    path.join("C:\\ProgramData\\chocolatey", "bin", exe),
    path.join("C:\\Program Files", "ffmpeg", "bin", exe),
    path.join("C:\\ffmpeg", "bin", exe),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", exe),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* 跳过不可访问路径 */ }
  }
  return name; // 回退到 PATH 查找
}

const FFMPEG = resolveBin("ffmpeg");
const FFPROBE = resolveBin("ffprobe");

export function ffmpegBin() { return FFMPEG; }
export function ffprobeBin() { return FFPROBE; }

export async function ffprobeDuration(file) {
  try {
    const { stdout } = await execFileP(FFPROBE, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      file,
    ]);
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

export async function runFfmpeg(args, { timeout = 300000, cwd } = {}) {
  await execFileP(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...args], { timeout, cwd });
}

export async function concatAudio(inputs, outFile) {
  const list = inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
  const listFile = outFile + ".list.txt";
  fs.writeFileSync(listFile, list, "utf8");
  await runFfmpeg([
    "-f", "concat", "-safe", "0",
    "-i", listFile,
    "-c:a", "libmp3lame", "-ar", "48000", "-b:a", "192k",
    outFile,
  ]);
  fs.rmSync(listFile, { force: true });
}
