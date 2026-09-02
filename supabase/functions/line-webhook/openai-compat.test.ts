// ข้อสอบของตัวแปลข้ามค่าย — รันฟรี ไม่ยิงเข้าโมเดลจริง ไม่เสียเงิน
// deno test --allow-env supabase/functions/line-webhook/
//
// จุดประสงค์: ถ้าตัวแปลพัง ผลเทียบโมเดลจะโกหกว่า "โมเดลนี้เรียก tool ไม่เป็น"
// ทั้งที่ความจริงคือเราแปลคำขอผิดเอง ข้อสอบชุดนี้กันไม่ให้สรุปผิดแบบนั้น
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { callOpenAICompatible, fromOpenAIResponse, toOpenAIMessages } from "./openai-compat.ts";

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
  assertEquals(r.content, [{ type: "tool_use", id: "call_1", name: "create_task", input: { title: "ทำสไลด์" } }]);
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
