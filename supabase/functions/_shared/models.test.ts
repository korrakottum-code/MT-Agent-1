// ข้อสอบของตัวแปลข้ามค่าย — รันฟรี ไม่ยิงเข้าโมเดลจริง ไม่เสียเงิน
// deno test --allow-env supabase/functions/_shared/
//
// จุดประสงค์: ถ้าตัวแปลพัง ผลเทียบโมเดลจะโกหกว่า "โมเดลนี้เรียก tool ไม่เป็น"
// ทั้งที่ความจริงคือเราแปลคำขอผิดเอง ข้อสอบชุดนี้กันไม่ให้สรุปผิดแบบนั้น
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  _resetLearnedFixes,
  callGemini,
  callOpenAICompatible,
  fromGeminiResponse,
  fromOpenAIResponse,
  toGeminiContents,
  toOpenAIMessages,
} from "./models.ts";

const SYSTEM = [
  { type: "text", text: "กฎ", cache_control: { type: "ephemeral" } },
  { type: "text", text: "บริบท" },
];

Deno.test("system หลายบล็อกยุบเป็นข้อความเดียว และ cache_control ไม่หลุดไปด้วย", () => {
  const out = toOpenAIMessages(SYSTEM, []);
  assertEquals(out.length, 1);
  assertEquals(out[0], { role: "system", content: "กฎ\n\nบริบท" });
});

Deno.test("ข้อความผู้ใช้แบบสตริงส่งผ่านตรง ๆ", () => {
  const out = toOpenAIMessages(SYSTEM, [{ role: "user", content: "งานฉันมีอะไรบ้าง" }]);
  assertEquals(out[1], { role: "user", content: "งานฉันมีอะไรบ้าง" });
});

Deno.test("tool_use ของ Anthropic กลายเป็น tool_calls และ input ถูก stringify", () => {
  const out = toOpenAIMessages(SYSTEM, [{
    role: "assistant",
    content: [
      { type: "text", text: "เดี๋ยวเช็คให้นะคะ" },
      { type: "tool_use", id: "tu_1", name: "get_my_tasks", input: { status: "TODO" } },
    ],
  }]);
  assertEquals(out[1].content, "เดี๋ยวเช็คให้นะคะ");
  assertEquals(out[1].tool_calls, [{
    id: "tu_1",
    type: "function",
    function: { name: "get_my_tasks", arguments: '{"status":"TODO"}' },
  }]);
});

Deno.test("assistant ที่มีแต่ tool_use ต้องไม่มี key tool_calls โผล่มาเป็น array ว่าง", () => {
  const out = toOpenAIMessages(SYSTEM, [{ role: "assistant", content: [{ type: "text", text: "ค่ะ" }] }]);
  assertEquals("tool_calls" in out[1], false);
});

Deno.test("ผลลัพธ์ tool แตกเป็น message ละ 1 การเรียก พร้อม tool_call_id", () => {
  const out = toOpenAIMessages(SYSTEM, [{
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tu_1", content: '{"tasks":[]}' },
      { type: "tool_result", tool_use_id: "tu_2", content: '{"error":"no"}', is_error: true },
    ],
  }]);
  assertEquals(out.slice(1), [
    { role: "tool", tool_call_id: "tu_1", content: '{"tasks":[]}' },
    { role: "tool", tool_call_id: "tu_2", content: '{"error":"no"}' },
  ]);
});

Deno.test("รูปภาพกลายเป็น data URI", () => {
  const out = toOpenAIMessages(SYSTEM, [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      { type: "text", text: "รูปนี้คืออะไร" },
    ],
  }]);
  assertEquals(out[1].content, [
    { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    { type: "text", text: "รูปนี้คืออะไร" },
  ]);
});

Deno.test("PDF ต้องพังดัง ๆ ไม่ใช่เงียบ ๆ ทิ้งไฟล์แล้วให้โมเดลตอบมั่ว", () => {
  assertThrows(() =>
    toOpenAIMessages(SYSTEM, [{
      role: "user",
      content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAA" } }],
    }])
  );
});

Deno.test("คำตอบที่มีแต่ข้อความ = จบเทิร์น", () => {
  const r = fromOpenAIResponse({
    choices: [{ finish_reason: "stop", message: { content: "ไม่มีงานค้างค่ะ" } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  });
  assertEquals(r.stop_reason, "end_turn");
  assertEquals(r.content, [{ type: "text", text: "ไม่มีงานค้างค่ะ" }]);
  assertEquals(r.usage.input_tokens, 100);
  assertEquals(r.usage.output_tokens, 20);
});

Deno.test("คำตอบที่เรียก tool กลายเป็น stop_reason tool_use ให้ลูปเดิมอ่านรู้เรื่อง", () => {
  const r = fromOpenAIResponse({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: [{ id: "call_1", function: { name: "create_task", arguments: '{"title":"ทำสไลด์"}' } }],
      },
    }],
  });
  assertEquals(r.stop_reason, "tool_use");
  // ตรวจเฉพาะฟิลด์ที่ลูป tool ใช้จริง ส่วน _raw เป็นของภายในไว้ส่งคืนเจ้าของ
  const block = r.content[0];
  assertEquals(block.type, "tool_use");
  assertEquals(block.id, "call_1");
  assertEquals(block.name, "create_task");
  assertEquals(block.input, { title: "ทำสไลด์" });
});

Deno.test("arguments ที่ไม่ใช่ JSON ต้องไม่ทำทั้งเทิร์นล่ม ให้ tool ตอบ error กลับไปแทน", () => {
  const r = fromOpenAIResponse({
    choices: [{
      finish_reason: "tool_calls",
      message: { tool_calls: [{ id: "call_1", function: { name: "create_task", arguments: "{ไม่ใช่ json" } }] },
    }],
  });
  assertEquals(r.content[0].input, {});
});

Deno.test("การปฏิเสธของโมเดลแปลงเป็น refusal ทั้งสองแบบ", () => {
  assertEquals(fromOpenAIResponse({ choices: [{ message: { refusal: "no" } }] }).stop_reason, "refusal");
  assertEquals(
    fromOpenAIResponse({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] }).stop_reason,
    "refusal",
  );
});

Deno.test("usage ที่ไม่มีมาด้วย ต้องนับเป็น 0 ไม่ใช่ NaN ไม่งั้นยอดต้นทุนเพี้ยนทั้งรอบ", () => {
  const r = fromOpenAIResponse({ choices: [{ message: { content: "ค่ะ" } }] });
  assertEquals(r.usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

// ---------------------------------------------------------------- การยิงจริง (fetch ปลอม)

const SPEC = { provider: "openai" as const, model: "test-model", baseURL: "https://x/v1", keyEnv: "TEST_KEY" };
const REQ = {
  max_tokens: 4096,
  system: SYSTEM,
  messages: [{ role: "user", content: "หวัดดี" }],
  tools: [{ name: "get_my_tasks", description: "ดูงาน", input_schema: { type: "object", properties: {} } }],
};

function stubFetch(handler: (url: string, body: any) => Response) {
  _resetLearnedFixes();
  const real = globalThis.fetch;
  globalThis.fetch = ((url: any, init: any) =>
    Promise.resolve(handler(String(url), JSON.parse(String(init.body))))) as any;
  return () => { globalThis.fetch = real; };
}

Deno.test("tool ของเราถูกห่อเป็น function ตามรูปแบบ OpenAI และยิงไปที่ /chat/completions", async () => {
  let seenUrl = "", seenBody: any = null;
  const restore = stubFetch((url, body) => {
    seenUrl = url; seenBody = body;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  });
  try {
    await callOpenAICompatible(SPEC, REQ);
  } finally { restore(); }
  assertEquals(seenUrl, "https://x/v1/chat/completions");
  assertEquals(seenBody.model, "test-model");
  assertEquals(seenBody.tools, [{
    type: "function",
    function: { name: "get_my_tasks", description: "ดูงาน", parameters: { type: "object", properties: {} } },
  }]);
});

Deno.test("เจ้าที่ไม่รู้จัก max_completion_tokens ต้องถอยไปใช้ max_tokens ให้เอง", async () => {
  const bodies: any[] = [];
  const restore = stubFetch((_url, body) => {
    bodies.push(body);
    if ("max_completion_tokens" in body) {
      return new Response('{"error":{"message":"Unsupported parameter: max_completion_tokens"}}', { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  });
  try {
    const r = await callOpenAICompatible(SPEC, REQ);
    assertEquals(r.content[0].text, "ok");
  } finally { restore(); }
  assertEquals(bodies.length, 2);
  assertEquals(bodies[1].max_tokens, 4096);
  assertEquals("max_completion_tokens" in bodies[1], false);
});

Deno.test("400 เรื่องอื่นต้องโยน error พร้อมรายละเอียด ไม่ใช่ลองซ้ำไปเรื่อย", async () => {
  let calls = 0;
  const restore = stubFetch(() => {
    calls++;
    return new Response('{"error":{"message":"model not found"}}', { status: 400 });
  });
  try {
    await assertRejects(() => callOpenAICompatible(SPEC, REQ), Error, "model not found");
  } finally { restore(); }
  assertEquals(calls, 1);
});

Deno.test("รุ่นที่ห้ามใช้ tool ตอน reasoning_effort ไม่ใช่ none ต้องถอยมาตั้ง none ให้เอง", async () => {
  // อาการจริงของ gpt-5.6-luna วันที่เชื่อมครั้งแรก ถ้าไม่ปรับให้ = เรียก tool ไม่ได้เลยทั้งชุด
  const bodies: any[] = [];
  const restore = stubFetch((_url, body) => {
    bodies.push(body);
    if (body.reasoning_effort !== "none") {
      return new Response(
        '{"error":{"message":"Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to \'none\'.","param":"reasoning_effort"}}',
        { status: 400 },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  });
  try {
    const r = await callOpenAICompatible(SPEC, REQ);
    assertEquals(r.content[0].text, "ok");
  } finally { restore(); }
  assertEquals(bodies.length, 2);
  assertEquals(bodies[1].reasoning_effort, "none");
  assertEquals(bodies[1].tools.length, 1);
});

Deno.test("อาการเดิมของรุ่นเดิมต้องจำได้ ไม่เสีย 400 ซ้ำทุกรอบของคำตอบเดียว", async () => {
  const bodies: any[] = [];
  const restore = stubFetch((_url, body) => {
    bodies.push(body);
    if (body.reasoning_effort !== "none") {
      return new Response('{"error":{"param":"reasoning_effort"}}', { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  });
  try {
    await callOpenAICompatible(SPEC, REQ);   // รอบแรก เรียนรู้
    await callOpenAICompatible(SPEC, REQ);   // รอบสอง ต้องยิงตรงเลย
  } finally { restore(); }
  assertEquals(bodies.length, 3);
  assertEquals(bodies[2].reasoning_effort, "none");
});

Deno.test("ปรับได้สองอย่างพร้อมกัน ถ้าเจ้านั้นบ่นทีละเรื่อง", async () => {
  const bodies: any[] = [];
  const restore = stubFetch((_url, body) => {
    bodies.push(body);
    if ("max_completion_tokens" in body) {
      return new Response('{"error":{"message":"Unsupported parameter: max_completion_tokens"}}', { status: 400 });
    }
    if (body.reasoning_effort !== "none") {
      return new Response('{"error":{"param":"reasoning_effort"}}', { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  });
  try {
    const r = await callOpenAICompatible(SPEC, REQ);
    assertEquals(r.content[0].text, "ok");
  } finally { restore(); }
  assertEquals(bodies.length, 3);
  assertEquals(bodies[2].max_tokens, 4096);
  assertEquals(bodies[2].reasoning_effort, "none");
});

Deno.test("400 ที่ปรับแล้วยังไม่หาย ต้องเลิกลอง ไม่ใช่วนไปเรื่อย", async () => {
  let calls = 0;
  const restore = stubFetch(() => {
    calls++;
    return new Response('{"error":{"param":"reasoning_effort"}}', { status: 400 });
  });
  try {
    await assertRejects(() => callOpenAICompatible(SPEC, REQ), Error, "400");
  } finally { restore(); }
  assertEquals(calls, 2);
});

Deno.test("token ที่อ่านจาก cache ต้องไม่ถูกนับซ้ำในช่อง input", () => {
  // OpenAI นับ cached รวมอยู่ใน prompt_tokens แล้ว ส่วน Anthropic แยกกัน
  // ถ้าไม่ลบออก ต้นทุนของโมเดลค่ายอื่นจะพองขึ้นและตัดสินใจเลือกโมเดลผิด
  const r = fromOpenAIResponse({
    choices: [{ message: { content: "ok" } }],
    usage: { prompt_tokens: 14723, completion_tokens: 111, prompt_tokens_details: { cached_tokens: 7294 } },
  });
  assertEquals(r.usage.input_tokens, 7429);
  assertEquals(r.usage.cache_read_input_tokens, 7294);
  assertEquals(r.usage.input_tokens + r.usage.cache_read_input_tokens, 14723);
});

Deno.test("ของแถมที่เจ้านั้นแนบมากับ tool call ต้องถูกส่งคืนครบ ไม่ใช่ประกอบขึ้นใหม่", () => {
  // อาการจริงของ gemini-3.7-flash: ขาด thought_signature แล้ว 400 ตั้งแต่รอบที่สอง
  const call = {
    id: "call_1",
    type: "function",
    function: { name: "create_task", arguments: '{"title":"ทำสไลด์"}' },
    extra_content: { google: { thought_signature: "sig-abc" } },
  };
  const r = fromOpenAIResponse({ choices: [{ message: { tool_calls: [call] } }] });
  const back = toOpenAIMessages(SYSTEM, [{ role: "assistant", content: r.content }]);
  assertEquals(back[1].tool_calls, [call]);
});

Deno.test("tool_use ที่ไม่มีของแถม ยังประกอบขึ้นใหม่ได้เหมือนเดิม", () => {
  const back = toOpenAIMessages(SYSTEM, [{
    role: "assistant",
    content: [{ type: "tool_use", id: "tu_1", name: "get_my_tasks", input: { status: "TODO" } }],
  }]);
  assertEquals(back[1].tool_calls, [{
    id: "tu_1",
    type: "function",
    function: { name: "get_my_tasks", arguments: '{"status":"TODO"}' },
  }]);
});

Deno.test("การบังคับให้ตอบผ่าน tool ตัวเดียว ต้องแปลไปถึงฝั่ง OpenAI ด้วย", async () => {
  // งานอ่านบทสนทนาจับงาน/มติ บังคับ tool ตัวเดียวเสมอ ถ้าแปลหาย ผลลัพธ์จะว่างทุกครั้งแบบเงียบ ๆ
  let seen: any = null;
  const restore = stubFetch((_url, body) => {
    seen = body;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  });
  try {
    await callOpenAICompatible(SPEC, { ...REQ, tool_choice: { type: "tool", name: "record_events" } });
  } finally { restore(); }
  assertEquals(seen.tool_choice, { type: "function", function: { name: "record_events" } });
});

Deno.test("งานที่ไม่มี tool เลย ต้องไม่ส่ง key tools ว่าง ๆ ไป", async () => {
  let seen: any = null;
  const restore = stubFetch((_url, body) => {
    seen = body;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  });
  try {
    await callOpenAICompatible(SPEC, { max_tokens: 1024, system: SYSTEM, messages: REQ.messages });
  } finally { restore(); }
  assertEquals("tools" in seen, false);
  assertEquals("tool_choice" in seen, false);
});

Deno.test("ตอบ 200 มาแบบว่างเปล่า ต้องลองใหม่แบบปิดการคิด ไม่ใช่ปล่อยให้ผู้ใช้เห็น '…'", async () => {
  // อาการจริงของ gemini-3.7-flash วันที่ย้าย production: 200 OK แต่ completion_tokens = 0
  const bodies: any[] = [];
  const restore = stubFetch((_url, body) => {
    bodies.push(body);
    if (body.reasoning_effort !== "none") {
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "" } }], usage: { completion_tokens: 0 } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ตอบได้แล้วค่ะ" } }] }), { status: 200 });
  });
  try {
    const r = await callOpenAICompatible(SPEC, REQ);
    assertEquals(r.content[0].text, "ตอบได้แล้วค่ะ");
  } finally { restore(); }
  assertEquals(bodies.length, 2);
  assertEquals(bodies[1].reasoning_effort, "none");
  assertEquals(bodies[1].max_completion_tokens, 8192);
});

Deno.test("ว่างเปล่าสองครั้งติด ต้องโยน error ให้เห็น ไม่ใช่ตอบเงียบ ๆ", async () => {
  const restore = stubFetch(() =>
    new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: {} }] }), { status: 200 })
  );
  try {
    await assertRejects(() => callOpenAICompatible(SPEC, REQ), Error, "ว่างเปล่าสองครั้งติด");
  } finally { restore(); }
});


// ---------------------------------------------------------------- Gemini ตัวเต็ม

const GSPEC = {
  provider: "gemini" as const,
  model: "gemini-x",
  baseURL: "https://generativelanguage.googleapis.com/v1beta",
  keyEnv: "TEST_KEY",
};

Deno.test("ผลลัพธ์ tool ต้องอ้างกลับด้วยชื่อ tool ไม่ใช่ id เพราะ Gemini ไม่รู้จัก id ของเรา", () => {
  const out = toGeminiContents([
    { role: "user", content: "งานฉันมีอะไรบ้าง" },
    { role: "assistant", content: [{ type: "tool_use", id: "gem_0_get_my_tasks", name: "get_my_tasks", input: { status: "TODO" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "gem_0_get_my_tasks", content: '{"tasks":[]}' }] },
  ]);
  assertEquals(out[1], { role: "model", parts: [{ functionCall: { name: "get_my_tasks", args: { status: "TODO" } } }] });
  assertEquals(out[2], {
    role: "user",
    parts: [{ functionResponse: { name: "get_my_tasks", response: { result: '{"tasks":[]}' } } }],
  });
});

Deno.test("PDF กับรูปแนบไปเป็น inline_data ได้ทั้งคู่", () => {
  const out = toGeminiContents([{
    role: "user",
    content: [
      { type: "document", source: { media_type: "application/pdf", data: "AAA" } },
      { type: "text", text: "สรุปให้หน่อย" },
    ],
  }]);
  assertEquals(out[0].parts[0], { inline_data: { mime_type: "application/pdf", data: "AAA" } });
  assertEquals(out[0].parts[1], { text: "สรุปให้หน่อย" });
});

Deno.test("การเรียก tool ของ Gemini แปลงเป็น stop_reason tool_use พร้อม id ที่ตั้งเองไม่ซ้ำ", () => {
  const r = fromGeminiResponse({
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ functionCall: { name: "create_task", args: { title: "ทำสไลด์" } } }] },
    }],
    usageMetadata: { promptTokenCount: 7500, candidatesTokenCount: 40, cachedContentTokenCount: 500 },
  });
  assertEquals(r.stop_reason, "tool_use");
  assertEquals(r.content[0].name, "create_task");
  assertEquals(r.content[0].input, { title: "ทำสไลด์" });
  // cached ถูกนับรวมใน promptTokenCount แล้ว ต้องหักออกให้ความหมายตรงกับฝั่ง Anthropic
  assertEquals(r.usage.input_tokens, 7000);
  assertEquals(r.usage.cache_read_input_tokens, 500);
});

Deno.test("โดน filter บล็อก ต้องกลายเป็น refusal ไม่ใช่คำตอบว่าง", () => {
  const r = fromGeminiResponse({ candidates: [{ finishReason: "PROHIBITED_CONTENT", content: {} }] });
  assertEquals(r.stop_reason, "refusal");
  assertEquals(r.content.length, 0);
});

Deno.test("ทุกคำขอต้องแนบ safetySettings ไปด้วย นี่คือเหตุผลเดียวที่ต้องใช้ API ตัวเต็ม", async () => {
  let seenUrl = "", seenBody: any = null;
  const restore = stubFetch((url, body) => {
    seenUrl = url; seenBody = body;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
  });
  try {
    await callGemini(GSPEC, { ...REQ, tool_choice: { type: "tool", name: "get_my_tasks" } });
  } finally { restore(); }
  assertEquals(seenUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
  assertEquals(seenBody.safetySettings.length, 5);
  assertEquals(seenBody.system_instruction.parts[0].text, "กฎ\n\nบริบท");
  assertEquals(seenBody.tools[0].function_declarations[0].name, "get_my_tasks");
  assertEquals(seenBody.toolConfig.functionCallingConfig.allowedFunctionNames, ["get_my_tasks"]);
});

Deno.test("คำที่ Gemini ไม่รู้จักใน schema ต้องถูกตัดออก ไม่งั้นมันปฏิเสธทั้งชุด tool", async () => {
  let seenBody: any = null;
  const restore = stubFetch((_u, body) => {
    seenBody = body;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
  });
  try {
    await callGemini(GSPEC, {
      ...REQ,
      tools: [{
        name: "t",
        description: "d",
        input_schema: {
          type: "object",
          additionalProperties: false,
          properties: { a: { type: "object", additionalProperties: false, properties: {} } },
        },
      }],
    });
  } finally { restore(); }
  const p = seenBody.tools[0].function_declarations[0].parameters;
  assertEquals("additionalProperties" in p, false);
  assertEquals("additionalProperties" in p.properties.a, false);
});

Deno.test("ตอบว่างเปล่าโดยไม่ได้ถูกบล็อก ต้องโยน error พร้อม finishReason", async () => {
  const restore = stubFetch(() =>
    new Response(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: {} }] }), { status: 200 })
  );
  try {
    await assertRejects(() => callGemini(GSPEC, REQ), Error, "MAX_TOKENS");
  } finally { restore(); }
});

Deno.test("thoughtSignature ที่ Gemini แนบมา ต้องส่งคืนครบ ไม่งั้นรอบสองพังทุกครั้ง", () => {
  // อาการจริง: รอบแรกเรียก tool ได้ พอส่งผลลัพธ์กลับก็ 400 ว่าขาด thought_signature
  const part = {
    functionCall: { name: "get_my_tasks", args: {} },
    thoughtSignature: "sig-xyz",
  };
  const r = fromGeminiResponse({ candidates: [{ content: { parts: [part] } }] });
  const back = toGeminiContents([{ role: "assistant", content: r.content }]);
  assertEquals(back[0].parts[0], part);
});

Deno.test("คำสั่งเรียก tool ที่เขียนออกมาไม่ถูกรูป ต้องยิงซ้ำ ไม่ใช่ตอบว่าระบบขัดข้อง", async () => {
  let calls = 0;
  const restore = stubFetch(() => {
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL", content: { parts: [{ text: "" }] } }] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "สรุปให้แล้วค่ะ" }] } }] }), { status: 200 });
  });
  try {
    const r = await callGemini(GSPEC, REQ);
    assertEquals(r.content[0].text, "สรุปให้แล้วค่ะ");
  } finally { restore(); }
  assertEquals(calls, 2);
});

Deno.test("system ที่ส่งมาเป็นสตริงต้องใช้ได้ ไม่ใช่แค่ array ของบล็อก", async () => {
  // งานเบื้องหลัง (สรุปรายวัน/รายสัปดาห์/จับงานจากบทสนทนา) ส่ง system เป็นสตริงมาตลอด
  // ตอนย้ายไป Gemini ตัวแปลรับแต่ array จึงพังทั้งสามงานพร้อมกันแบบเงียบ ๆ
  let seenGemini: any = null, seenOpenAI: any = null;
  let restore = stubFetch((_u, b) => {
    seenGemini = b;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
  });
  try {
    await callGemini(GSPEC, { max_tokens: 512, system: "คุณคือแงว สรุปให้สั้น", messages: [{ role: "user", content: "สรุป" }] });
  } finally { restore(); }
  assertEquals(seenGemini.system_instruction.parts[0].text, "คุณคือแงว สรุปให้สั้น");

  restore = stubFetch((_u, b) => {
    seenOpenAI = b;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  });
  try {
    await callOpenAICompatible(SPEC, { max_tokens: 512, system: "คุณคือแงว สรุปให้สั้น", messages: [{ role: "user", content: "สรุป" }] });
  } finally { restore(); }
  assertEquals(seenOpenAI.messages[0], { role: "system", content: "คุณคือแงว สรุปให้สั้น" });
});
