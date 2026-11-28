'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');

const { Browsa } = require('../dist/nodes/Browsa/Browsa.node.js');
const { BrowsaApi } = require('../dist/credentials/BrowsaApi.credentials.js');
const { makeContext, apiFailure } = require('./helpers');

const node = new Browsa();
const run = (ctx) => node.execute.call(ctx);

test('the node is usable as an AI tool and has the Browsa credential', () => {
	assert.equal(node.description.usableAsTool, true);
	assert.deepEqual(node.description.credentials, [{ name: 'browsaApi', required: true }]);
});

test('the credential sends X-API-Key and tests with GET /v1/credits', () => {
	const cred = new BrowsaApi();
	assert.equal(cred.name, 'browsaApi');
	assert.equal(cred.authenticate.properties.headers['X-API-Key'], '={{$credentials.apiKey}}');
	// Browsa counts calls per client and version.
	const { version } = require('../package.json');
	assert.equal(cred.authenticate.properties.headers['User-Agent'], `n8n-nodes-browsa/${version}`);
	assert.equal(cred.test.request.baseURL, 'https://browsa.io');
	assert.equal(cred.test.request.url, '/v1/credits');
	assert.equal(cred.test.request.method, 'GET');
	assert.equal(cred.properties[0].typeOptions.password, true);
});

test('Task > Run on a hosted tier waits and surfaces a failed outcome', async () => {
	const ctx = makeContext({
		params: {
			resource: 'task',
			operation: 'run',
			task: 'Return the top story',
			model: 'browsa-smart',
			waitForResult: true,
			timeout: 60,
			simplify: true,
			options: {
				outputSchema: '{"type":"object","properties":{"title":{"type":"string"}}}',
				allowedDomains: 'news.ycombinator.com',
				maxSteps: 10,
			},
		},
		responses: [
			{ job_id: 'job-1', status: 'queued', kind: 'task' },
			{
				id: 'job-1',
				kind: 'task',
				status: 'completed',
				outcome: 'failed',
				outcome_message: 'The agent could not find the story.',
				result: { final_result: 'not found', success: false },
				credits_charged: 2,
			},
		],
	});
	const [out] = await run(ctx);
	const post = ctx.calls[0].request;
	assert.equal(post.method, 'POST');
	assert.equal(post.url, '/v1/tasks');
	assert.equal(post.baseURL, 'https://browsa.io');
	assert.equal(post.body.llm, 'browsa-smart');
	assert.equal(post.body.llm_api_key, undefined);
	assert.equal(post.body.max_steps, 10);
	assert.deepEqual(post.body.allowed_domains, ['news.ycombinator.com']);
	assert.deepEqual(post.body.output_schema, { type: 'object', properties: { title: { type: 'string' } } });
	assert.equal(ctx.calls[1].request.url, '/v1/jobs/job-1');
	assert.equal(out.length, 1);
	assert.equal(out[0].json.status, 'completed');
	assert.equal(out[0].json.outcome, 'failed');
	assert.equal(out[0].json.result, 'not found');
	assert.deepEqual(out[0].pairedItem, { item: 0 });
});

test('Task > Run with "Stop on Unsuccessful Outcome" stops on a failed outcome', async () => {
	const ctx = makeContext({
		params: {
			resource: 'task',
			operation: 'run',
			task: 't',
			model: 'browsa',
			waitForResult: true,
			timeout: 60,
			options: { stopOnUnsuccessful: true },
		},
		responses: [
			{ job_id: 'job-2', status: 'queued' },
			{ id: 'job-2', kind: 'task', status: 'completed', outcome: 'step_limit_reached', outcome_message: 'Used all steps.' },
		],
	});
	await assert.rejects(run(ctx), (e) => e instanceof NodeOperationError && /step_limit_reached/.test(e.message));
});

test('Task > Run with own key sends the key and model, not a hosted tier', async () => {
	const ctx = makeContext({
		params: {
			resource: 'task',
			operation: 'run',
			task: 't',
			model: 'apiKey',
			llmApiKey: 'sk-ant-test',
			llm: 'anthropic:claude-sonnet-5-5',
			llmBaseUrl: '',
			waitForResult: false,
			options: {},
		},
		responses: [{ job_id: 'job-3', status: 'queued', status_url: 'https://browsa.io/v1/jobs/job-3/status' }],
	});
	const [out] = await run(ctx);
	const body = ctx.calls[0].request.body;
	assert.equal(body.llm_api_key, 'sk-ant-test');
	assert.equal(body.llm, 'anthropic:claude-sonnet-5-5');
	assert.equal(body.llm_base_url, undefined);
	assert.equal(ctx.calls.length, 1, 'no polling when not waiting');
	assert.equal(out[0].json.job_id, 'job-3');
});

test('Task > Run with a saved key and no ID uses the workspace default key', async () => {
	const ctx = makeContext({
		params: { resource: 'task', operation: 'run', task: 't', model: 'savedKey', llmKeyId: '', llm: '', waitForResult: false },
		responses: [{ job_id: 'job-4', status: 'queued' }],
	});
	await run(ctx);
	const body = ctx.calls[0].request.body;
	assert.equal(body.llm, undefined);
	assert.equal(body.llm_key_id, undefined);
	assert.equal(body.llm_api_key, undefined);
});

test('Task > Run returns the job with wait_timed_out when asked to', async () => {
	const ctx = makeContext({
		params: {
			resource: 'task',
			operation: 'run',
			task: 't',
			model: 'browsa',
			waitForResult: true,
			timeout: 0,
			simplify: true,
			options: { onTimeout: 'return' },
		},
		responses: [{ job_id: 'job-5', status: 'queued' }, { id: 'job-5', status: 'running' }],
	});
	const [out] = await run(ctx);
	assert.equal(out[0].json.wait_timed_out, true);
	assert.equal(out[0].json.id, 'job-5');
});

test('Task > Run stops on timeout by default and names the job ID', async () => {
	const ctx = makeContext({
		params: { resource: 'task', operation: 'run', task: 't', model: 'browsa', waitForResult: true, timeout: 0, options: {} },
		responses: [{ job_id: 'job-6', status: 'queued' }, { id: 'job-6', status: 'running' }],
	});
	await assert.rejects(run(ctx), (e) => e instanceof NodeOperationError && /job-6/.test(e.message));
});

test('Task > Run rejects an output schema that is not JSON', async () => {
	const ctx = makeContext({
		params: { resource: 'task', operation: 'run', task: 't', model: 'browsa', waitForResult: false, options: { outputSchema: '{nope' } },
	});
	await assert.rejects(run(ctx), (e) => e instanceof NodeOperationError && /Output Schema/.test(e.message));
	assert.equal(ctx.calls.length, 0);
});

test('Job > Get without waiting returns the job as is', async () => {
	const ctx = makeContext({
		params: { resource: 'job', operation: 'get', jobId: ' job-7 ', waitForCompletion: false },
		responses: [{ id: 'job-7', status: 'running', outcome: null }],
	});
	const [out] = await run(ctx);
	assert.equal(ctx.calls[0].request.method, 'GET');
	assert.equal(ctx.calls[0].request.url, '/v1/jobs/job-7');
	assert.equal(ctx.calls[0].request.qs, undefined);
	assert.equal(out[0].json.status, 'running');
});

test('Page > Scrape sends formats and moves a screenshot into binary data', async () => {
	const png = Buffer.from('fake-png').toString('base64');
	const ctx = makeContext({
		params: {
			resource: 'page',
			operation: 'scrape',
			url: 'https://example.com',
			formats: ['markdown', 'screenshot'],
			options: { waitMs: 1000, block: ['image'] },
		},
		responses: [{ url: 'https://example.com/', markdown: '# Example', screenshot_png_b64: png, cost_credits: 1 }],
	});
	const [out] = await run(ctx);
	const req = ctx.calls[0].request;
	assert.equal(req.url, '/v1/quick/scrape');
	assert.deepEqual(req.body, {
		url: 'https://example.com',
		formats: ['markdown', 'screenshot'],
		wait_ms: 1000,
		block: ['image'],
	});
	assert.equal(out[0].json.markdown, '# Example');
	assert.equal(out[0].json.screenshot_png_b64, undefined);
	assert.equal(out[0].binary.data.mimeType, 'image/png');
	assert.equal(out[0].binary.data.data, png);
});

test('Page > Extract Data with a schema and no model key', async () => {
	const ctx = makeContext({
		params: {
			resource: 'page',
			operation: 'extract',
			url: 'https://example.com',
			extractMode: 'schema',
			schema: '{"type":"object","properties":{"title":{"type":"string"}}}',
			extractModel: 'none',
			options: { llm: 'ignored-without-key' },
		},
		responses: [{ url: 'https://example.com/', text: 'Example Domain', schema: {} }],
	});
	const [out] = await run(ctx);
	const body = ctx.calls[0].request.body;
	assert.equal(ctx.calls[0].request.url, '/v1/quick/extract');
	assert.deepEqual(body.schema, { type: 'object', properties: { title: { type: 'string' } } });
	assert.equal(body.prompt, undefined);
	assert.equal(body.llm, undefined);
	assert.equal(body.llm_api_key, undefined);
	assert.equal(out[0].json.text, 'Example Domain');
});

test('Page > Extract Data with instructions and an Anthropic key', async () => {
	const ctx = makeContext({
		params: {
			resource: 'page',
			operation: 'extract',
			url: 'https://example.com',
			extractMode: 'prompt',
			prompt: 'Return the title',
			extractModel: 'apiKey',
			llmApiKey: 'sk-ant-test',
			options: {},
		},
		responses: [{ data: { title: 'Example Domain' } }],
	});
	const [out] = await run(ctx);
	const body = ctx.calls[0].request.body;
	assert.equal(body.prompt, 'Return the title');
	assert.equal(body.llm_api_key, 'sk-ant-test');
	assert.deepEqual(out[0].json.data, { title: 'Example Domain' });
});

test('Page > Take Screenshot returns binary output', async () => {
	const png = Buffer.from('png-bytes').toString('base64');
	const ctx = makeContext({
		params: { resource: 'page', operation: 'screenshot', url: 'https://example.com', fullPage: false, binaryPropertyName: 'shot', options: {} },
		responses: [{ url: 'https://example.com/', screenshot_png_b64: png, cost_credits: 1 }],
	});
	const [out] = await run(ctx);
	assert.equal(ctx.calls[0].request.url, '/v1/quick/screenshot');
	assert.equal(ctx.calls[0].request.body.full_page, false);
	assert.equal(out[0].binary.shot.fileName, 'browsa-screenshot.png');
	assert.equal(out[0].binary.shot.data, png);
	assert.equal(out[0].json.cost_credits, 1);
	assert.equal(out[0].json.screenshot_png_b64, undefined);
});

test('Page > Crawl waits and returns one item per page', async () => {
	const ctx = makeContext({
		params: {
			resource: 'page',
			operation: 'crawl',
			startUrl: 'https://example.com',
			maxPages: 2,
			crawlFormats: ['markdown'],
			waitForResult: true,
			timeout: 60,
			crawlOutput: 'pages',
			options: { maxDepth: 1, includeRegex: '/docs/' },
		},
		responses: [
			{ job_id: 'crawl-1', status: 'queued', kind: 'crawl' },
			{
				id: 'crawl-1',
				kind: 'crawl',
				status: 'completed',
				outcome: 'completed',
				result: {
					pages: [
						{ url: 'https://example.com/', status: 'completed', data: { markdown: '# Home' } },
						{ url: 'https://example.com/docs/', status: 'completed', data: { markdown: '# Docs' } },
					],
				},
			},
		],
	});
	const [out] = await run(ctx);
	const body = ctx.calls[0].request.body;
	assert.equal(ctx.calls[0].request.url, '/v1/quick/crawl');
	assert.equal(body.start_url, 'https://example.com');
	assert.equal(body.max_pages, 2);
	assert.equal(body.max_depth, 1);
	assert.equal(body.include_regex, '/docs/');
	assert.equal(out.length, 2);
	assert.equal(out[1].json.markdown, '# Docs');
	assert.deepEqual(out[1].pairedItem, { item: 0 });
});

test('a Browsa error envelope becomes a NodeApiError with the code and a hint', async () => {
	const ctx = makeContext({
		params: { resource: 'page', operation: 'scrape', url: 'https://example.com', formats: ['markdown'], options: {} },
		responses: [apiFailure(402, { error: 'Not enough credits', code: 'INSUFFICIENT_CREDIT', request_id: 'req_42' })],
	});
	await assert.rejects(run(ctx), (e) => {
		assert.ok(e instanceof NodeApiError);
		assert.match(e.message, /INSUFFICIENT_CREDIT/);
		assert.match(e.description, /req_42/);
		assert.equal(String(e.httpCode), '402');
		return true;
	});
});

test('with Continue On Fail, a failed item becomes an item with an error field', async () => {
	const ctx = makeContext({
		continueOnFail: true,
		items: [{ json: {} }, { json: {} }],
		params: { resource: 'page', operation: 'scrape', url: 'https://example.com', formats: ['markdown'], options: {} },
		responses: [
			apiFailure(429, { error: 'No free browser slot', code: 'TOO_MANY_REQUESTS', request_id: 'r' }),
			{ url: 'https://example.com/', markdown: '# ok' },
		],
	});
	const [out] = await run(ctx);
	assert.equal(out.length, 2);
	assert.match(out[0].json.error, /TOO_MANY_REQUESTS/);
	assert.deepEqual(out[0].pairedItem, { item: 0 });
	assert.equal(out[1].json.markdown, '# ok');
	assert.deepEqual(out[1].pairedItem, { item: 1 });
});
