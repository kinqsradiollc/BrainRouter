/**
 * ADR-061 D6 — our own System One tier, asked so it cannot answer wrongly.
 *
 * The property under test is not "the model is right" — no test can assert
 * that. It is that the QUESTION constrains the answer: the schema admits
 * exactly what the question admits, and anything that gets through anyway is
 * rejected by the port rather than becoming a new outcome.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LLMConfig } from '../config/config.js';
import { createDecisionPort } from '../decision/port.js';
import {
  ANSWER_TOOL_NAME,
  buildAnswerSchema,
  createLocalDecisionProvider,
  parseFirstJsonObject,
  readAnswers,
  serializeState,
  type DecisionModelCall,
} from '../decision/providers/local.js';
import type { DecisionQuestion } from '../decision/types.js';

const llm: LLMConfig = { provider: 'openai', model: 'small-1', apiKey: 'k' } as LLMConfig;

const QUESTIONS: Record<string, DecisionQuestion> = {
  risky: { kind: 'noul', instructions: 'Is this risky?', rulesAnswer: 0 },
  team: {
    kind: 'choice',
    instructions: 'Who handles it?',
    options: { billing: 'money problems', technical: 'bugs' },
    rulesAnswer: 'billing',
  },
  progress: {
    kind: 'score',
    instructions: 'How much progress?',
    levels: ['none', 'some', 'substantial'],
    rulesAnswer: 'some',
  },
};

/** A transport that records what it was asked and replies with a tool call. */
function transport(payload: unknown, capture?: { seen?: any }): DecisionModelCall {
  return async (_llm, messages, tools, options) => {
    if (capture) capture.seen = { messages, tools, options };
    return { toolCalls: [{ function: { name: ANSWER_TOOL_NAME, arguments: JSON.stringify(payload) } }] };
  };
}

test('the schema admits exactly what each question admits, and nothing else', () => {
  const schema = buildAnswerSchema(QUESTIONS) as any;
  assert.deepEqual(schema.required.sort(), ['progress', 'risky', 'team']);
  assert.equal(schema.additionalProperties, false);

  const noul = schema.properties.risky.properties.answer;
  assert.equal(noul.type, 'number');
  assert.equal(noul.minimum, 0);
  assert.equal(noul.maximum, 1);

  const choice = schema.properties.team.properties.answer;
  assert.deepEqual(choice.enum, ['billing', 'technical'], 'the options ARE the enum');
  assert.match(choice.description, /"billing" — money problems; "technical" — bugs/,
    'the criteria ride with the key, or the enum is a guess');

  const score = schema.properties.progress.properties.answer;
  assert.deepEqual(score.enum, ['none', 'some', 'substantial']);
  assert.match(score.description, /lowest to highest/);

  for (const id of ['risky', 'team', 'progress']) {
    assert.deepEqual(schema.properties[id].required, ['answer'], `${id}: confidence is optional, the answer is not`);
  }
});

test('the model is forced to call the one tool, with the state bounded into the prompt', async () => {
  const capture: { seen?: any } = {};
  const provider = createLocalDecisionProvider({
    llm,
    maxStateChars: 100,
    call: transport({ risky: { answer: 0.9, confidence: 0.7 } }, capture),
  });
  await provider.answer('x'.repeat(5_000), { risky: QUESTIONS.risky! }, new AbortController().signal);

  assert.equal(capture.seen.tools.length, 1, 'one tool, so there is nothing else to call');
  // The transport's INTERNAL shape — {name, description, inputSchema} — which it
  // wraps into the wire format itself. This assertion was written the other way
  // round at first, matching the code, and both were wrong together; the
  // wire-level test at the bottom of this file is what settles it.
  assert.equal(capture.seen.tools[0].name, ANSWER_TOOL_NAME);
  assert.equal(capture.seen.tools[0].inputSchema.properties.risky.properties.answer.type, 'number');
  assert.deepEqual(capture.seen.options.tool_choice, { type: 'function', function: { name: ANSWER_TOOL_NAME } });
  assert.ok(capture.seen.options.maxResponseBytes > 0, 'a classifier reply is bounded');
  assert.ok(capture.seen.options.signal, 'the port\'s timeout has to reach the transport');

  const user = capture.seen.messages.find((m: any) => m.role === 'user');
  assert.ok(user.content.length < 200, `state bounded here too, got ${user.content.length}`);
  assert.match(user.content, /^STATE:/);
});

test('answers and confidence come back through the port, typed', async () => {
  const port = createDecisionPort({
    provider: createLocalDecisionProvider({
      llm,
      call: transport({
        risky: { answer: 0.92, confidence: 0.61 },
        team: { answer: 'technical' },
        progress: { answer: 'none', confidence: 0.4 },
      }),
    }),
  });
  const answers = await port.ask({ command: 'npm publish' }, QUESTIONS);
  assert.equal(answers.risky!.value, 0.92);
  assert.equal(answers.risky!.confidence, 0.61);
  assert.equal(answers.risky!.provider, 'local');
  assert.equal(answers.team!.value, 'technical');
  assert.equal(answers.progress!.value, 'none');
  assert.equal(answers.progress!.confidence, 0.4);
  for (const answer of Object.values(answers)) assert.equal(answer.fellBack, undefined);
});

test('an answer the question never admitted becomes the floor, with the reason recorded', async () => {
  const port = createDecisionPort({
    provider: createLocalDecisionProvider({
      llm,
      call: transport({
        risky: { answer: 85 },            // a percentage, not a probability
        team: { answer: 'legal' },         // an option nobody offered
        progress: { answer: 'excellent' }, // a level nobody offered
      }),
    }),
  });
  const answers = await port.ask('s', QUESTIONS);
  assert.equal(answers.risky!.value, 0, 'the rules floor, not a clamped 1.0');
  assert.match(answers.risky!.fellBack ?? '', /outside \[0,1\]/);
  assert.equal(answers.team!.value, 'billing');
  assert.match(answers.team!.fellBack ?? '', /"legal" is not one of: billing, technical/);
  assert.equal(answers.progress!.value, 'some');
  assert.match(answers.progress!.fellBack ?? '', /"excellent" is not one of/);
  for (const answer of Object.values(answers)) assert.equal(answer.provider, 'rules');
});

test('a model that answers in prose instead of calling the tool is still read', async () => {
  const provider = createLocalDecisionProvider({
    llm,
    call: async () => ({
      content: 'Sure! Here you go:\n```json\n{"risky": {"answer": 0.2}}\n```\nHope that helps.',
    }),
  });
  const raw = await provider.answer('s', { risky: QUESTIONS.risky! }, new AbortController().signal);
  assert.deepEqual(raw.risky, { kind: 'noul', value: 0.2 });
});

test('a model that says nothing usable is a provider failure, not a silent zero', async () => {
  const port = createDecisionPort({
    provider: createLocalDecisionProvider({ llm, call: async () => ({ content: 'I cannot help with that.' }) }),
  });
  const answers = await port.ask('s', { risky: QUESTIONS.risky! });
  assert.equal(answers.risky!.value, 0);
  assert.match(answers.risky!.fellBack ?? '', /local failed: the model returned no structured answer/);
});

test('a flattened answer is tolerated; a missing one is left to the floor', () => {
  const read = readAnswers(QUESTIONS, { risky: 0.3, team: { answer: 'billing' } });
  assert.deepEqual(read.risky, { kind: 'noul', value: 0.3 }, 'a bare value is still an answer');
  assert.deepEqual(read.team, { kind: 'choice', value: 'billing' });
  assert.equal('progress' in read, false, 'an unanswered question is the port\'s to floor, not ours to invent');
  assert.equal('risky' in readAnswers(QUESTIONS, { risky: { answer: null } }), false);
});

test('the JSON reader survives fences, prose, and braces inside strings', () => {
  assert.deepEqual(parseFirstJsonObject('noise {"a": "} not the end {", "b": 1} tail'), { a: '} not the end {', b: 1 });
  assert.equal(parseFirstJsonObject('no object here'), undefined);
  assert.equal(parseFirstJsonObject('{"unterminated": '), undefined);
  assert.equal(parseFirstJsonObject('[1,2,3]'), undefined, 'an array is not an answer payload');
});

test('a structured state is serialized and bounded, never sent whole', () => {
  const state = serializeState({ calls: Array.from({ length: 50 }, (_, i) => ({ tool: `t${i}` })) }, 200);
  assert.ok(state.length <= 201, `got ${state.length}`);
  assert.ok(state.endsWith('…'), 'truncation is visible to the model, not silent');
  assert.equal(serializeState('short', 8_000), 'short');
});

// ---------------------------------------------------------------------------
// The test above this line injects the transport, which is exactly why it
// could not catch what this one does: the tool spec handed to `callOpenAI` is
// the transport's INTERNAL shape, and it wraps that into the wire format
// itself. A pre-wrapped OpenAI spec produces a NAMELESS tool with an empty
// schema on the wire — no error, no warning, just a model that is suddenly
// free to answer anything. The entire "cannot be creative" property lives in
// bytes this suite was not looking at, so this one looks at them.
// ---------------------------------------------------------------------------

test('the schema reaches the wire, and a real tool call comes back through the port', async () => {
  const http = await import('node:http');
  let sent: any;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      sent = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 1, model: 'small-1',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 't1',
              type: 'function',
              function: { name: 'answer', arguments: JSON.stringify({ risky: { answer: 0.91, confidence: 0.64 } }) },
            }],
          },
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port: tcpPort } = server.address() as { port: number };
  try {
    const decisionPort = createDecisionPort({
      provider: createLocalDecisionProvider({
        llm: { ...llm, endpoint: `http://127.0.0.1:${tcpPort}/v1` } as LLMConfig,
      }),
    });
    const answers = await decisionPort.ask({ command: 'npm publish' }, { risky: QUESTIONS.risky! });

    const tool = sent.tools?.[0];
    assert.equal(tool?.function?.name, ANSWER_TOOL_NAME, 'a nameless tool is a tool the model cannot be made to call');
    assert.deepEqual(sent.tool_choice, { type: 'function', function: { name: ANSWER_TOOL_NAME } });
    const answerSchema = tool.function.parameters?.properties?.risky?.properties?.answer;
    assert.equal(answerSchema?.type, 'number', 'the bound has to be ON THE WIRE, not just in our object');
    assert.equal(answerSchema.minimum, 0);
    assert.equal(answerSchema.maximum, 1);
    assert.match(sent.messages.find((m: any) => m.role === 'user').content, /^STATE:/);

    assert.equal(answers.risky!.value, 0.91);
    assert.equal(answers.risky!.confidence, 0.64);
    assert.equal(answers.risky!.provider, 'local');
    assert.equal(answers.risky!.fellBack, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
