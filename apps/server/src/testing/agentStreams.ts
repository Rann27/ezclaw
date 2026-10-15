import type { ServerResponse } from "node:http";
import { contextFromAnthropic, contextFromChat, contextFromResponses, isAgentModel, runScript, type Action } from "./agentScripts.js";

type Json = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sseHead(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
}

function argsOf(a: Extract<Action, { tool: string }>): string {
  return a.rawArgs ?? JSON.stringify(a.args);
}

/** OpenAI Chat Completions: tool_calls arrive as deltas, text as content. */
export async function agentChat(res: ServerResponse, body: Json): Promise<void> {
  const model = String(body.model);
  const actions = body.tools ? runScript(model, contextFromChat(body)) : [{ text: "RINGKASAN uji: pengguna meminta beberapa hal dan agent mengerjakannya." } as Action];
  sseHead(res);
  const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
  const chunk = (delta: Json, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });

  send(chunk({ role: "assistant", reasoning_content: "Memikirkan langkah. " }));
  const calls = actions.filter((a): a is Extract<Action, { tool: string }> => "tool" in a);
  const text = actions.filter((a): a is Extract<Action, { text: string }> => "text" in a);
  for (const t of text) {
    for (let i = 0; i < t.text.length; i += 6) {
      send(chunk({ content: t.text.slice(i, i + 6) }));
      await sleep(5);
    }
  }
  calls.forEach((c, index) => {
    const args = argsOf(c);
    send(chunk({ tool_calls: [{ index, id: `call_${index}`, type: "function", function: { name: c.tool, arguments: "" } }] }));
    send(chunk({ tool_calls: [{ index, function: { arguments: args.slice(0, Math.ceil(args.length / 2)) } }] }));
    send(chunk({ tool_calls: [{ index, function: { arguments: args.slice(Math.ceil(args.length / 2)) } }] }));
  });
  send(chunk({}, calls.length ? "tool_calls" : "stop"));
  send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  res.write("data: [DONE]\n\n");
  res.end();
}

/** OpenAI Responses API (also what DeepSeek exposes): items, deltas, then response.completed. */
export async function agentResponses(res: ServerResponse, body: Json): Promise<void> {
  const model = String(body.model);
  const actions = isAgentModel(model) && body.tools ? runScript(model, contextFromResponses(body)) : [{ text: isAgentModel(model) ? "RINGKASAN uji: pengguna meminta beberapa hal dan agent mengerjakannya." : "Halo dunia" } as Action];
  sseHead(res);
  let seq = 0;
  const send = (type: string, data: Json) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);

  send("response.created", { response: { id: "resp_1", status: "in_progress" } });
  const output: Json[] = [];
  let index = 0;

  const reasoning: Json = { type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "Memikirkan langkah. " }], summary: [] };
  send("response.output_item.added", { output_index: index, item: { type: "reasoning", id: "rs_1" } });
  send("response.reasoning_text.delta", { item_id: "rs_1", output_index: index, delta: "Memikirkan langkah. " });
  send("response.output_item.done", { output_index: index, item: reasoning });
  output.push(reasoning);
  index++;

  for (const a of actions) {
    if ("text" in a) {
      const id = `msg_${index}`;
      send("response.output_item.added", { output_index: index, item: { type: "message", id, role: "assistant", content: [] } });
      for (let i = 0; i < a.text.length; i += 6) {
        send("response.output_text.delta", { item_id: id, output_index: index, delta: a.text.slice(i, i + 6) });
        await sleep(5);
      }
      const item: Json = { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text: a.text }] };
      send("response.output_item.done", { output_index: index, item });
      output.push(item);
    } else {
      const id = `fc_${index}`;
      const callId = `call_${index}`;
      const args = argsOf(a);
      send("response.output_item.added", { output_index: index, item: { type: "function_call", id, call_id: callId, name: a.tool, arguments: "" } });
      send("response.function_call_arguments.delta", { item_id: id, output_index: index, delta: args.slice(0, Math.ceil(args.length / 2)) });
      send("response.function_call_arguments.delta", { item_id: id, output_index: index, delta: args.slice(Math.ceil(args.length / 2)) });
      const item: Json = { type: "function_call", id, call_id: callId, name: a.tool, arguments: args, status: "completed" };
      send("response.output_item.done", { output_index: index, item });
      output.push(item);
    }
    index++;
  }
  send("response.completed", { response: { id: "resp_1", status: "completed", output, usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } } } });
  res.end();
}

/** Anthropic Messages: content blocks with tool_use and input_json_delta. */
export async function agentAnthropic(res: ServerResponse, body: Json): Promise<void> {
  const model = String(body.model);
  const actions = isAgentModel(model) && body.tools ? runScript(model, contextFromAnthropic(body)) : [{ text: isAgentModel(model) ? "RINGKASAN uji: pengguna meminta beberapa hal dan agent mengerjakannya." : "Halo dari Claude." } as Action];
  sseHead(res);
  const ev = (type: string, data: Json) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

  ev("message_start", { message: { usage: { input_tokens: 100 } } });
  let index = 0;
  ev("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
  ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: "Memikirkan langkah. " } });
  ev("content_block_delta", { index, delta: { type: "signature_delta", signature: "sig-agent" } });
  ev("content_block_stop", { index });
  index++;

  let usedTool = false;
  for (const a of actions) {
    if ("text" in a) {
      ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      for (let i = 0; i < a.text.length; i += 6) {
        ev("content_block_delta", { index, delta: { type: "text_delta", text: a.text.slice(i, i + 6) } });
        await sleep(5);
      }
    } else {
      usedTool = true;
      const args = argsOf(a);
      ev("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${index}`, name: a.tool, input: {} } });
      ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: args.slice(0, Math.ceil(args.length / 2)) } });
      ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: args.slice(Math.ceil(args.length / 2)) } });
    }
    ev("content_block_stop", { index });
    index++;
  }
  ev("message_delta", { delta: { stop_reason: usedTool ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } });
  ev("message_stop", {});
  res.end();
}
