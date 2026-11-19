'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

const { BrowsaTrigger } = require('../dist/nodes/BrowsaTrigger/BrowsaTrigger.node.js');
const {
	parseSignatureHeader,
	verifySignature,
} = require('../dist/nodes/BrowsaTrigger/Signature.js');
const { matchEvent, subscriptionEvents } = require('../dist/nodes/Browsa/GenericFunctions.js');
const { apiFailure } = require('./helpers');

const trigger = new BrowsaTrigger();
const hooks = trigger.webhookMethods.default;
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const URL = 'https://n8n.example.com/webhook/abc/webhook';

function sign(raw, t = Math.floor(Date.now() / 1000), secret = SECRET) {
	const v1 = createHmac('sha256', Buffer.from(secret, 'hex')).update(`${t}.${raw}`).digest('hex');
	return `t=${t}, v1=${v1}`;
}

// A stand-in for IHookFunctions / IWebhookFunctions.
function makeHookContext({ params = {}, responses = [], staticData = {}, request = {} } = {}) {
	const calls = [];
	const response = { statusCode: 200, body: undefined };
	return {
		calls,
		staticData,
		response,
		getNode: () => ({ name: 'Browsa Trigger', type: 'n8n-nodes-browsa.browsaTrigger' }),
		getNodeParameter: (name, fallback) =>
			Object.prototype.hasOwnProperty.call(params, name) ? params[name] : fallback,
		getNodeWebhookUrl: () => URL,
		getWorkflowStaticData: () => staticData,
		getRequestObject: () => request,
		getResponseObject: () => ({
			status(code) {
				response.statusCode = code;
				return this;
			},
			json(body) {
				response.body = body;
				return this;
			},
		}),
		getHeaderData: () => request.headers ?? {},
		getBodyData: () => request.body ?? {},
		helpers: {
			async httpRequestWithAuthentication(credentialType, req) {
				calls.push({ credentialType, request: req });
				if (responses.length === 0) throw new Error(`unexpected request ${req.method} ${req.url}`);
				const next = responses.shift();
				if (next instanceof Error) throw next;
				return typeof next === 'function' ? next(req) : next;
			},
			returnJsonArray: (items) => items.map((json) => ({ json })),
		},
	};
}

test('the trigger is named as a trigger, has no inputs and offers the six events', () => {
	const d = trigger.description;
	assert.equal(d.name, 'browsaTrigger');
	assert.match(d.displayName, /Trigger/);
	assert.deepEqual(d.inputs, []);
	assert.deepEqual(d.credentials, [{ name: 'browsaApi', required: true }]);
	const events = d.properties.find((p) => p.name === 'events');
	assert.deepEqual(events.options.map((o) => o.value).sort(), [
		'recipe.run.completed',
		'robot.alert',
		'robot.failed',
		'robot.run.completed',
		'task.completed',
		'task.needs_user',
	]);
});

test('task events subscribe under the names Browsa sends', () => {
	assert.deepEqual(subscriptionEvents(['robot.alert', 'task.completed', 'task.needs_user']), [
		'robot.alert',
		'job.completed',
		'task.needs_user',
	]);
});

test('create registers the webhook with the mapped events and keeps the signing secret', async () => {
	const ctx = makeHookContext({
		params: { events: ['robot.run.completed', 'task.completed'], options: {} },
		responses: [{ id: 'wh-1', url: URL, events: [] }, { secret: SECRET }],
	});
	assert.equal(await hooks.create.call(ctx), true);
	const post = ctx.calls[0].request;
	assert.equal(post.method, 'POST');
	assert.equal(post.url, '/v1/webhooks');
	assert.deepEqual(post.body, { url: URL, events: ['robot.run.completed', 'job.completed'] });
	assert.equal(ctx.calls[1].request.url, '/v1/webhooks/signing-secret');
	assert.equal(ctx.staticData.webhookId, 'wh-1');
	assert.equal(ctx.staticData.allEvents, false);
	assert.equal(ctx.staticData.signingSecret, SECRET);
});

test('create falls back to every event when Browsa does not know an event name yet', async () => {
	const ctx = makeHookContext({
		params: { events: ['robot.alert'], options: { checkSignature: false } },
		responses: [
			apiFailure(400, {
				error: 'unknown event "robot.alert"; use one of: job.completed',
				code: 'BAD_REQUEST',
				request_id: 'req-1',
			}),
			{ id: 'wh-2', url: URL },
		],
	});
	assert.equal(await hooks.create.call(ctx), true);
	assert.deepEqual(ctx.calls[1].request.body, { url: URL });
	assert.equal(ctx.staticData.webhookId, 'wh-2');
	assert.equal(ctx.staticData.allEvents, true);
	assert.equal(ctx.staticData.signingSecret, undefined);
});

test('create does not fall back on other errors', async () => {
	const ctx = makeHookContext({
		params: { events: ['robot.alert'], options: {} },
		responses: [
			apiFailure(400, {
				error: 'callback url rejected: resolved IP 10.0.0.1 is not a public address',
				code: 'INVALID_CALLBACK_URL',
			}),
		],
	});
	await assert.rejects(hooks.create.call(ctx), /callback url rejected/);
	assert.equal(ctx.calls.length, 1);
});

test('checkExists finds the registered webhook, and forgets a missing one', async () => {
	const found = makeHookContext({
		staticData: { webhookId: 'wh-1' },
		responses: [{ webhooks: [{ id: 'wh-1', url: URL, events: [] }] }],
	});
	assert.equal(await hooks.checkExists.call(found), true);

	const gone = makeHookContext({
		staticData: { webhookId: 'wh-1' },
		responses: [{ webhooks: [{ id: 'wh-1', url: URL, disabled_at: '2026-11-18T00:00:00Z' }] }],
	});
	assert.equal(await hooks.checkExists.call(gone), false);
	assert.equal(gone.staticData.webhookId, undefined);

	const none = makeHookContext();
	assert.equal(await hooks.checkExists.call(none), false);
	assert.equal(none.calls.length, 0);
});

test('delete removes the webhook and treats 404 as already removed', async () => {
	const ctx = makeHookContext({
		staticData: { webhookId: 'wh-1', signingSecret: SECRET },
		responses: [{}],
	});
	assert.equal(await hooks.delete.call(ctx), true);
	assert.equal(ctx.calls[0].request.method, 'DELETE');
	assert.equal(ctx.calls[0].request.url, '/v1/webhooks/wh-1');
	assert.deepEqual(ctx.staticData, {});

	const missing = makeHookContext({
		staticData: { webhookId: 'wh-9' },
		responses: [apiFailure(404, { error: 'no webhook with that id', code: 'NOT_FOUND' })],
	});
	assert.equal(await hooks.delete.call(missing), true);
});

function delivery(body, { headerFor = undefined, staticData = { signingSecret: SECRET } } = {}) {
	const raw = JSON.stringify(body);
	return {
		raw,
		staticData,
		request: {
			rawBody: Buffer.from(raw),
			body,
			headers: { 'x-agents-signature': headerFor ?? sign(raw) },
		},
	};
}

test('webhook starts the workflow for a signed, selected event', async () => {
	const body = {
		id: 'evt_rr-1_robot.alert',
		type: 'robot.alert',
		created_at: '2026-11-18T08:01:00Z',
		workspace_id: 'ws-1',
		data: { robot_id: 'robot-1', field: 'price', old: 24.99, new: 19.99 },
	};
	const d = delivery(body);
	const ctx = makeHookContext({
		params: { events: ['robot.alert'], options: {} },
		staticData: d.staticData,
		request: d.request,
	});
	const res = await trigger.webhook.call(ctx);
	assert.equal(res.workflowData[0].length, 1);
	assert.equal(res.workflowData[0][0].json.event, 'robot.alert');
	assert.equal(res.workflowData[0][0].json.data.new, 19.99);
});

test('webhook refuses a bad signature with 401 and starts nothing', async () => {
	const body = { id: 'e1', type: 'robot.alert', data: {} };
	const d = delivery(body, { headerFor: sign('{"tampered":true}') });
	const ctx = makeHookContext({
		params: { events: ['robot.alert'], options: {} },
		staticData: d.staticData,
		request: d.request,
	});
	const res = await trigger.webhook.call(ctx);
	assert.equal(res.noWebhookResponse, true);
	assert.equal(res.workflowData, undefined);
	assert.equal(ctx.response.statusCode, 401);
});

test('webhook fetches the signing secret when it has none yet', async () => {
	const body = {
		id: 'e2',
		type: 'job.completed',
		job_kind: 'task',
		data: { outcome: 'completed' },
	};
	const d = delivery(body, { staticData: {} });
	const ctx = makeHookContext({
		params: { events: ['task.completed'], options: {} },
		staticData: d.staticData,
		request: d.request,
		responses: [{ secret: SECRET }],
	});
	const res = await trigger.webhook.call(ctx);
	assert.equal(ctx.calls[0].request.url, '/v1/webhooks/signing-secret');
	assert.equal(res.workflowData[0][0].json.event, 'task.completed');
});

test('webhook acknowledges events that were not selected without starting the workflow', async () => {
	const body = { id: 'e3', type: 'job.completed', job_kind: 'scrape', data: {} };
	const d = delivery(body);
	const ctx = makeHookContext({
		params: { events: ['task.completed'], options: {} },
		staticData: d.staticData,
		request: d.request,
	});
	const res = await trigger.webhook.call(ctx);
	assert.equal(res.workflowData, undefined);
	assert.deepEqual(res.webhookResponse, { ok: true, ignored: true });
});

test('webhook skips the signature check when it is turned off', async () => {
	const body = { id: 'e4', type: 'recipe.run.completed', data: { run_id: 'run-1' } };
	const ctx = makeHookContext({
		params: { events: ['recipe.run.completed'], options: { checkSignature: false } },
		request: { body, headers: {} },
	});
	const res = await trigger.webhook.call(ctx);
	assert.equal(res.workflowData[0][0].json.data.run_id, 'run-1');
});

test('matchEvent maps task events from job events', () => {
	assert.equal(
		matchEvent(['task.completed'], { type: 'job.completed', job_kind: 'task' }),
		'task.completed',
	);
	assert.equal(matchEvent(['task.completed'], { type: 'job.failed', job_kind: 'task' }), undefined);
	assert.equal(matchEvent(['task.completed'], { type: 'task.completed' }), 'task.completed');
	assert.equal(
		matchEvent(['task.needs_user'], { type: 'job.updated', data: { status: 'input_required' } }),
		'task.needs_user',
	);
	assert.equal(matchEvent(['task.needs_user'], { type: 'task.needs_user' }), 'task.needs_user');
	assert.equal(matchEvent(['robot.failed'], { type: 'webhook.test' }), undefined);
});

test('verifySignature: valid, stale, wrong secret and malformed headers', () => {
	const raw = '{"id":"e5","type":"robot.failed"}';
	const now = 1_800_000_000;
	assert.equal(verifySignature(raw, sign(raw, now), SECRET, now), true);
	assert.equal(verifySignature(Buffer.from(raw), sign(raw, now), SECRET, now + 299), true);
	assert.equal(verifySignature(raw, sign(raw, now), SECRET, now + 301), false);
	assert.equal(verifySignature(raw, sign(raw, now, 'ff'.repeat(32)), SECRET, now), false);
	assert.equal(verifySignature(raw, 'v1=abc', SECRET, now), false);
	assert.equal(verifySignature(raw, '', SECRET, now), false);
	assert.deepEqual(parseSignatureHeader('t=1, v1=ab'), { t: '1', v1: 'ab' });
});
