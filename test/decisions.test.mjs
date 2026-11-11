import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionsClient, DecisionError } from '../dist/index.js';
const env = { OPENAI_API_KEY: 'test-provider', HANDRAIL_AI_RUNTIME_TOKEN: 'test-telemetry', HANDRAIL_AI_RUNTIME_TELEMETRY_URL: 'https://telemetry.example', HANDRAIL_AI_RUNTIME_ORG_ID: 'org', HANDRAIL_AI_RUNTIME_PROJECT_ID: 'project', HANDRAIL_AI_RUNTIME_SERVICE_ENV_ID: 'service-env' };
const request = { input: 'Private ticket text', questions: [{ type: 'predicate', name: 'urgent', instructions: 'Needs immediate attention?' }] };
function harness({ failure = false, unavailable = false, outboxFailure = false, refusal = false } = {}) {
  const saved = new Map(), delivered = new Set(), telemetry = [], calls = [];
  const outbox = {
    async enqueue(entry) { if(outboxFailure) throw Error('disk unavailable'); saved.set(entry.receipt.usage_receipt_id, entry); },
    async pending(limit) { return [...saved.values()].filter(e => !delivered.has(e.receipt.usage_receipt_id)).slice(0, limit); },
    async acknowledge(id) { delivered.add(id); }, async failed() {},
  };
  const client = createDecisionsClient({ env, outbox, fetch: async (url, init) => {
    if (url.includes('/decisions')) {
      calls.push(JSON.parse(init.body));
      if (failure) return new Response('{}', {status:503});
      return Response.json({model:'gpt-6-luna', answers:[refusal ? {type:'refusal',name:'urgent'} : {type:'predicate',name:'urgent',probability:0.9}], usage:{input_tokens:100,output_tokens:0,total_tokens:100,input_tokens_details:{cached_tokens:20,cache_write_tokens:30},output_tokens_details:{reasoning_tokens:0}}});
    }
    assert.equal(url, 'https://telemetry.example/api/ai-usage/v1/receipts');
    telemetry.push(JSON.parse(init.body));
    if (unavailable) return new Response('{}', {status:503});
    return Response.json({accepted_count:1,duplicate_count:0});
  }});
  return {client,saved,delivered,telemetry,calls};
}
test('provider usage enters durable outbox and standard telemetry without ticket contents',async()=>{
  const h=harness(); const {receipt}=await h.client.decide(request,{logicalRequestId:'task-1'});
  await h.client.flushUsage();
  assert.equal(receipt.provider_id,'openai.decisions');
  assert.deepEqual(receipt.tokens.input_tokens,{status:'reported',value:100});
  assert.deepEqual(receipt.tokens.cache_write_input_tokens,{status:'reported',value:30});
  assert.equal(h.saved.size,1); assert.equal(h.delivered.size,1);
  assert.equal(h.telemetry[0].service_env_id,'service-env');
  assert.ok(!JSON.stringify(h.telemetry).includes('Private ticket'));
  assert.ok(!JSON.stringify(h.telemetry).includes('test-provider'));
});
test('telemetry outage retains the same receipt and does not repeat provider calls',async()=>{
  const h=harness({unavailable:true}); await h.client.decide(request,{logicalRequestId:'task-2'}); await h.client.flushUsage();
  assert.equal(h.calls.length,1); assert.equal(h.saved.size,1); assert.equal(h.delivered.size,0);
  assert.equal(new Set(h.telemetry.map(t=>t.receipts[0].usage_receipt_id)).size,1);
});
test('provider errors record unavailable usage rather than inventing zero tokens',async()=>{
  const h=harness({failure:true});
  await assert.rejects(h.client.decide(request,{logicalRequestId:'task-3'}),e=>e instanceof DecisionError && e.status===503);
  const receipt=[...h.saved.values()][0].receipt;
  assert.equal(receipt.terminal_status,'failed'); assert.deepEqual(receipt.tokens.input_tokens,{status:'unavailable'});
  assert.equal(h.calls.length,1);
});
test('refusals are returned and metered',async()=>{
  const h=harness({refusal:true}); const {decision}=await h.client.decide(request,{logicalRequestId:'task-4'});
  assert.equal(decision.answers[0].type,'refusal'); assert.equal(h.saved.size,1);
});
test('persistence failure exposes recoverable receipt and does not repeat provider',async()=>{
  const h=harness({outboxFailure:true});
  await assert.rejects(h.client.decide(request,{logicalRequestId:'task-5'}),e=>e.code==='usage_persistence_failed' && e.receipt.tokens.input_tokens.value===100);
  assert.equal(h.calls.length,1);
});
test('invalid local requests and missing runtime credentials never call provider',async()=>{
  const h=harness(); await assert.rejects(h.client.decide({...request,questions:[]},{logicalRequestId:'task-6'})); assert.equal(h.calls.length,0);
  assert.throws(()=>createDecisionsClient({env:{OPENAI_API_KEY:'present'},outbox:{}}),/HANDRAIL_AI_RUNTIME/);
});
