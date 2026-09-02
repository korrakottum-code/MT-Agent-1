// ตัวแปลข้ามค่าย: คุยกับโมเดลที่ไม่ใช่ Anthropic ด้วยหน้าตาแบบ OpenAI chat completions
// ซึ่งเป็นภาษากลางที่ทั้ง OpenAI และ Gemini (endpoint โหมด openai) รับได้
//
// แยกไฟล์ออกมาเพราะเป็นส่วนที่พังเงียบที่สุด — แปลผิดนิดเดียวโมเดลจะเรียก tool ไม่ได้เลย
// แล้วผลเทียบจะออกมาว่า "โมเดลนี้ใช้ tool ไม่เป็น" ทั้งที่เป็นความผิดของตัวแปลเอง
// มีข้อสอบของตัวเองที่ openai-compat.test.ts รันด้วย: deno test --allow-env supabase/functions/line-webhook/

export type ModelSpec = {
  provider: "anthropic" | "openai";
  model: string;
  baseURL?: string;
  keyEnv: string;
};

// แปลงคำขอหน้าตาแบบ Anthropic เป็น OpenAI chat completions
// cache_control หายไปตรงนี้โดยตั้งใจ ฝั่ง OpenAI ไม่มีของแบบนั้นให้สั่ง
export function toOpenAIMessages(system: any[], messages: any[]): any[] {
  const out: any[] = [{ role: "system", content: system.map((b: any) => b.text).join("\n\n") }];

  for (const m of messages) {
    if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
      const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      const calls = blocks.filter((b: any) => b.type === "tool_use").map((b: any) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
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
    content.push({ type: "tool_use", id: call.id, name: call.function?.name, input });
  }
  const stop = msg.refusal || choice.finish_reason === "content_filter"
    ? "refusal"
    : (msg.tool_calls?.length ? "tool_use" : "end_turn");
  const u = data.usage ?? {};
  return {
    content,
    stop_reason: stop,
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
      cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
      cache_creation_input_tokens: 0,
    },
  };
}

// พารามิเตอร์ที่บางเจ้าต้องปรับก่อนถึงจะยอมทำงาน รู้ได้จาก error ที่มันตอบกลับมาเท่านั้น
// จึงลองแบบมาตรฐานก่อน แล้วปรับตามที่มันบอก ดีกว่าฮาร์ดโค้ดข้อยกเว้นรายเจ้าไว้ล่วงหน้า
// ซึ่งจะผิดทันทีที่เขาเปลี่ยนรุ่น
type Fix = "max_tokens" | "no_reasoning";

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
    tools: req.tools.map((t: any) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    })),
  };

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
  return fromOpenAIResponse(await res.json());
}
