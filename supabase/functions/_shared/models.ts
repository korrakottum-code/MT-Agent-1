// โมเดลกลางของทั้งระบบ — ทุกฟังก์ชันที่ต้องคุยกับโมเดลเรียกผ่านไฟล์นี้ไฟล์เดียว
// เพื่อให้การย้ายค่ายทำครั้งเดียวแล้วมีผลกับทุกงาน ไม่ใช่ตามแก้ทีละที่แล้วลืมบางที่
//
// โมเดลนอกค่าย Anthropic คุยผ่านหน้าตาแบบ OpenAI chat completions ซึ่งเป็นภาษากลาง
// ที่ทั้ง OpenAI และ Gemini (endpoint โหมด openai) รับได้
// ส่วนที่แปลไป-กลับเป็นส่วนที่พังเงียบที่สุด — แปลผิดนิดเดียวโมเดลจะเรียก tool ไม่ได้เลย
// มีข้อสอบของตัวเองที่ models.test.ts รันด้วย: deno test --allow-env supabase/functions/_shared/
import Anthropic from "npm:@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-sonnet-5";

// identity-linked API key ต้องแนบ anthropic-workspace-id ทุก request
// ตั้งค่าเป็น "none" ได้ ถ้า key ไม่ใช่แบบผูก workspace — การส่ง header ผิด workspace
// ทำให้ API ไปคิดเงินจาก workspace ที่ไม่มียอด แล้วตอบว่าเครดิตไม่พอ ทั้งที่บัญชีมีเงิน
const RAW_WORKSPACE_ID = Deno.env.get("ANTHROPIC_WORKSPACE_ID") ?? "";
const WORKSPACE_ID = RAW_WORKSPACE_ID.trim().toLowerCase() === "none" ? "" : RAW_WORKSPACE_ID.trim();
const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
  ...(WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": WORKSPACE_ID } } : {}),
});

// โมเดลที่เลือกได้ ไม่รับค่าอิสระ กันพิมพ์ผิดแล้วไปเรียกโมเดลที่ไม่มีจริง
// โมเดลนอกค่าย Anthropic คุยผ่านหน้าตาแบบ OpenAI chat completions ซึ่งเป็นภาษากลาง
// ที่ทั้ง OpenAI และ Gemini (endpoint โหมด openai) รับได้ ตัวแปลอยู่ที่ toOpenAIMessages
//
// ชื่อรุ่นจริงไม่ฝังในโค้ด ต้องตั้งเป็น secret เพราะชื่อรุ่นเปลี่ยนบ่อยกว่าโค้ด
// และเดาผิดทีเดียวคือรันข้อสอบทั้งชุดทิ้ง — ขาดตัวไหน endpoint บอกตรง ๆ ว่าต้องตั้งอะไร

export type ModelSpec = {
  provider: "anthropic" | "openai" | "gemini";
  model: string;
  baseURL?: string;
  keyEnv: string;
};

export const MODELS: Record<string, () => ModelSpec> = {
  haiku: () => ({ provider: "anthropic", model: "claude-haiku-4-5-20251001", keyEnv: "ANTHROPIC_API_KEY" }),
  sonnet: () => ({ provider: "anthropic", model: "claude-sonnet-5", keyEnv: "ANTHROPIC_API_KEY" }),
  luna: () => ({
    provider: "openai",
    model: Deno.env.get("EVAL_LUNA_MODEL") ?? "",
    baseURL: Deno.env.get("EVAL_LUNA_BASE_URL") ?? "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
  }),
  "gemini-flash": () => ({
    // คุยกับ Gemini ด้วย API ตัวเต็มของมัน ไม่ใช่โหมดเข้ากันได้กับ OpenAI
    // เพราะโหมดนั้นตั้ง safetySettings ไม่ได้ แล้ว Gemini บล็อกคำขอธรรมดาของบอทนี้ทิ้งเป็นประจำ
    // ตัวเต็มยังแนบ PDF ได้ด้วย ซึ่งโหมดเข้ากันได้ทำไม่ได้
    provider: "gemini",
    model: Deno.env.get("EVAL_GEMINI_MODEL") ?? "",
    baseURL: Deno.env.get("EVAL_GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta",
    keyEnv: "GEMINI_API_KEY",
  }),
};

// บอกให้ชัดว่าขาดอะไร แทนที่จะปล่อยให้ยิงไปแล้วได้ 401 กลับมาแบบงง ๆ
export function resolveModel(key: string): { spec?: ModelSpec; error?: string } {
  const make = MODELS[key];
  if (!make) {
    return { error: `ไม่รู้จักโมเดล "${key}" (ใช้ได้: ${Object.keys(MODELS).join(", ")})` };
  }
  const spec = make();
  if (!spec.model) {
    const envName = key === "luna" ? "EVAL_LUNA_MODEL" : "EVAL_GEMINI_MODEL";
    return { error: `โมเดล "${key}" ยังไม่ได้เชื่อม — ตั้ง secret ${envName} เป็นชื่อรุ่นจริงก่อน` };
  }
  if (!Deno.env.get(spec.keyEnv)) {
    return { error: `โมเดล "${key}" ยังไม่ได้เชื่อม — ตั้ง secret ${spec.keyEnv} ก่อน` };
  }
  return { spec };
}

// แปลงคำขอหน้าตาแบบ Anthropic เป็น OpenAI chat completions
// cache_control หายไปตรงนี้โดยตั้งใจ ฝั่ง OpenAI ไม่มีของแบบนั้นให้สั่ง
export function toOpenAIMessages(system: any[], messages: any[]): any[] {
  const out: any[] = [{ role: "system", content: system.map((b: any) => b.text).join("\n\n") }];

  for (const m of messages) {
    if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
      const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      // ส่งคืนก้อนเดิมที่เขาให้มาทั้งก้อนถ้ามี ไม่ใช่ประกอบขึ้นใหม่จากชื่อกับ arguments
      // Gemini 3 แนบ thought_signature มากับ tool call แล้วบังคับให้ส่งกลับไปด้วย
      // ถ้าประกอบใหม่ ฟิลด์นั้นหายและมันตอบ 400 ตั้งแต่รอบที่สองของทุกคำตอบที่ใช้ tool
      // การคืนของเดิมทั้งก้อนกันปัญหาคลาสนี้ทั้งหมด ไม่ต้องรู้ว่าแต่ละเจ้าแนบอะไรมาบ้าง
      const calls = blocks.filter((b: any) => b.type === "tool_use").map((b: any) =>
        b._raw ?? {
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }
      );
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    if (typeof m.content === "string") {
      out.push({ role: "user", content: m.content });
      continue;
    }

    // ผลลัพธ์ tool เป็น message คนละก้อนในฝั่ง OpenAI ก้อนละ 1 การเรียก
    const results = (m.content as any[]).filter((b: any) => b.type === "tool_result");
    if (results.length) {
      for (const r of results) {
        out.push({ role: "tool", tool_call_id: r.tool_use_id, content: String(r.content) });
      }
      continue;
    }

    const parts: any[] = [];
    for (const b of m.content as any[]) {
      if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image") {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
        });
      } else if (b.type === "document") {
        // PDF แนบตรงได้เฉพาะฝั่ง Anthropic — เงียบ ๆ ทิ้งไฟล์ไปแล้วตอบมั่วอันตรายกว่าพังตรงนี้
        throw new Error("โมเดลนี้รับไฟล์ PDF แนบตรงไม่ได้ ใช้ข้อสอบชุดที่ไม่มีไฟล์แทน");
      }
    }
    out.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
  }
  return out;
}

// แปลงคำตอบ OpenAI กลับเป็นหน้าตาแบบ Anthropic เพื่อให้ลูป tool ข้างล่างไม่ต้องรู้ว่าคุยกับใครอยู่
export function fromOpenAIResponse(data: any): any {
  const choice = data.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content: any[] = [];
  if (msg.content) content.push({ type: "text", text: String(msg.content) });
  for (const call of msg.tool_calls ?? []) {
    let input: any = {};
    // โมเดลส่ง arguments มาเป็นสตริง JSON บางทีก็พัง ให้ tool ตอบ error กลับไปดีกว่าทั้งเทิร์นล่ม
    try { input = JSON.parse(call.function?.arguments || "{}"); } catch { input = {}; }
    // _raw คือก้อนดิบของเจ้านั้น เก็บไว้ส่งคืนตอนต่อบทสนทนา ส่วนที่เหลือของระบบไม่ต้องรู้จักมัน
    content.push({ type: "tool_use", id: call.id, name: call.function?.name, input, _raw: call });
  }
  const stop = msg.refusal || choice.finish_reason === "content_filter"
    ? "refusal"
    : (msg.tool_calls?.length ? "tool_use" : "end_turn");
  const u = data.usage ?? {};
  // สองค่ายนับคนละแบบ: prompt_tokens ของ OpenAI รวม token ที่อ่านจาก cache มาแล้ว
  // ส่วน input_tokens ของ Anthropic แยกออกจากกัน ต้องลบออกให้เหลือความหมายเดียวกัน
  // ไม่งั้นต้นทุนของโมเดลค่ายอื่นจะถูกนับซ้ำส่วนที่ cache แล้วรายงานว่าแพงเกินจริง
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    content,
    stop_reason: stop,
    usage: {
      input_tokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
      output_tokens: u.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  };
}

// พารามิเตอร์ที่บางเจ้าต้องปรับก่อนถึงจะยอมทำงาน รู้ได้จาก error ที่มันตอบกลับมาเท่านั้น
// จึงลองแบบมาตรฐานก่อน แล้วปรับตามที่มันบอก ดีกว่าฮาร์ดโค้ดข้อยกเว้นรายเจ้าไว้ล่วงหน้า
// ซึ่งจะผิดทันทีที่เขาเปลี่ยนรุ่น
type Fix = "max_tokens" | "no_reasoning";

// Gemini บล็อกคำขอทิ้งเองด้วย safety filter ก่อนจะได้ตอบอะไร คำสั่งพื้นฐานอย่าง
// "ตอนนี้ฉันมีงานอะไรค้าง" ก็โดน เพราะ prompt แนบรายชื่อพนักงานจริงกับ id ไปทุกครั้ง
// ตรงนี้สั่งลดระดับเฉพาะหมวดที่ผู้ใช้ตั้งเองได้ ถ้าเจ้าไหนไม่รู้จักฟิลด์นี้ ระบบจะถอดออกให้เอง
const SAFETY_OFF = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
].map((category) => ({ category, threshold: "BLOCK_NONE" }));

function applyFix(body: any, fix: Fix): any {
  if (fix === "max_tokens") {
    const { max_completion_tokens, ...rest } = body;
    return { ...rest, max_tokens: max_completion_tokens };
  }
  // gpt-5.x ไม่ยอมให้ใช้ tool บน /v1/chat/completions ถ้า reasoning_effort ไม่ใช่ none
  return { ...body, reasoning_effort: "none" };
}

function detectFix(detail: string, applied: Fix[]): Fix | null {
  if (detail.includes("max_completion_tokens") && !applied.includes("max_tokens")) return "max_tokens";
  if (detail.includes("reasoning_effort") && !applied.includes("no_reasoning")) return "no_reasoning";
  return null;
}

// จำไว้ว่ารุ่นนี้ต้องปรับอะไรบ้าง คำตอบเดียวยิงเข้าโมเดลได้ถึง 8 รอบ
// ถ้าไม่จำ ทุกรอบจะต้องเสีย 400 หนึ่งครั้งเพื่อเรียนรู้เรื่องเดิมซ้ำ ๆ
const learnedFixes = new Map<string, Fix[]>();

// สำหรับข้อสอบเท่านั้น ให้แต่ละเคสเริ่มจากศูนย์เหมือนโมเดลที่เพิ่งเจอครั้งแรก
export function _resetLearnedFixes() {
  learnedFixes.clear();
}

export async function callOpenAICompatible(spec: ModelSpec, req: any): Promise<any> {
  const base: any = {
    model: spec.model,
    max_completion_tokens: req.max_tokens,
    messages: toOpenAIMessages(req.system, req.messages),
  };
  if (req.tools) {
    base.tools = req.tools.map((t: any) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  // งานที่บังคับให้ตอบผ่าน tool ตัวเดียว (เช่น การดึงงาน/มติออกจากบทสนทนา) ต้องบังคับได้ทั้งสองค่าย
  // ถ้าแปลข้อนี้หายไป โมเดลจะตอบเป็นข้อความเปล่า แล้วงานเบื้องหลังจะได้ผลลัพธ์ว่างทุกครั้งแบบเงียบ ๆ
  if (req.tool_choice) {
    const c = req.tool_choice;
    base.tool_choice = c.type === "tool" && c.name
      ? { type: "function", function: { name: c.name } }
      : c.type === "any"
      ? "required"
      : "auto";
  }

  const send = async (payload: any) =>
    await fetch(`${spec.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get(spec.keyEnv) ?? ""}`,
      },
      body: JSON.stringify(payload),
    });

  const applied = [...(learnedFixes.get(spec.model) ?? [])];
  let payload = applied.reduce(applyFix, base);
  let res = await send(payload);

  // ปรับได้อย่างมาก 2 อย่าง เท่ากับจำนวนอาการที่รู้จัก เกินนั้นคือเรื่องที่เดาเองไม่ได้
  for (let i = 0; i < 2 && res.status === 400; i++) {
    const detail = await res.text();
    const fix = detectFix(detail, applied);
    if (!fix) throw new Error(`${spec.model} ตอบ 400: ${detail.slice(0, 400)}`);
    applied.push(fix);
    learnedFixes.set(spec.model, applied);
    payload = applyFix(payload, fix);
    res = await send(payload);
  }
  if (!res.ok) throw new Error(`${spec.model} ตอบ ${res.status}: ${(await res.text()).slice(0, 400)}`);

  let data = await res.json();
  let out = fromOpenAIResponse(data);

  // ตอบ 200 กลับมาโดยไม่มีทั้งข้อความและคำสั่งเรียก tool = ใช้อะไรไม่ได้เลย
  // เกิดจริงกับรุ่นที่คิดก่อนตอบ: โควตาคำตอบหมดไปกับการคิด จนไม่เหลือให้พูด
  // อาการนี้ห้ามกลืน เพราะผู้ใช้จะเห็นบอทตอบว่า "…" โดยไม่มีใครรู้ว่าเกิดอะไรขึ้น
  if (out.content.length === 0) {
    const reason = data.choices?.[0]?.finish_reason ?? "(ไม่บอก)";
    console.error(
      `${spec.model} ตอบกลับมาแบบว่างเปล่า finish_reason=${reason} ` +
      `completion_tokens=${data.usage?.completion_tokens ?? 0} — ลองใหม่แบบปิดการคิดและเพิ่มโควตาคำตอบ`,
    );
    // โดนบล็อกด้วย filter ต้องรู้ให้ได้ว่าหมวดไหน ไม่งั้นไล่ต่อไม่ถูกว่าปรับได้หรือปรับไม่ได้
    if (String(reason).includes("content_filter")) {
      console.error(`${spec.model} รายละเอียดการบล็อก: ${JSON.stringify(data).slice(0, 1500)}`);
    }
    if (!applied.includes("no_reasoning")) {
      applied.push("no_reasoning");
      learnedFixes.set(spec.model, applied);
    }
    payload = { ...applyFix(payload, "no_reasoning") };
    // เผื่อโควตาไว้มากขึ้นด้วย เพราะถ้าสาเหตุคือคิดจนหมดโควตา การปิดคิดอย่างเดียวอาจยังไม่พอ
    if (payload.max_completion_tokens) payload.max_completion_tokens = Math.max(payload.max_completion_tokens, 8192);
    if (payload.max_tokens) payload.max_tokens = Math.max(payload.max_tokens, 8192);
    const retry = await send(payload);
    if (!retry.ok) {
      throw new Error(`${spec.model} ตอบว่างเปล่า (finish_reason=${reason}) แล้วลองใหม่ได้ ${retry.status}`);
    }
    data = await retry.json();
    out = fromOpenAIResponse(data);
    if (out.content.length === 0) {
      throw new Error(
        `${spec.model} ตอบว่างเปล่าสองครั้งติด finish_reason=${data.choices?.[0]?.finish_reason ?? "(ไม่บอก)"} — ` +
        `ยังใช้โมเดลนี้ตอบไม่ได้`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- Gemini ตัวเต็ม

// Gemini ไม่รับ JSON Schema บางคำ ถ้าส่งไปจะปฏิเสธทั้งชุด tool
// ตัดเฉพาะคำที่มันไม่รู้จักทิ้ง ไม่แตะโครงสร้างที่เหลือ
function cleanSchema(node: any): any {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== "object") return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "additionalProperties" || k === "$schema") continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

// แปลงคำขอหน้าตาแบบ Anthropic เป็นรูปแบบ contents ของ Gemini
// ผลลัพธ์ tool ของฝั่ง Anthropic อ้างด้วย id ส่วน Gemini อ้างด้วยชื่อ tool
// จึงต้องจำ id → ชื่อ จากข้อความของโมเดลก่อนหน้าไว้ ไม่งั้นส่งผลลัพธ์กลับไม่ได้
export function toGeminiContents(messages: any[]): any[] {
  const nameOfId = new Map<string, string>();
  const contents: any[] = [];

  for (const m of messages) {
    if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
      const parts: any[] = [];
      for (const b of blocks) {
        if (b.type === "text" && b.text) parts.push({ text: b.text });
        if (b.type === "tool_use") {
          nameOfId.set(b.id, b.name);
          parts.push({ functionCall: { name: b.name, args: b.input ?? {} } });
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }

    if (typeof m.content === "string") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
      continue;
    }

    const results = (m.content as any[]).filter((b: any) => b.type === "tool_result");
    if (results.length) {
      contents.push({
        role: "user",
        parts: results.map((r: any) => ({
          functionResponse: {
            name: nameOfId.get(r.tool_use_id) ?? r.tool_use_id,
            // Gemini บังคับให้ response เป็น object เสมอ ผลลัพธ์ของเราเป็นสตริง JSON จึงต้องห่อ
            response: { result: String(r.content) },
          },
        })),
      });
      continue;
    }

    const parts: any[] = [];
    for (const b of m.content as any[]) {
      if (b.type === "text") parts.push({ text: b.text });
      else if (b.type === "image" || b.type === "document") {
        parts.push({ inline_data: { mime_type: b.source.media_type, data: b.source.data } });
      }
    }
    contents.push({ role: "user", parts });
  }
  return contents;
}

// แปลงคำตอบของ Gemini กลับเป็นหน้าตาแบบ Anthropic เพื่อให้ลูป tool ข้างนอกไม่ต้องรู้ว่าคุยกับใคร
export function fromGeminiResponse(data: any): any {
  const cand = data.candidates?.[0] ?? {};
  const content: any[] = [];
  let calls = 0;
  for (const part of cand.content?.parts ?? []) {
    if (part.text) content.push({ type: "text", text: part.text });
    if (part.functionCall) {
      content.push({
        type: "tool_use",
        // Gemini ไม่ให้ id มา ต้องตั้งเองให้ไม่ซ้ำ แล้วใช้จับคู่ผลลัพธ์ตอนส่งกลับ
        id: `gem_${calls++}_${part.functionCall.name}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }
  const finish = String(cand.finishReason ?? "");
  const stop = finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || finish === "BLOCKLIST"
    ? "refusal"
    : content.some((b) => b.type === "tool_use")
    ? "tool_use"
    : "end_turn";
  const u = data.usageMetadata ?? {};
  const cached = u.cachedContentTokenCount ?? 0;
  return {
    content,
    stop_reason: stop,
    finish_reason: finish,
    usage: {
      input_tokens: Math.max(0, (u.promptTokenCount ?? 0) - cached),
      output_tokens: u.candidatesTokenCount ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  };
}

export async function callGemini(spec: ModelSpec, req: any): Promise<any> {
  const body: any = {
    contents: toGeminiContents(req.messages),
    generationConfig: { maxOutputTokens: req.max_tokens },
    // เหตุผลเดียวที่ต้องใช้ API ตัวเต็ม — โหมดเข้ากันได้กับ OpenAI ตั้งค่านี้ไม่ได้
    // บอทนี้แนบรายชื่อพนักงานจริงไปทุกครั้ง ซึ่งไปสะกิด filter จนคำสั่งพื้นฐานโดนบล็อกทิ้ง
    safetySettings: SAFETY_OFF,
  };
  if (req.system?.length) {
    body.system_instruction = { parts: [{ text: req.system.map((b: any) => b.text).join("\n\n") }] };
  }
  if (req.tools) {
    body.tools = [{
      function_declarations: req.tools.map((t: any) => ({
        name: t.name,
        description: t.description,
        parameters: cleanSchema(t.input_schema),
      })),
    }];
  }
  if (req.tool_choice?.type === "tool" && req.tool_choice.name) {
    body.toolConfig = {
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: [req.tool_choice.name] },
    };
  }

  const res = await fetch(
    `${spec.baseURL}/models/${spec.model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": Deno.env.get(spec.keyEnv) ?? "",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`${spec.model} ตอบ ${res.status}: ${(await res.text()).slice(0, 400)}`);

  const data = await res.json();

  // บล็อกทั้ง prompt ตั้งแต่ยังไม่เริ่มตอบ — ไม่มี candidates กลับมาเลย มีแต่เหตุผล
  // PROHIBITED_CONTENT เป็น filter ที่ผู้เรียกตั้งค่าไม่ได้ safetySettings ช่วยไม่ได้
  // ทางเดียวคือส่งของที่สั้นลง ผู้เรียกจึงต้องแยกกรณีนี้ออกจาก error อื่นได้
  const blockReason = data.promptFeedback?.blockReason;
  if (blockReason) {
    console.error(`${spec.model} บล็อก prompt ทิ้ง blockReason=${blockReason} promptTokens=${data.usageMetadata?.promptTokenCount ?? "?"}`);
    const err = new Error(`${spec.model} บล็อก prompt ทิ้งทั้งก้อน (${blockReason})`);
    err.name = "PromptBlocked";
    throw err;
  }

  const out = fromGeminiResponse(data);
  if (out.content.length === 0 && out.stop_reason !== "refusal") {
    console.error(`${spec.model} ตอบว่างเปล่า finishReason=${out.finish_reason} ${JSON.stringify(data).slice(0, 800)}`);
    throw new Error(`${spec.model} ตอบว่างเปล่า finishReason=${out.finish_reason}`);
  }
  return out;
}

// ทางเข้าเดียวของการยิงเข้าโมเดล ไม่ว่าจะค่ายไหน
export async function createMessage(spec: ModelSpec, req: any): Promise<any> {
  if (spec.provider === "gemini") return await callGemini(spec, req);
  if (spec.provider === "openai") return await callOpenAICompatible(spec, req);
  // Haiku 4.5 ไม่รับ output_config.effort ถ้าส่งไปจะได้ 400 กลับมา
  const supportsEffort = !spec.model.includes("haiku");
  return await (anthropic as any).messages.create({
    model: spec.model,
    max_tokens: req.max_tokens,
    ...(supportsEffort ? { output_config: { effort: "medium" } } : {}),
    system: req.system,
    ...(req.tools ? { tools: req.tools } : {}),
    ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}),
    messages: req.messages,
  });
}
