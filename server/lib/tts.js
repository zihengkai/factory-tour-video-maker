// 英文配音：整段探厂文案一次性合成一条口播音轨
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { projectPaths } from "./store.js";
import { ffprobeDuration } from "./media.js";

async function synth(text) {
  const r = await fetch(CONFIG.tts.endpoint, {
    method: "POST",
    headers: { "X-Api-Key": CONFIG.tts.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CONFIG.tts.model,
      text_prompt: text,
      references: [{ speaker: CONFIG.tts.speaker }],
      audio_config: {
        format: CONFIG.tts.format,
        sample_rate: CONFIG.tts.sampleRate,
        speech_rate: CONFIG.tts.speechRate,
        loudness_rate: 0,
      },
      enable_subtitle: false,
    }),
  });
  if (!r.ok) throw new Error(`TTS HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (j.code && j.code !== 0) throw new Error(`TTS ${j.code}: ${j.message}`);
  if (!j.audio) throw new Error("TTS 未返回音频数据");
  return { buffer: Buffer.from(j.audio, "base64"), duration: j.duration || 0 };
}

export async function synthesizeProject(project) {
  const paths = projectPaths(project.id);
  fs.mkdirSync(paths.audio, { recursive: true });

  // 整段探厂文案一次性合成一条口播音轨
  const fullText = project.script.sentences.map((s) => s.en).join(" ");
  const { buffer, duration } = await synth(fullText);

  const voiceFile = path.join(paths.audio, "voice.mp3");
  fs.writeFileSync(voiceFile, buffer);
  const totalDur = duration || (await ffprobeDuration(voiceFile));

  // 无分句音频，按各句英文词数占整段比例分摊时段，供字幕与场景切换对齐
  const words = project.script.sentences.map((s) => (s.en.match(/\b[\w']+\b/g) || []).length || 1);
  const totalWords = words.reduce((a, b) => a + b, 0);
  let cursor = 0;
  project.script.sentences.forEach((s, i) => {
    const dur = totalDur * (words[i] / totalWords);
    s.start = +cursor.toFixed(3);
    s.end = +(cursor + dur).toFixed(3);
    s.audioFile = "";
    cursor += dur;
  });
  if (project.script.sentences.length) {
    project.script.sentences[project.script.sentences.length - 1].end = +totalDur.toFixed(3);
  }

  project.voice.audioFile = "audio/voice.mp3";
  project.voice.ready = true;
  return project;
}
