'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
	crawlPagesToItems,
	describeEnvelope,
	findErrorEnvelope,
	isUnsuccessful,
	resultOf,
	simplifyJob,
	splitList,
	waitForJob,
} = require('../dist/nodes/Browsa/GenericFunctions.js');
const { makeContext, apiFailure } = require('./helpers');

test('simplifyJob keeps at most 10 fields and surfaces the outcome', () => {
	const job = {
		id: 'j1',
		kind: 'task',
		status: 'completed',
		outcome: 'failed',
		outcome_message: 'The agent reported that it could not do the task.',
		result: { final_result: 'no', success: false },
		credits_charged: 3,
		duration_ms: 1200,
		live_url: 'https://example.invalid/live',
		step_count: 4,
		activity: [],
	};
	const s = simplifyJob(job);
	assert.ok(Object.keys(s).length <= 10);
	assert.equal(s.id, 'j1');
	assert.equal(s.status, 'completed');
	assert.equal(s.outcome, 'failed');
	assert.equal(s.result, 'no');
	assert.equal(s.error_code, null);
});

test('resultOf prefers structured_output, then final_result, then the raw result', () => {
	assert.deepEqual(
		resultOf({ kind: 'task', result: { structured_output: { a: 1 }, final_result: '{"a":1}' } }),
		{ a: 1 },
	);
	assert.equal(resultOf({ kind: 'task', result: { final_result: 'text' } }), 'text');
	assert.deepEqual(resultOf({ kind: 'crawl', result: { pages: [] } }), { pages: [] });
	assert.equal(resultOf({ kind: 'task' }), null);
});

test('isUnsuccessful: a completed job with a failed outcome counts, a running one does not', () => {
	assert.equal(isUnsuccessful({ status: 'completed', outcome: 'completed' }), false);
	assert.equal(isUnsuccessful({ status: 'completed', outcome: 'failed' }), true);
	assert.equal(isUnsuccessful({ status: 'completed', outcome: 'step_limit_reached' }), true);
	assert.equal(isUnsuccessful({ status: 'failed', outcome: 'never_started' }), true);
	assert.equal(isUnsuccessful({ status: 'running', outcome: null }), false);
});

test('splitList takes commas and new lines', () => {
	assert.deepEqual(splitList('a.com, b.com\n*.c.com,,'), ['a.com', 'b.com', '*.c.com']);
	assert.deepEqual(splitList(''), []);
	assert.deepEqual(splitList(undefined), []);
});

test('findErrorEnvelope reads the Browsa envelope from what n8n throws', () => {
	const env = { error: 'Not enough credits', code: 'INSUFFICIENT_CREDIT', request_id: 'req_1' };
	assert.deepEqual(findErrorEnvelope(apiFailure(402, env)), env);
	const raw = new Error('x');
	raw.response = { status: 429, data: { error: 'busy', code: 'TOO_MANY_REQUESTS', request_id: 'r2' } };
	assert.equal(findErrorEnvelope(raw).code, 'TOO_MANY_REQUESTS');
	assert.equal(findErrorEnvelope(new Error('network down')), undefined);
});

test('describeEnvelope names the code, a hint and the request id', () => {
	const d = describeEnvelope({ error: 'Not enough credits', code: 'INSUFFICIENT_CREDIT', request_id: 'req_9' });
	assert.match(d.message, /INSUFFICIENT_CREDIT/);
	assert.match(d.description, /dashboard\/credits/);
	assert.match(d.description, /req_9/);
});

test('crawlPagesToItems makes one item per page', () => {
	const items = crawlPagesToItems({
		id: 'c1',
		result: {
			pages: [
				{ url: 'https://a.example/', status: 'completed', data: { markdown: '# A', http_status: 200 } },
				{ url: 'https://a.example/x', status: 'failed', error_code: 'TARGET_UNREACHABLE' },
			],
		},
	});
	assert.equal(items.length, 2);
	assert.equal(items[0].markdown, '# A');
	assert.equal(items[0].job_id, 'c1');
	assert.equal(items[1].error_code, 'TARGET_UNREACHABLE');
});

test('waitForJob long-polls until the job ends', async () => {
	const ctx = makeContext({
		responses: [
			{ id: 'j1', status: 'running' },
			{ id: 'j1', status: 'completed', outcome: 'completed' },
		],
	});
	const { job, timedOut } = await waitForJob.call(ctx, 'j1', 60, 0, 0);
	assert.equal(timedOut, false);
	assert.equal(job.status, 'completed');
	assert.equal(ctx.calls.length, 2);
	assert.equal(ctx.calls[0].request.url, '/v1/jobs/j1');
	assert.ok(ctx.calls[0].request.qs.wait >= 1 && ctx.calls[0].request.qs.wait <= 30);
	assert.equal(ctx.calls[0].credentialType, 'browsaApi');
});

test('waitForJob stops waiting for a task that asks for input', async () => {
	const ctx = makeContext({ responses: [{ id: 'j1', status: 'input_required', input_question: 'Which size?' }] });
	const { job, timedOut } = await waitForJob.call(ctx, 'j1', 60, 0, 0);
	assert.equal(timedOut, false);
	assert.equal(job.input_question, 'Which size?');
});

test('waitForJob reports a timeout', async () => {
	const ctx = makeContext({ responses: [{ id: 'j1', status: 'running' }] });
	const { timedOut } = await waitForJob.call(ctx, 'j1', 0, 0, 0);
	assert.equal(timedOut, true);
});
