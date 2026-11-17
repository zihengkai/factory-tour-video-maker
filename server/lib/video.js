// 开场镜头（异步视频模型）：大门照（首帧）+ 记者形象文字提示词，不上传人物三视图
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { projectPaths, resolveProjectFile } from "./store.js";

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  return { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".bmp": "image/bmp" }[ext] || "image/jpeg";
}

function gateDataUrl(project) {
  if (!project.company.gateImage) return null;
  const abs = resolveProjectFile(project.id, project.company.gateImage);
  if (!fs.existsSync(abs)) return null;
  const b64 = fs.readFileSync(abs).toString("base64");
  return `data:${mimeOf(abs)};base64,${b64}`;
}

export function buildOpeningPrompt(project) {
  const opener = project.script.sentences[0]?.en || "";
  const company = project.company.nameEn || project.company.nameZh || "the factory";
  const lines = [
    "Cinematic corporate B2B factory tour opening shot, 16:9, 720p, gimbal-stabilized, natural daylight, professional high-end photography.",
    `The reference image is the factory gate / exterior and serves as the first frame.`,
    `${CONFIG.reporter.en}`,
    `The reporter is already standing at the factory gate facing the camera from the very first frame. She raises the interview microphone to her mouth and begins speaking to camera immediately, with lip movement synchronized to the opening English line; she does not walk in or wait before talking. Warm welcoming expression, natural presenting hand gestures, occasionally glancing back toward the factory behind her. Slow gentle push-in, medium-wide shot, ending with a smile and a small nod.`,
    `Company: ${company}. The exact opening line she speaks from the start: "${opener}".`,
    "Single continuous feel, no fast cuts, no flashy transitions, no on-screen subtitles, no watermark, no logo overlay.",
  ];
  return lines.join("\n");
}

export async function createOpeningTask(project) {
  const dataUrl = gateDataUrl(project);
  const prompt = buildOpeningPrompt(project);
  project.opening.prompt = prompt;

  const content = [{ type: "text", text: prompt }];
  if (dataUrl) {
    content.push({ type: "image_url", image_url: { url: dataUrl }, role: "first_frame" });
  }

  const body = {
    model: CONFIG.video.model,
    content,
    ratio: CONFIG.video.ratio,
    resolution: CONFIG.video.resolution,
    duration: CONFIG.video.duration,
    watermark: CONFIG.video.watermark,
    generate_audio: CONFIG.video.generateAudio,
  };

  const r = await fetch(`${CONFIG.video.base}/contents/generations/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONFIG.video.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(`视频模型 HTTP ${r.status}: ${text.slice(0, 300)}`);
  if (!j.id) throw new Error(`视频模型未返回任务 ID: ${text.slice(0, 300)}`);

  project.opening.status = "running";
  project.opening.taskId = j.id;
  project.opening.error = "";
  return project;
}

export async function pollOpeningTask(project) {
  if (!project.opening.taskId) throw new Error("无开场任务");
  const r = await fetch(`${CONFIG.video.base}/contents/generations/tasks/${project.opening.taskId}`, {
    headers: { Authorization: `Bearer ${CONFIG.video.key}` },
  });
  const j = await r.json();
  const status = j.status;
  if (status === "succeeded") {
    const videoUrl = j.content?.video_url || j.content?.[0]?.video_url;
    if (!videoUrl) throw new Error("任务成功但未返回视频地址");
    const local = await downloadVideo(project, videoUrl);
    project.opening.status = "done";
    project.opening.videoFile = local;
    project.opening.error = "";
  } else if (status === "failed" || status === "expired" || status === "cancelled") {
    project.opening.status = "failed";
    project.opening.error = j.error?.message || `任务状态 ${status}`;
  } else {
    project.opening.status = "running";
  }
  return project;
}

async function downloadVideo(project, url) {
  const paths = projectPaths(project.id);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`视频下载 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const rel = "ai/opening.mp4";
  fs.writeFileSync(resolveProjectFile(project.id, rel), buf);
  return rel;
}
