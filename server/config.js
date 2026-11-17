// 配置：所有密钥与模型 ID 一律走环境变量，代码里不留任何真实 key、私有网关或模型名。
//
// 必需环境变量（缺任意一个，对应环节会失败并在工作台里提示）：
//   LLM_BASE / LLM_API_KEY / LLM_MODEL          文字模型（OpenAI 兼容 /chat/completions）
//   IMAGE_BASE / IMAGE_API_KEY / IMAGE_MODEL    图片模型（OpenAI 兼容 /images/edits、/images/generations）
//   VIDEO_BASE / VIDEO_API_KEY / VIDEO_MODEL    视频模型（异步任务式：创建任务 + 轮询任务详情）
//   TTS_ENDPOINT / TTS_API_KEY / TTS_MODEL      语音合成（返回 base64 音频 + 时长）
//
// 可选：PORT（默认 8731）、PROJECTS_ROOT（默认 <工程根>/projects）、FFMPEG_DIR / FFMPEG_PATH。
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");

const env = (name) => String(process.env[name] || "").trim();

export const CONFIG = {
  server: {
    host: "127.0.0.1",
    port: Number(env("PORT") || 8731),
  },
  // 项目工程目录（素材、音频、AI 生成件、成片都落盘在这里）
  projectsRoot: env("PROJECTS_ROOT") || path.join(ROOT_DIR, "projects"),
  assetsRoot: path.join(ROOT_DIR, "assets", "audio"),

  // 文字模型（OpenAI 兼容协议）
  llm: {
    base: env("LLM_BASE"),
    key: env("LLM_API_KEY"),
    model: env("LLM_MODEL"),
  },

  // 图片模型（封面，1:1 方形）
  image: {
    base: env("IMAGE_BASE"),
    key: env("IMAGE_API_KEY"),
    model: env("IMAGE_MODEL"),
    size: "1024x1024",
  },

  // 视频模型（开场镜头，异步任务 + 轮询）
  video: {
    base: env("VIDEO_BASE"),
    key: env("VIDEO_API_KEY"),
    model: env("VIDEO_MODEL"),
    ratio: "16:9",
    resolution: "720p",
    duration: 6,
    watermark: false,
    generateAudio: false,
  },

  // 语音合成
  tts: {
    endpoint: env("TTS_ENDPOINT"),
    apiKey: env("TTS_API_KEY"),
    model: env("TTS_MODEL"),
    speaker: env("TTS_SPEAKER"),
    format: "mp3",
    sampleRate: 48000,
    speechRate: 0,
  },

  // 成片规格：可选 16:9（1280×720）与 1:1（1280×1280，16:9 画面居中夹在标题与字幕之间）
  output: {
    width: 1280,
    height: 720,
    fps: 30,
    brand: "#F58220",
    formats: {
      "16:9": { width: 1280, height: 720 },
      "1:1": { width: 1280, height: 1280 },
    },
  },

  // 栏目品牌（会出现在成片标题、封面徽章与提示词里；用环境变量换成自己的栏目名）
  branding: {
    // 顶部小标 / 封面徽章（大写）
    program: env("TOUR_PROGRAM") || "FACTORY TOUR",
    // 副标中文
    programZh: env("TOUR_PROGRAM_ZH") || "走进中国好工厂",
    // 封面上的中文标语
    coverZh: env("TOUR_COVER_ZH") || "探厂官 · 带你走进中国好工厂",
    // 文案提示词里的栏目名
    column: env("TOUR_COLUMN") || "探厂短视频栏目",
  },

  // 固定记者形象（开场视频与封面共用；不上传人物三视图）
  reporter: {
    zh: "职业记者形象到位：樱花粉收腰西装+米白飘带衬衫+浅杏内搭+玫红腰带+及膝A字裙+浅杏尖头高跟鞋；职业道具齐全：手持米白防风罩采访话筒、淡紫挂绳记者证、珍珠耳钉、西装口袋巾；发型为浅粉渐变低盘发+珍珠发夹，妆容清透上镜，五色穿搭体系统一保留。",
    en: "A professional female business reporter: tailored blazer, ribbon blouse, knee-length A-line skirt, pointed-toe heels; holding a windscreen interview microphone, lanyard press pass, pearl stud earrings, pocket square; soft gradient low bun with a pearl hair clip, fresh clear on-camera makeup; the outfit system stays coherent throughout.",
  },
};

// 启动自检：把没配的必需项列出来，避免第一次跑就只看到 401/500
export function configWarnings() {
  const need = [
    ["LLM_BASE", CONFIG.llm.base], ["LLM_API_KEY", CONFIG.llm.key], ["LLM_MODEL", CONFIG.llm.model],
    ["IMAGE_BASE", CONFIG.image.base], ["IMAGE_API_KEY", CONFIG.image.key], ["IMAGE_MODEL", CONFIG.image.model],
    ["VIDEO_BASE", CONFIG.video.base], ["VIDEO_API_KEY", CONFIG.video.key], ["VIDEO_MODEL", CONFIG.video.model],
    ["TTS_ENDPOINT", CONFIG.tts.endpoint], ["TTS_API_KEY", CONFIG.tts.apiKey], ["TTS_MODEL", CONFIG.tts.model],
  ];
  const missing = need.filter(([, v]) => !v).map(([k]) => k);
  const groups = {
    "文案": ["LLM_BASE", "LLM_API_KEY", "LLM_MODEL"],
    "封面": ["IMAGE_BASE", "IMAGE_API_KEY", "IMAGE_MODEL"],
    "开场镜头": ["VIDEO_BASE", "VIDEO_API_KEY", "VIDEO_MODEL"],
    "配音": ["TTS_ENDPOINT", "TTS_API_KEY", "TTS_MODEL"],
  };
  return Object.entries(groups)
    .filter(([, keys]) => keys.some((k) => missing.includes(k)))
    .map(([name, keys]) => `${name}（缺 ${keys.filter((k) => missing.includes(k)).join(" / ")}）`);
}
