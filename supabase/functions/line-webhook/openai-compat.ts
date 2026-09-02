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

export async function callOpenAICompatible(spec: ModelSpec, req: any): Promise<any> {
  const body: any = {
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

  let res = await send(body);
  // ชื่อพารามิเตอร์จำกัดความยาวคำตอบยังไม่ตรงกันทุกเจ้า ตัวไหนไม่รู้จัก max_completion_tokens
  // ให้ลองแบบเก่าอีกรอบ ดีกว่าให้คนมานั่งเดาว่าทำไม 400
  if (res.status === 400) {
    const detail = await res.text();
    if (detail.includes("max_completion_tokens")) {
      const { max_completion_tokens, ...rest } = body;
      res = await send({ ...rest, max_tokens: max_completion_tokens });
    } else {
      throw new Error(`${spec.model} ตอบ 400: ${detail.slice(0, 400)}`);
    }
  }
  if (!res.ok) throw new Error(`${spec.model} ตอบ ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return fromOpenAIResponse(await res.json());
}
