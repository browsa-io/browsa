'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeOperationError } = require('n8n-workflow');

const { Browsa } = require('../dist/nodes/Browsa/Browsa.node.js');
const { makeContext } = require('./helpers');

const node = new Browsa();
const run = (ctx) => node.execute.call(ctx);

const finishedRobotRun = {
	id: 'rr-1',
	robot_id: 'robot-1',
	status: 'partial',
	trigger: 'api',
	rows_total: 2,
	rows_ok: 1,
	rows_failed: 1,
	credits: 4,
	finished_at: '2026-11-18T08:01:00Z',
	rows: [
		{ row_index: 0, input: { asin: 'A1' }, status: 'ok', output: { price: 19.99 } },
		{
			row_index: 1,
			input: { asin: 'A2' },
			status: 'failed',
			output: null,
			error_code: 'blocked',
			error_message: 'bot wall',
		},
	],
};

test('the node offers Robot and Recipe resources, alphabetized, default still Task', () => {
	const resource = node.description.properties.find((p) => p.name === 'resource');
	assert.deepEqual(
		resource.options.map((o) => o.value),
		['job', 'page', 'recipe', 'robot', 'task'],
	);
	assert.equal(resource.default, 'task');
	assert.ok(node.methods.listSearch.searchRobots);
	assert.ok(node.methods.listSearch.searchRecipes);
});

test('Robot > Run with rows posts them, waits on the run and returns it simplified', async () => {
	const ctx = makeContext({
		params: {
			resource: 'robot',
			operation: 'run',
			robotId: { mode: 'list', value: 'robot-1' },
			inputsSource: 'rows',
			robotInputs: '[{"asin": "A1"}, {"asin": "A2"}]',
			waitForResult: true,
			timeout: 60,
			simplify: true,
			robotOutput: 'run',
			options: {},
		},
		responses: [{ id: 'rr-1', robot_id: 'robot-1', status: 'queued' }, finishedRobotRun],
	});
	const [out] = await run(ctx);
	const post = ctx.calls[0].request;
	assert.equal(post.method, 'POST');
	assert.equal(post.url, '/v1/robots/robot-1/run');
	assert.deepEqual(post.body, { inputs: [{ asin: 'A1' }, { asin: 'A2' }] });
	const get = ctx.calls[1].request;
	assert.equal(get.url, '/v1/robot-runs/rr-1');
	assert.equal(get.qs.wait, 30);
	assert.equal(out.length, 1);
	assert.equal(out[0].json.status, 'partial');
	assert.equal(out[0].json.rows_ok, 1);
	assert.equal(out[0].json.rows.length, 2);
	assert.equal(out[0].json.rows[1].error_code, 'blocked');
	assert.deepEqual(out[0].pairedItem, { item: 0 });
});

test('Robot > Run on saved inputs sends no inputs; One Item per Row splits the rows', async () => {
	const ctx = makeContext({
		params: {
			resource: 'robot',
			operation: 'run',
			robotId: { mode: 'id', value: 'robot-1' },
			inputsSource: 'saved',
			waitForResult: true,
			timeout: 60,
			simplify: true,
			robotOutput: 'rows',
			options: {},
		},
		responses: [{ ...finishedRobotRun, status: 'completed' }],
	});
	const [out] = await run(ctx);
	assert.deepEqual(ctx.calls[0].request.body, {});
	assert.equal(ctx.calls.length, 1, 'a run that is already finished is not polled');
	assert.equal(out.length, 2);
	assert.deepEqual(out[0].json.output, { price: 19.99 });
	assert.equal(out[0].json.robot_run_id, 'rr-1');
	assert.equal(out[1].json.status, 'failed');
});

test('Robot > Run without waiting returns the queued run at once', async () => {
	const ctx = makeContext({
		params: {
			resource: 'robot',
			operation: 'run',
			robotId: 'robot-1',
			inputsSource: 'saved',
			waitForResult: false,
		},
		responses: [{ id: 'rr-9', status: 'queued' }],
	});
	const [out] = await run(ctx);
	assert.equal(ctx.calls.length, 1);
	assert.equal(out[0].json.id, 'rr-9');
});

test('Robot > Run stops on a partial run when asked to', async () => {
	const ctx = makeContext({
		params: {
			resource: 'robot',
			operation: 'run',
			robotId: { mode: 'list', value: 'robot-1' },
			inputsSource: 'saved',
			waitForResult: true,
			timeout: 60,
			options: { stopOnUnsuccessful: true },
		},
		responses: [finishedRobotRun],
	});
	await assert.rejects(run(ctx), (err) => {
		assert.ok(err instanceof NodeOperationError);
		assert.match(err.message, /ended with status 'partial'/);
		return true;
	});
});

test('Robot > Run refuses rows that are not objects', async () => {
	const ctx = makeContext({
		params: {
			resource: 'robot',
			operation: 'run',
			robotId: { mode: 'list', value: 'robot-1' },
			inputsSource: 'rows',
			robotInputs: '["A1"]',
			waitForResult: false,
		},
	});
	await assert.rejects(run(ctx), /must be an object/);
	assert.equal(ctx.calls.length, 0);
});

test('Robot > Get Run reads the run once without waiting', async () => {
	const ctx = makeContext({
		params: {
			resource: 'robot',
			operation: 'getRun',
			robotRunId: 'rr-1',
			waitForCompletion: false,
			robotOutput: 'run',
		},
		responses: [finishedRobotRun],
	});
	const [out] = await run(ctx);
	assert.equal(ctx.calls[0].request.url, '/v1/robot-runs/rr-1');
	assert.equal(ctx.calls[0].request.qs, undefined);
	assert.equal(out[0].json.credits, 4);
});

test('Recipe > Run sends params with wait and returns the simplified run', async () => {
	const ctx = makeContext({
		params: {
			resource: 'recipe',
			operation: 'run',
			recipeId: { mode: 'list', value: 'rec-1' },
			recipeParams: '{"query": "air fryer"}',
			waitForResult: true,
			timeout: 120,
			simplify: true,
			options: {},
		},
		responses: [
			{
				id: 'run-1',
				recipe_id: 'rec-1',
				version: 3,
				status: 'ok',
				output: { items: [{ title: 'Air fryer', price: 49 }] },
				layers: [{ step: 's2', layer: 1 }],
				repaired: false,
				duration_ms: 4200,
				credits: 2,
			},
		],
	});
	const [out] = await run(ctx);
	const post = ctx.calls[0].request;
	assert.equal(post.url, '/v1/recipes/rec-1/run');
	assert.deepEqual(post.body, { params: { query: 'air fryer' }, wait: 60 });
	assert.equal(ctx.calls.length, 1);
	assert.equal(out[0].json.status, 'ok');
	assert.equal(out[0].json.layers, undefined);
	assert.deepEqual(out[0].json.output.items[0], { title: 'Air fryer', price: 49 });
});

test('Recipe > Run keeps polling a run that was still running after the first wait', async () => {
	const ctx = makeContext({
		params: {
			resource: 'recipe',
			operation: 'run',
			recipeId: 'rec-1',
			recipeParams: {},
			waitForResult: true,
			timeout: 30,
			simplify: false,
			options: {},
		},
		responses: [
			{ id: 'run-2', status: 'running' },
			{ id: 'run-2', status: 'failed', error_code: 'blocked', error_message: 'bot wall' },
		],
	});
	const [out] = await run(ctx);
	assert.deepEqual(ctx.calls[0].request.body, { params: {}, wait: 30 });
	assert.equal(ctx.calls[1].request.url, '/v1/recipe-runs/run-2');
	assert.equal(out[0].json.error_code, 'blocked');
});

test('Recipe > Run with On Timeout = Return the Run marks the run', async () => {
	const ctx = makeContext({
		params: {
			resource: 'recipe',
			operation: 'run',
			recipeId: 'rec-1',
			recipeParams: '{}',
			waitForResult: true,
			timeout: 0,
			options: { onTimeout: 'return' },
		},
		responses: [
			{ id: 'run-3', status: 'running' },
			{ id: 'run-3', status: 'running' },
		],
	});
	const [out] = await run(ctx);
	assert.equal(out[0].json.wait_timed_out, true);
	assert.equal(out[0].json.status, 'running');
});

test('the robot list search filters by name', async () => {
	const ctx = makeContext({
		responses: [
			{
				robots: [
					{ id: 'r1', name: 'Price watch' },
					{ id: 'r2', name: 'Stock check' },
				],
			},
		],
	});
	const res = await node.methods.listSearch.searchRobots.call(ctx, 'price');
	assert.equal(ctx.calls[0].request.url, '/v1/robots');
	assert.deepEqual(res.results, [{ name: 'Price watch', value: 'r1' }]);
});
