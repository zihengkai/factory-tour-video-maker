// 文字模型调用：卖点提炼 + 探厂文案生成（OpenAI 兼容协议）
import { CONFIG } from "../config.js";

async function chat(messages, { json = false, temperature = 0.4 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 180000);
  try {
    const r = await fetch(`${CONFIG.llm.base}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${CONFIG.llm.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CONFIG.llm.model,
        messages,
        temperature,
        max_tokens: 1600,
        enable_thinking: false,
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`LLM HTTP ${r.status}: ${body.slice(0, 300)}`);
    }
    const j = await r.json();
    const content = j.choices?.[0]?.message?.content || "";
    if (!json) return content;
    return parseJson(content);
  } finally {
    clearTimeout(t);
  }
}

function parseJson(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  // 截断到最后一个配对括号
  const last = Math.max(s.lastIndexOf("]"), s.lastIndexOf("}"));
  if (last > 0) s = s.slice(0, last + 1);
  return JSON.parse(s);
}

// 基于企业填写资料，一次调用完成要点提炼 + 探厂撰稿（不抓取网页）
export async function generateScriptDirect(company, site, extraInstruction = "") {
  const user = {
    company: {
      nameZh: company.nameZh,
      nameEn: company.nameEn,
      brand: company.brand,
      website: company.website,
      intro: company.intro,
    },
    extraInstruction,
  };
  const j = await chat(
    [
      {
        role: "system",
        content:
          `你是海外 B2B 探厂短视频编导兼调研分析师，为「${CONFIG.branding.column}」一次性完成「要点提炼 + 口播撰稿」。规则：\n` +
          "1. 事实只能来自企业填写的资料；数字、年份、面积、产能、认证照录原文，输入中没有的不编造。\n" +
          "2. 先在 points 输出 3 条最核心的竞争力要点（供封面与开场镜头复用），再写口播稿；每条只给一句中文概述，不要重复展开。\n" +
          "3. 英文口播 120–150 词，7–9 句，约 60 秒，每句 12–20 词；结构：开场问候定位 → 历史与定位 → 规模/智能制造/产能 → 产品矩阵 → 研发/标准/荣誉 → 认证与品控 → 合作邀约 CTA。\n" +
          "4. 语气专业、沉稳、商务，不夸张、不搞笑。\n" +
          "5. keywords 为每句强调卡的 1–2 个英文短语或数字，必须在该句英文中出现。\n" +
          "6. scene 取值：gate / overview / workshop / production_line / lab / products / certification / team / outro。\n" +
          '输出严格 JSON：{"summary":"一句英文定位","points":[{"category":"products|history|scale|capacity|rnd|certification|market|honor","label":"英文短标签","value":"英文事实描述","zh":"中文一句概述"}],"title":{"en":"走进 Brand","zh":"中文标题"},"sentences":[{"en":"英文口播句","zh":"中文译文","scene":"...","keywords":["..."]}]}',
      },
      { role: "user", content: JSON.stringify(user) },
    ],
    { json: true, temperature: 0.5 }
  );
  const points = Array.isArray(j.points)
    ? j.points.map((pt) => ({
        category: pt.category || "",
        label: pt.label || "",
        value: pt.value || "",
        zhLabel: pt.zhLabel || pt.zh || "",
        zhValue: pt.zhValue || pt.zh || "",
      }))
    : [];
  return {
    summary: j.summary || "",
    points,
    title: j.title || { en: "", zh: "" },
    sentences: Array.isArray(j.sentences) ? j.sentences : [],
  };
}

export async function refineScript(company, sellingPoints, currentScript, instruction) {
  const j = await chat(
    [
      {
        role: "system",
        content:
          "根据用户修改意见调整现有探厂脚本，保持 JSON 结构不变；除意见涉及的内容外尽量保留原句；英文总词数仍控制在 140–160 词。\n" +
          '输出严格 JSON：{"title":{"en":"","zh":""},"sentences":[{"en":"","zh":"","scene":"","keywords":[]}]}',
      },
      {
        role: "user",
        content: JSON.stringify({ company, sellingPoints, currentScript, instruction }),
      },
    ],
    { json: true, temperature: 0.5 }
  );
  return { title: j.title || { en: "", zh: "" }, sentences: Array.isArray(j.sentences) ? j.sentences : [] };
}
