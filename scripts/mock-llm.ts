/**
 * TEST DOUBLE - NOT THE LLM USED FOR GRADING.
 * A tiny OpenAI-compatible /chat/completions server with a rule-based "model". It exists only so the end-to-end
 * script can exercise the real OpenAiCompatibleClient -> agent -> MCP/gateway -> API -> PostgreSQL plumbing
 * without an API key. The real assistant uses a real LLM (set LLM_API_KEY); see README.
 */
import { createServer } from "node:http";

const port = Number(process.env.MOCK_LLM_PORT ?? 3999);
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const call = (name: string, args: unknown, n: number) => ({ role: "assistant", content: null, tool_calls: [{ id: `mock_${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

function respond(messages: any[]) {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const text: string = messages[lastUserIdx].content ?? "";
  const lower = text.toLowerCase();
  const results = messages.slice(lastUserIdx + 1).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
  const found = MONTHS.map((m, i) => ({ i, at: lower.indexOf(m) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at)[0];
  const monthIdx = found ? found.i : -1;
  const month = monthIdx >= 0 ? monthIdx + 1 : 10;
  const year = Number(/\b(20\d\d)\b/.exec(text)?.[1] ?? 2026);
  const prev = month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
  const n = results.length;

  if (/\bpay\b/.test(lower) && !lower.startsWith("(system")) {
    if (n === 0) return call("pay_bill", { month, year, ...(/\$?(\d+(\.\d+)?)/.exec(lower.replace(/20\d\d/, ""))?.[1] ? { amount: Number(/\$?(\d+(\.\d+)?)/.exec(lower.replace(/20\d\d/, ""))![1]) } : {}) }, 1);
    const r = results[0];
    return { role: "assistant", content: r.status === "CONFIRMATION_REQUIRED" ? `I can pay $${r.payment.amount} of your ${r.payment.month}/${r.payment.year} bill. Please confirm (reply "yes, confirm") to proceed.` : `The payment could not be prepared: ${r.reason ?? r.error?.message ?? r.status}` };
  }
  if (/(why|higher|increase|compare)/.test(lower)) {
    if (n === 0) return call("query_bill_detailed", { month, year }, 1);
    if (n === 1) return call("query_bill_detailed", prev, 2);
    if (n === 2) return call("search_billing_documentation", { query: "extra internet charge started 10 GB block extra phone minutes" }, 3);
    const [cur, before, docs] = results;
    return { role: "assistant", content: `Your ${month}/${year} bill is $${cur.bill.total} versus $${before.bill.total} the month before. Phone: ${cur.bill.phoneMinutes} min ($${cur.bill.phoneCharge}); internet: ${cur.bill.internetGb} GB ($${cur.bill.internetCharge}). Pricing rule (Source: ${docs.results?.[0]?.reference}): ${docs.results?.[0]?.excerpt?.slice(0, 160)}` };
  }
  if (/(cost|price|how much|allowance|rule|policy|late|dispute|partial|cycle)/.test(lower) && !/\bmy\b/.test(lower)) {
    if (n === 0) return call("search_billing_documentation", { query: text }, 1);
    const hit = results[0].results?.[0];
    return { role: "assistant", content: hit ? `${hit.excerpt.slice(0, 240)} (Source: ${hit.reference})` : "I could not find that in the billing guide." };
  }
  if (/(bill|balance|owe)/.test(lower)) {
    if (n === 0) return call("query_bill", { month, year }, 1);
    const r = results[0];
    return { role: "assistant", content: r.total !== undefined ? `Your ${month}/${year} bill: total $${r.total}, paid $${r.paidAmount}, remaining $${r.remainingBalance} (${r.status}).` : `No bill found: ${r.error?.message ?? "unknown"}` };
  }
  if (messages.at(-1).role === "tool") return { role: "assistant", content: `Done: ${messages.at(-1).content}`.slice(0, 400) };
  return { role: "assistant", content: "I can help with billing rules, your bill, usage details and payments." };
}

// A staged payment is executed by the agent after confirmation; the follow-up arrives as a tool result for pay_bill.
function finish(messages: any[]) {
  const last = messages.at(-1);
  const prevCall = [...messages].reverse().find((m) => m.role === "assistant" && m.tool_calls)?.tool_calls?.[0]?.function?.name;
  if (last.role === "tool" && prevCall === "pay_bill") {
    const r = JSON.parse(last.content);
    if (r.status === "SUCCESS") return { role: "assistant", content: `Payment recorded: $${r.paidAmount} paid, remaining balance $${r.remainingBalance} (${r.billStatus}).` };
    if (r.httpStatus && r.httpStatus >= 400 && r.error) return { role: "assistant", content: `The payment was rejected: ${r.error.code} - ${r.error.message}` };
  }
  return null;
}

createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const message = finish(body.messages) ?? respond(body.messages);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: (message as any).tool_calls ? "tool_calls" : "stop" }] }));
  });
}).listen(port, () => console.error(`[mock-llm] listening on :${port} (TEST DOUBLE)`));
