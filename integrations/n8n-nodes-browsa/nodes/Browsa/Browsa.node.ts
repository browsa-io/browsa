import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	browsaApiRequest,
	crawlPagesToItems,
	isRecipeRunUnsuccessful,
	isRobotRunUnsuccessful,
	isUnsuccessful,
	jobIdOf,
	locatorValue,
	parseJsonObject,
	parseRobotInputs,
	RECIPE_RUN,
	robotRowsToItems,
	ROBOT_RUN,
	simplifyJob,
	simplifyRecipeRun,
	simplifyRobotRun,
	splitList,
	waitForJob,
	waitForRun,
} from './GenericFunctions';
import type { RunKind } from './GenericFunctions';

/*
 * Programmatic style: Run Task and Crawl make several dependent calls (submit,
 * then long-poll the job until it ends), and Screenshot turns a base64 field
 * into binary data. Declarative routing cannot express either.
 */

/** "Wait" fields shared by Run Task, Get Job and Crawl. */
function waitFields(
	resource: string,
	operation: string,
	waitDefault: boolean,
	waitName: string,
): INodeProperties[] {
	const show = { resource: [resource], operation: [operation] };
	const what = resource === 'robot' || resource === 'recipe' ? 'run' : 'job';
	const readLater =
		resource === 'robot'
			? 'Robot > Get Run'
			: resource === 'recipe'
				? 'Recipe > Get Run'
				: 'Job > Get';
	const waitDescription = `Whether to wait until the ${what} ends and return its result. Off returns at once with the ${what} ID; read it later with ${readLater}.`;
	const waitDisplayName =
		waitName === 'waitForCompletion' ? 'Wait for Completion' : 'Wait for Result';
	const waitField: INodeProperties = waitDefault
		? {
				displayName: waitDisplayName,
				name: waitName,
				type: 'boolean',
				default: true,
				displayOptions: { show },
				description: waitDescription,
			}
		: {
				displayName: waitDisplayName,
				name: waitName,
				type: 'boolean',
				default: false,
				displayOptions: { show },
				description: waitDescription,
			};
	return [
		waitField,
		{
			displayName: 'Timeout (Seconds)',
			name: 'timeout',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 600,
			displayOptions: { show: { ...show, [waitName]: [true] } },
			description: `How long to wait for the ${what} to end. The ${what} keeps running on Browsa after this time; see "On Timeout" under Options.`,
		},
		{
			displayName: 'Simplify',
			name: 'simplify',
			type: 'boolean',
			default: true,
			displayOptions: { show: { ...show, [waitName]: [true] } },
			description:
				what === 'job'
					? 'Whether to return a simplified response (ID, status, outcome, result, cost) instead of the raw job'
					: 'Whether to return a simplified response (ID, status, output, cost) instead of the raw run',
		},
	];
}

/** Options shared by every operation that waits for a job. */
const waitOptions: INodeProperties[] = [
	{
		displayName: 'On Timeout',
		name: 'onTimeout',
		type: 'options',
		default: 'stop',
		options: [
			{
				name: 'Stop the Workflow',
				value: 'stop',
				description: 'Stop with a message that names the job ID',
			},
			{
				name: 'Return the Job',
				value: 'return',
				description: 'Return the job as it is, with "wait_timed_out": true',
			},
		],
		description: 'What to do when the job has not ended within the timeout',
	},
	{
		displayName: 'Stop on Unsuccessful Outcome',
		name: 'stopOnUnsuccessful',
		type: 'boolean',
		default: false,
		description:
			"Whether to stop the workflow when the job ends with an outcome other than 'completed' (for example 'failed', 'step_limit_reached' or 'blocked_by_bot_check'). Off returns the job with its outcome.",
	},
];

/** On Timeout and Stop on Unsuccessful, worded for a robot or recipe run. */
function runWaitOptions(label: string, failedStatuses: string): INodeProperties[] {
	return [
		{
			displayName: 'On Timeout',
			name: 'onTimeout',
			type: 'options',
			default: 'stop',
			options: [
				{
					name: 'Stop the Workflow',
					value: 'stop',
					description: `Stop with a message that names the ${label} ID`,
				},
				{
					name: 'Return the Run',
					value: 'return',
					description: 'Return the run as it is, with "wait_timed_out": true',
				},
			],
			description: `What to do when the ${label} has not ended within the timeout`,
		},
		{
			displayName: 'Stop on Unsuccessful Run',
			name: 'stopOnUnsuccessful',
			type: 'boolean',
			default: false,
			description: `Whether to stop the workflow when the ${label} ends with status ${failedStatuses}. Off returns the run with its status. Failed rows and failed runs are not charged.`,
		},
	];
}

export class Browsa implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Browsa',
		name: 'browsa',
		icon: { light: 'file:../../icons/browsa.svg', dark: 'file:../../icons/browsa.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Run robots, recipes and plain-language browser tasks, and scrape, extract, screenshot or crawl pages in Phantom cloud browsers',
		defaults: {
			name: 'Browsa',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'browsaApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Job', value: 'job' },
					{ name: 'Page', value: 'page' },
					{ name: 'Recipe', value: 'recipe' },
					{ name: 'Robot', value: 'robot' },
					{ name: 'Task', value: 'task' },
				],
				// Stays 'task': n8n saves only changed parameters, so a new default
				// would change existing workflows.
				default: 'task',
			},

			// ── Robot and Recipe operations ────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['robot'] } },
				options: [
					{
						name: 'Get Run',
						value: 'getRun',
						description: 'Get the status and results of a robot run',
						action: 'Get a robot run',
					},
					{
						name: 'Run',
						value: 'run',
						description: 'Run a robot on its saved inputs or on the rows you give',
						action: 'Run a robot',
					},
				],
				default: 'run',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['recipe'] } },
				options: [
					{
						name: 'Get Run',
						value: 'getRun',
						description: 'Get the status and output of a recipe run',
						action: 'Get a recipe run',
					},
					{
						name: 'Run',
						value: 'run',
						description: 'Replay a recipe with new parameters and get its output',
						action: 'Run a recipe',
					},
				],
				default: 'run',
			},

			// ── Robot > Run ────────────────────────────────────────────────
			{
				displayName: 'Robot',
				name: 'robotId',
				type: 'resourceLocator',
				required: true,
				default: { mode: 'list', value: '' },
				displayOptions: { show: { resource: ['robot'], operation: ['run'] } },
				description: 'The robot to run',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: { searchListMethod: 'searchRobots', searchable: true },
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. 6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8',
					},
				],
			},
			{
				displayName: 'Inputs',
				name: 'inputsSource',
				type: 'options',
				default: 'saved',
				displayOptions: { show: { resource: ['robot'], operation: ['run'] } },
				options: [
					{
						name: 'Saved Inputs',
						value: 'saved',
						description: 'Run every row saved on the robot',
					},
					{
						name: 'Rows Given Here',
						value: 'rows',
						description: 'Run the rows you give in JSON instead, for this run only',
					},
				],
				description: 'Which input rows the robot runs. One run covers every row.',
			},
			{
				displayName: 'Rows (JSON)',
				name: 'robotInputs',
				type: 'json',
				required: true,
				default: '[\n  {}\n]',
				displayOptions: {
					show: { resource: ['robot'], operation: ['run'], inputsSource: ['rows'] },
				},
				description:
					'A JSON array of rows (at most 500), each an object of the robot\'s inputs, for example [{"asin": "B0C1234567"}, {"asin": "B0D7654321"}]',
			},
			...waitFields('robot', 'run', true, 'waitForResult'),
			{
				displayName: 'Output',
				name: 'robotOutput',
				type: 'options',
				default: 'run',
				displayOptions: {
					show: { resource: ['robot'], operation: ['run', 'getRun'] },
				},
				options: [
					{
						name: 'One Run Item',
						value: 'run',
						description: 'Return the run, with every row in "rows"',
					},
					{
						name: 'One Item per Row',
						value: 'rows',
						description: 'Each input row becomes its own item, with its output',
					},
				],
				description: 'How to return a finished run',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['robot'], operation: ['run', 'getRun'] } },
				options: [...runWaitOptions('robot run', "'partial' or 'failed'")],
			},

			// ── Robot > Get Run ────────────────────────────────────────────
			{
				displayName: 'Robot Run ID',
				name: 'robotRunId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. 6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8',
				displayOptions: { show: { resource: ['robot'], operation: ['getRun'] } },
				description: 'ID of a robot run, as returned by Robot > Run or the Browsa Trigger',
			},
			...waitFields('robot', 'getRun', false, 'waitForCompletion'),

			// ── Recipe > Run ───────────────────────────────────────────────
			{
				displayName: 'Recipe',
				name: 'recipeId',
				type: 'resourceLocator',
				required: true,
				default: { mode: 'list', value: '' },
				displayOptions: { show: { resource: ['recipe'], operation: ['run'] } },
				description: 'The recipe to replay',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: { searchListMethod: 'searchRecipes', searchable: true },
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. 6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8',
					},
				],
			},
			{
				displayName: 'Parameters',
				name: 'recipeParams',
				type: 'json',
				required: true,
				default: '{}',
				displayOptions: { show: { resource: ['recipe'], operation: ['run'] } },
				description:
					'The recipe\'s parameters as a JSON object, for example {"query": "air fryer"}. They are checked against the recipe\'s parameter schema.',
			},
			...waitFields('recipe', 'run', true, 'waitForResult'),
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['recipe'], operation: ['run', 'getRun'] } },
				options: [...runWaitOptions('recipe run', "'failed' or 'cancelled'")],
			},

			// ── Recipe > Get Run ───────────────────────────────────────────
			{
				displayName: 'Recipe Run ID',
				name: 'recipeRunId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. 6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8',
				displayOptions: { show: { resource: ['recipe'], operation: ['getRun'] } },
				description: 'ID of a recipe run, as returned by Recipe > Run or the Browsa Trigger',
			},
			...waitFields('recipe', 'getRun', false, 'waitForCompletion'),

			// ── Operations ─────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['task'] } },
				options: [
					{
						name: 'Run',
						value: 'run',
						description: 'Run a plain-language task in a Phantom browser and get the result',
						action: 'Run a task',
					},
				],
				default: 'run',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['page'] } },
				options: [
					{
						name: 'Crawl',
						value: 'crawl',
						description: 'Follow links from a start page and scrape each page found',
						action: 'Crawl a site',
					},
					{
						name: 'Extract Data',
						value: 'extract',
						description: 'Get the fields you describe from a page',
						action: 'Extract data from a page',
					},
					{
						name: 'Scrape',
						value: 'scrape',
						description: 'Get a rendered page as Markdown, HTML, text, links or a screenshot',
						action: 'Scrape a page',
					},
					{
						name: 'Take Screenshot',
						value: 'screenshot',
						description: 'Get a PNG of a page as binary data',
						action: 'Take a screenshot of a page',
					},
				],
				default: 'scrape',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['job'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						description: 'Get the status, outcome and result of a task or crawl job',
						action: 'Get a job',
					},
				],
				default: 'get',
			},

			// ── Task > Run ─────────────────────────────────────────────────
			{
				displayName: 'Task',
				name: 'task',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				placeholder: 'e.g. Open news.ycombinator.com and return the top 3 stories as JSON',
				displayOptions: { show: { resource: ['task'], operation: ['run'] } },
				description: 'What the agent should do, in plain language (at most 20,000 characters)',
			},
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				default: 'browsa',
				displayOptions: { show: { resource: ['task'], operation: ['run'] } },
				options: [
					{
						name: 'Browsa (Hosted)',
						value: 'browsa',
						description:
							'Default hosted tier. No model key needed; adds the hosted credits per task.',
					},
					{
						name: 'Browsa Fast (Hosted)',
						value: 'browsa-fast',
						description: 'Hosted tier for short and simple tasks. No model key needed.',
					},
					{
						name: 'Browsa Smart (Hosted)',
						value: 'browsa-smart',
						description:
							'Hosted tier with the strongest model, for harder tasks. No model key needed.',
					},
					{
						name: 'My Model API Key',
						value: 'apiKey',
						description:
							'An Anthropic, OpenAI or Google key, or one for an OpenAI-compatible server. No hosted credits; your provider bills the tokens.',
					},
					{
						name: 'My Saved Model Key',
						value: 'savedKey',
						description:
							'An Anthropic, OpenAI or Google key saved in the Browsa dashboard. No hosted credits; your provider bills the tokens.',
					},
				],
				description: 'Which model drives the browser',
			},
			{
				displayName: 'Saved Key ID',
				name: 'llmKeyId',
				type: 'string',
				default: '',
				placeholder: 'e.g. 3f2c8a6e-1b4d-4c9a-9e7f-2a5b6c7d8e9f',
				displayOptions: { show: { resource: ['task'], operation: ['run'], model: ['savedKey'] } },
				description:
					"ID of a key on https://app.browsa.io/dashboard/llm-keys. Leave empty to use the workspace's default saved key.",
			},
			{
				displayName: 'Model API Key',
				name: 'llmApiKey',
				type: 'string',
				typeOptions: { password: true },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['task'], operation: ['run'], model: ['apiKey'] } },
				description:
					'Your model provider key. Browsa uses it for this task only and does not store it. Saving it in the Browsa dashboard and choosing "My Saved Model Key" keeps it out of the workflow.',
			},
			{
				displayName: 'Model Name',
				name: 'llm',
				type: 'string',
				default: '',
				placeholder: 'e.g. anthropic:claude-sonnet-5-5',
				displayOptions: {
					show: { resource: ['task'], operation: ['run'], model: ['savedKey', 'apiKey'] },
				},
				description: "The provider's model. Leave empty for the key's default model.",
			},
			{
				displayName: 'Model Base URL',
				name: 'llmBaseUrl',
				type: 'string',
				default: '',
				placeholder: 'e.g. https://my-openai-compatible-server.example.com/v1',
				displayOptions: { show: { resource: ['task'], operation: ['run'], model: ['apiKey'] } },
				description:
					'Only for an Anthropic- or OpenAI-compatible server. Leave empty for the provider.',
			},
			...waitFields('task', 'run', true, 'waitForResult'),
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['task'], operation: ['run'] } },
				options: [
					{
						displayName: 'Allow Purchases',
						name: 'allowPurchase',
						type: 'boolean',
						default: false,
						description:
							'Whether the agent may press buttons that place an order or start a paid plan. Off: it stops at such a button and the task ends as not done.',
					},
					{
						displayName: 'Allowed Domains',
						name: 'allowedDomains',
						type: 'string',
						default: '',
						placeholder: 'e.g. books.toscrape.com, *.example.com',
						description:
							'Comma-separated domains the browser may open (at most 50). The start URL and any URL in the task must be on the list.',
					},
					{
						displayName: 'Max Credits',
						name: 'maxCredits',
						type: 'number',
						typeOptions: { minValue: 3, maxValue: 10000 },
						default: 50,
						description:
							'Most credits the task may charge. The agent stops before the step that would go over it.',
					},
					{
						displayName: 'Max Steps',
						name: 'maxSteps',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 100 },
						default: 20,
						description: 'Most steps the agent may take',
					},
					...waitOptions,
					{
						displayName: 'Operating System',
						name: 'osType',
						type: 'options',
						default: 'OS_TYPE_MACOS',
						options: [
							{ name: 'Linux', value: 'OS_TYPE_LINUX' },
							{ name: 'macOS', value: 'OS_TYPE_MACOS' },
							{ name: 'Windows', value: 'OS_TYPE_WINDOWS' },
						],
						description: 'The operating system the browser presents',
					},
					{
						displayName: 'Output Schema',
						name: 'outputSchema',
						type: 'json',
						default: '{\n  "type": "object",\n  "properties": {}\n}',
						description:
							'JSON Schema for the answer, with an object at the top level. The result is then JSON that matches it.',
					},
					{
						displayName: 'Reasoning',
						name: 'reasoning',
						type: 'options',
						default: 'medium',
						options: [
							{ name: 'Low', value: 'low' },
							{ name: 'Medium', value: 'medium' },
							{ name: 'High', value: 'high' },
						],
						description:
							'How hard the model thinks on each step. Higher is slower and uses more tokens.',
					},
					{
						displayName: 'Saved Proxy ID',
						name: 'proxyId',
						type: 'string',
						default: '',
						description: 'ID of a proxy saved in Browsa that the browser connects through',
					},
					{
						displayName: 'Start URL',
						name: 'initialUrl',
						type: 'string',
						default: '',
						placeholder: 'e.g. https://example.com',
						description: 'Page the browser opens before the agent starts',
					},
				],
			},

			// ── Job > Get ──────────────────────────────────────────────────
			{
				displayName: 'Job ID',
				name: 'jobId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. 6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8',
				displayOptions: { show: { resource: ['job'], operation: ['get'] } },
				description: 'ID of a task or crawl job',
			},
			...waitFields('job', 'get', false, 'waitForCompletion'),
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['job'], operation: ['get'] } },
				options: [...waitOptions],
			},

			// ── Page: shared URL field ─────────────────────────────────────
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. https://example.com',
				displayOptions: {
					show: { resource: ['page'], operation: ['scrape', 'extract', 'screenshot'] },
				},
				description: 'Page to open',
			},

			// ── Page > Scrape ──────────────────────────────────────────────
			{
				displayName: 'Formats',
				name: 'formats',
				type: 'multiOptions',
				default: ['markdown'],
				displayOptions: { show: { resource: ['page'], operation: ['scrape'] } },
				options: [
					{ name: 'HTML', value: 'html' },
					{ name: 'Links', value: 'links' },
					{ name: 'Markdown', value: 'markdown' },
					{ name: 'Screenshot', value: 'screenshot' },
					{ name: 'Text', value: 'text' },
				],
				description:
					'What to return. A screenshot (the visible part of the page, PNG) is returned as binary data.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['page'], operation: ['scrape'] } },
				options: [
					{
						displayName: 'Block Resources',
						name: 'block',
						type: 'multiOptions',
						default: [],
						options: [
							{ name: 'Fonts', value: 'font' },
							{ name: 'Images', value: 'image' },
							{ name: 'Media', value: 'media' },
						],
						description: 'Resource types the browser does not load',
					},
					{
						displayName: 'Max Characters',
						name: 'maxChars',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 100000,
						description: 'Cap for text and Markdown, in characters',
					},
					{
						displayName: 'Put Screenshot in Field',
						name: 'binaryPropertyName',
						type: 'string',
						default: 'data',
						description: 'Name of the binary field for the screenshot',
					},
					{
						displayName: 'Wait After Load (Ms)',
						name: 'waitMs',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 60000 },
						default: 3000,
						description: 'Extra time for the page to settle after it loads, in milliseconds',
					},
				],
			},

			// ── Page > Extract Data ────────────────────────────────────────
			{
				displayName: 'Describe Fields With',
				name: 'extractMode',
				type: 'options',
				default: 'prompt',
				displayOptions: { show: { resource: ['page'], operation: ['extract'] } },
				options: [
					{
						name: 'Instructions',
						value: 'prompt',
						description: 'Say in plain language what to extract',
					},
					{
						name: 'JSON Schema',
						value: 'schema',
						description: 'Give the exact shape of the output',
					},
				],
			},
			{
				displayName: 'Instructions',
				name: 'prompt',
				type: 'string',
				typeOptions: { rows: 3 },
				required: true,
				default: '',
				placeholder: 'e.g. Return the page title and the first paragraph',
				displayOptions: {
					show: { resource: ['page'], operation: ['extract'], extractMode: ['prompt'] },
				},
				description: 'What to extract from the page',
			},
			{
				displayName: 'Schema',
				name: 'schema',
				type: 'json',
				required: true,
				default:
					'{\n  "type": "object",\n  "properties": {\n    "title": { "type": "string" }\n  }\n}',
				displayOptions: {
					show: { resource: ['page'], operation: ['extract'], extractMode: ['schema'] },
				},
				description: 'JSON Schema of the data to extract',
			},
			{
				displayName: 'Extraction Model',
				name: 'extractModel',
				type: 'options',
				default: 'none',
				displayOptions: { show: { resource: ['page'], operation: ['extract'] } },
				options: [
					{
						name: 'None (Return Page Text)',
						value: 'none',
						description:
							"Return the page's clean text and the schema, ready for your own model (for example an AI node after this one)",
					},
					{
						name: 'My Saved Anthropic Key',
						value: 'savedKey',
						description: 'An Anthropic key saved in the Browsa dashboard. Browsa returns the data.',
					},
					{
						name: 'My Anthropic API Key',
						value: 'apiKey',
						description: 'Browsa runs the extraction with this key and returns the data',
					},
				],
				description:
					'Who turns the page into data. Browsa extracts with an Anthropic key; your provider bills the tokens.',
			},
			{
				displayName: 'Saved Key ID',
				name: 'llmKeyId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['page'], operation: ['extract'], extractModel: ['savedKey'] },
				},
				description: 'ID of an Anthropic key on https://app.browsa.io/dashboard/llm-keys',
			},
			{
				displayName: 'Anthropic API Key',
				name: 'llmApiKey',
				type: 'string',
				typeOptions: { password: true },
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['page'], operation: ['extract'], extractModel: ['apiKey'] },
				},
				description: 'Used in memory for this call only',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['page'], operation: ['extract'] } },
				options: [
					{
						displayName: 'Model Name',
						name: 'llm',
						type: 'string',
						default: '',
						placeholder: 'e.g. anthropic:claude-sonnet-5-5',
						description: 'Anthropic model for the extraction. Leave empty for the default.',
					},
					{
						displayName: 'Wait After Load (Ms)',
						name: 'waitMs',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 60000 },
						default: 3000,
						description: 'Extra time for the page to settle after it loads, in milliseconds',
					},
				],
			},

			// ── Page > Take Screenshot ─────────────────────────────────────
			{
				displayName: 'Full Page',
				name: 'fullPage',
				type: 'boolean',
				default: true,
				displayOptions: { show: { resource: ['page'], operation: ['screenshot'] } },
				description:
					'Whether to capture the full scrollable height (up to 16,000 px) instead of the visible part',
			},
			{
				displayName: 'Put Output File in Field',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				displayOptions: { show: { resource: ['page'], operation: ['screenshot'] } },
				description: 'Name of the binary field for the PNG',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['page'], operation: ['screenshot'] } },
				options: [
					{
						displayName: 'Wait After Load (Ms)',
						name: 'waitMs',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 60000 },
						default: 3000,
						description: 'Extra time for the page to settle after it loads, in milliseconds',
					},
				],
			},

			// ── Page > Crawl ───────────────────────────────────────────────
			{
				displayName: 'Start URL',
				name: 'startUrl',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. https://example.com/blog',
				displayOptions: { show: { resource: ['page'], operation: ['crawl'] } },
				description: 'Page the crawl starts from',
			},
			{
				displayName: 'Max Pages',
				name: 'maxPages',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 200 },
				default: 25,
				displayOptions: { show: { resource: ['page'], operation: ['crawl'] } },
				description: 'Most pages to scrape. Each page costs 1 credit.',
			},
			{
				displayName: 'Crawl Formats',
				name: 'crawlFormats',
				type: 'multiOptions',
				default: ['markdown'],
				displayOptions: { show: { resource: ['page'], operation: ['crawl'] } },
				options: [
					{ name: 'HTML', value: 'html' },
					{ name: 'Links', value: 'links' },
					{ name: 'Markdown', value: 'markdown' },
					{ name: 'Text', value: 'text' },
				],
				description: 'What to return for each page',
			},
			...waitFields('page', 'crawl', true, 'waitForResult'),
			{
				displayName: 'Output',
				name: 'crawlOutput',
				type: 'options',
				default: 'pages',
				displayOptions: {
					show: { resource: ['page'], operation: ['crawl'], waitForResult: [true] },
				},
				options: [
					{
						name: 'One Item per Page',
						value: 'pages',
						description: 'Each crawled page becomes its own item',
					},
					{
						name: 'One Job Item',
						value: 'job',
						description: 'Return the job, with all pages in its result',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['page'], operation: ['crawl'] } },
				options: [
					{
						displayName: 'Exclude URLs Matching',
						name: 'excludeRegex',
						type: 'string',
						default: '',
						placeholder: 'e.g. /tag/|/page/\\d+',
						description: 'Regular expression; matching URLs are skipped',
					},
					{
						displayName: 'Include Only URLs Matching',
						name: 'includeRegex',
						type: 'string',
						default: '',
						placeholder: 'e.g. /blog/',
						description: 'Regular expression; only matching URLs are crawled',
					},
					{
						displayName: 'Max Characters',
						name: 'maxChars',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 100000,
						description: 'Cap for text and Markdown per page, in characters',
					},
					{
						displayName: 'Max Depth',
						name: 'maxDepth',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 5 },
						default: 2,
						description: 'How many links away from the start page to go',
					},
					{
						displayName: 'Same Domain Only',
						name: 'sameDomain',
						type: 'boolean',
						default: true,
						description: "Whether to follow only links on the start page's domain",
					},
					...waitOptions,
					{
						displayName: 'Wait After Load (Ms)',
						name: 'waitMs',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 60000 },
						default: 3000,
						description: 'Extra time for each page to settle after it loads, in milliseconds',
					},
				],
			},
		],
	};

	methods = {
		listSearch: {
			async searchRobots(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const r = await browsaApiRequest.call(this, 'GET', '/v1/robots', { qs: { limit: 200 } });
				return { results: toListResults(r.robots, filter) };
			},
			async searchRecipes(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const r = await browsaApiRequest.call(this, 'GET', '/v1/recipes', { qs: { limit: 200 } });
				return { results: toListResults(r.recipes, filter) };
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				let out: INodeExecutionData[];

				if (resource === 'robot' && operation === 'run') {
					out = await runRobot.call(this, i);
				} else if (resource === 'robot' && operation === 'getRun') {
					out = await getRobotRun.call(this, i);
				} else if (resource === 'recipe' && operation === 'run') {
					out = await runRecipe.call(this, i);
				} else if (resource === 'recipe' && operation === 'getRun') {
					out = await getRecipeRun.call(this, i);
				} else if (resource === 'task' && operation === 'run') {
					out = await runTask.call(this, i);
				} else if (resource === 'job' && operation === 'get') {
					out = await getJob.call(this, i);
				} else if (resource === 'page' && operation === 'scrape') {
					out = await scrapePage.call(this, i);
				} else if (resource === 'page' && operation === 'extract') {
					out = await extractData.call(this, i);
				} else if (resource === 'page' && operation === 'screenshot') {
					out = await takeScreenshot.call(this, i);
				} else if (resource === 'page' && operation === 'crawl') {
					out = await crawl.call(this, i);
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${operation}" is not supported for "${resource}"`,
						{ itemIndex: i },
					);
				}

				for (const o of out) returnData.push({ ...o, pairedItem: { item: i } });
			} catch (thrown) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (thrown as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				if (thrown instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), thrown as unknown as JsonObject, { itemIndex: i });
				}
				throw new NodeOperationError(this.getNode(), thrown as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}

// ── Operations ───────────────────────────────────────────────────────────

/** Waits for a job when asked to, applies the timeout and outcome options, and shapes the output. */
async function finishJob(
	this: IExecuteFunctions,
	i: number,
	accepted: IDataObject,
	waitName: string,
	shape: (job: IDataObject, simplify: boolean) => INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const wait = this.getNodeParameter(waitName, i, false) as boolean;
	if (!wait) return [{ json: accepted }];

	const id = jobIdOf(accepted);
	const timeout = this.getNodeParameter('timeout', i, 600) as number;
	const simplify = this.getNodeParameter('simplify', i, true) as boolean;
	const options = this.getNodeParameter('options', i, {}) as IDataObject;

	const { job, timedOut } = await waitForJob.call(this, id, timeout, i);
	if (timedOut) {
		if ((options.onTimeout ?? 'stop') === 'stop') {
			throw new NodeOperationError(
				this.getNode(),
				`Browsa job ${id} is still ${String(job.status)} after ${timeout} seconds`,
				{
					itemIndex: i,
					description:
						"The job keeps running and is billed as usual. Read it later with Job > Get and this ID, raise 'Timeout (Seconds)', or set 'On Timeout' to 'Return the Job'.",
				},
			);
		}
		const base = simplify ? simplifyJob(job) : job;
		return [{ json: { ...base, wait_timed_out: true } }];
	}
	if (options.stopOnUnsuccessful === true && isUnsuccessful(job)) {
		throw new NodeOperationError(
			this.getNode(),
			`Browsa job ${id} ended with outcome '${String(job.outcome ?? job.status)}'`,
			{
				itemIndex: i,
				description: [job.outcome_message, job.error_code ? `Code ${String(job.error_code)}.` : '']
					.filter(Boolean)
					.join(' '),
			},
		);
	}
	return shape(job, simplify);
}

const shapeJob = (job: IDataObject, simplify: boolean): INodeExecutionData[] => [
	{ json: simplify ? simplifyJob(job) : job },
];

async function runTask(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const model = this.getNodeParameter('model', i) as string;
	const options = this.getNodeParameter('options', i, {}) as IDataObject;

	const body: IDataObject = { task: this.getNodeParameter('task', i) as string };
	if (model === 'savedKey' || model === 'apiKey') {
		const llm = (this.getNodeParameter('llm', i, '') as string).trim();
		if (llm) body.llm = llm;
		if (model === 'savedKey') {
			const keyId = (this.getNodeParameter('llmKeyId', i, '') as string).trim();
			if (keyId) body.llm_key_id = keyId;
		} else {
			body.llm_api_key = this.getNodeParameter('llmApiKey', i) as string;
			const baseUrl = (this.getNodeParameter('llmBaseUrl', i, '') as string).trim();
			if (baseUrl) body.llm_base_url = baseUrl;
		}
	} else {
		body.llm = model;
	}

	if (options.initialUrl) body.initial_url = options.initialUrl;
	if (options.maxSteps !== undefined) body.max_steps = options.maxSteps;
	if (options.maxCredits !== undefined) body.max_credits = options.maxCredits;
	if (options.reasoning) body.reasoning = options.reasoning;
	if (options.osType) body.os_type = options.osType;
	if (options.allowPurchase !== undefined) body.allow_purchase = options.allowPurchase;
	if (options.proxyId) body.proxy_id = options.proxyId;
	const domains = splitList(options.allowedDomains);
	if (domains.length) body.allowed_domains = domains;
	const schema = parseJsonObject.call(this, options.outputSchema, 'Output Schema', i);
	if (schema) body.output_schema = schema;

	const accepted = await browsaApiRequest.call(this, 'POST', '/v1/tasks', { body, itemIndex: i });
	return await finishJob.call(this, i, accepted, 'waitForResult', shapeJob);
}

async function getJob(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const id = (this.getNodeParameter('jobId', i) as string).trim();
	if (!id) {
		throw new NodeOperationError(this.getNode(), "'Job ID' is empty", { itemIndex: i });
	}
	const wait = this.getNodeParameter('waitForCompletion', i, false) as boolean;
	if (wait) {
		return await finishJob.call(this, i, { id }, 'waitForCompletion', shapeJob);
	}
	const job = await browsaApiRequest.call(this, 'GET', `/v1/jobs/${encodeURIComponent(id)}`, {
		itemIndex: i,
	});
	return [{ json: job }];
}

async function scrapePage(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const options = this.getNodeParameter('options', i, {}) as IDataObject;
	const formats = this.getNodeParameter('formats', i, ['markdown']) as string[];
	const body: IDataObject = { url: this.getNodeParameter('url', i) as string };
	if (formats.length) body.formats = formats;
	if (options.waitMs !== undefined) body.wait_ms = options.waitMs;
	if (options.maxChars !== undefined) body.max_chars = options.maxChars;
	if (Array.isArray(options.block) && options.block.length) body.block = options.block;

	const response = await browsaApiRequest.call(this, 'POST', '/v1/quick/scrape', {
		body,
		timeoutMs: 120_000,
		itemIndex: i,
	});
	const binaryField = (options.binaryPropertyName as string) || 'data';
	return [await withScreenshotBinary.call(this, response, binaryField, 'browsa-scrape.png')];
}

async function extractData(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const options = this.getNodeParameter('options', i, {}) as IDataObject;
	const mode = this.getNodeParameter('extractMode', i) as string;
	const model = this.getNodeParameter('extractModel', i, 'none') as string;

	const body: IDataObject = { url: this.getNodeParameter('url', i) as string };
	if (mode === 'schema') {
		const schema = parseJsonObject.call(this, this.getNodeParameter('schema', i), 'Schema', i);
		if (!schema) {
			throw new NodeOperationError(this.getNode(), "'Schema' is empty", {
				itemIndex: i,
				description: 'Describe at least one field, or switch to Instructions.',
			});
		}
		body.schema = schema;
	} else {
		body.prompt = this.getNodeParameter('prompt', i) as string;
	}
	if (model === 'savedKey')
		body.llm_key_id = (this.getNodeParameter('llmKeyId', i) as string).trim();
	if (model === 'apiKey') body.llm_api_key = this.getNodeParameter('llmApiKey', i) as string;
	if (model !== 'none' && options.llm) body.llm = options.llm;
	if (options.waitMs !== undefined) body.wait_ms = options.waitMs;

	const response = await browsaApiRequest.call(this, 'POST', '/v1/quick/extract', {
		body,
		timeoutMs: 180_000,
		itemIndex: i,
	});
	return [{ json: response }];
}

async function takeScreenshot(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const options = this.getNodeParameter('options', i, {}) as IDataObject;
	const body: IDataObject = {
		url: this.getNodeParameter('url', i) as string,
		full_page: this.getNodeParameter('fullPage', i, true) as boolean,
	};
	if (options.waitMs !== undefined) body.wait_ms = options.waitMs;

	const response = await browsaApiRequest.call(this, 'POST', '/v1/quick/screenshot', {
		body,
		timeoutMs: 120_000,
		itemIndex: i,
	});
	const binaryField = this.getNodeParameter('binaryPropertyName', i, 'data') as string;
	if (typeof response.screenshot_png_b64 !== 'string' || !response.screenshot_png_b64) {
		throw new NodeOperationError(this.getNode(), 'Browsa returned no screenshot for this page', {
			itemIndex: i,
			description: 'Try again, or raise "Wait After Load (Ms)" under Options.',
		});
	}
	return [await withScreenshotBinary.call(this, response, binaryField, 'browsa-screenshot.png')];
}

async function crawl(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const options = this.getNodeParameter('options', i, {}) as IDataObject;
	const formats = this.getNodeParameter('crawlFormats', i, ['markdown']) as string[];
	const body: IDataObject = {
		start_url: this.getNodeParameter('startUrl', i) as string,
		max_pages: this.getNodeParameter('maxPages', i, 25) as number,
	};
	if (formats.length) body.formats = formats;
	if (options.maxDepth !== undefined) body.max_depth = options.maxDepth;
	if (options.sameDomain !== undefined) body.same_domain = options.sameDomain;
	if (options.includeRegex) body.include_regex = options.includeRegex;
	if (options.excludeRegex) body.exclude_regex = options.excludeRegex;
	if (options.waitMs !== undefined) body.wait_ms = options.waitMs;
	if (options.maxChars !== undefined) body.max_chars = options.maxChars;

	const accepted = await browsaApiRequest.call(this, 'POST', '/v1/quick/crawl', {
		body,
		itemIndex: i,
	});
	const output = this.getNodeParameter('crawlOutput', i, 'pages') as string;
	return await finishJob.call(this, i, accepted, 'waitForResult', (job, simplify) => {
		if (output === 'pages' && job.status === 'completed') {
			return crawlPagesToItems(job).map((json) => ({ json }));
		}
		return shapeJob(job, simplify);
	});
}

// ── Robots and recipes ───────────────────────────────────────────────────

/** Robots or recipes as list entries, filtered by name or ID. */
function toListResults(list: unknown, filter?: string): Array<{ name: string; value: string }> {
	const rows = Array.isArray(list) ? (list as IDataObject[]) : [];
	const f = (filter ?? '').trim().toLowerCase();
	return rows
		.map((r) => ({ name: String(r.name || r.id || ''), value: String(r.id ?? '') }))
		.filter((r) => r.value)
		.filter((r) => !f || r.name.toLowerCase().includes(f) || r.value.toLowerCase().includes(f));
}

interface RunShape {
	kind: RunKind;
	unsuccessful: (run: IDataObject) => boolean;
	shape: (run: IDataObject, simplify: boolean) => INodeExecutionData[];
}

/** Waits for a robot or recipe run when asked to, applies the timeout and status options, and shapes the output. */
async function finishRun(
	this: IExecuteFunctions,
	i: number,
	accepted: IDataObject,
	waitName: string,
	how: RunShape,
): Promise<INodeExecutionData[]> {
	const wait = this.getNodeParameter(waitName, i, false) as boolean;
	if (!wait) return [{ json: accepted }];

	const id = String(accepted.id ?? accepted.run_id ?? '');
	const timeout = this.getNodeParameter('timeout', i, 600) as number;
	const simplify = this.getNodeParameter('simplify', i, true) as boolean;
	const options = this.getNodeParameter('options', i, {}) as IDataObject;

	let run = accepted;
	let timedOut = false;
	if (!how.kind.terminal.includes(String(accepted.status))) {
		if (!id) {
			throw new NodeOperationError(this.getNode(), `Browsa returned no ${how.kind.label} ID`, {
				itemIndex: i,
			});
		}
		({ job: run, timedOut } = await waitForRun.call(this, how.kind, id, timeout, i));
	}
	if (timedOut) {
		if ((options.onTimeout ?? 'stop') === 'stop') {
			throw new NodeOperationError(
				this.getNode(),
				`Browsa ${how.kind.label} ${id} is still ${String(run.status)} after ${timeout} seconds`,
				{
					itemIndex: i,
					description: `The ${how.kind.label} keeps going on Browsa. Read it later with this ID, raise 'Timeout (Seconds)', or set 'On Timeout' to 'Return the Run'.`,
				},
			);
		}
		return [{ json: { ...run, wait_timed_out: true } }];
	}
	if (options.stopOnUnsuccessful === true && how.unsuccessful(run)) {
		throw new NodeOperationError(
			this.getNode(),
			`Browsa ${how.kind.label} ${id} ended with status '${String(run.status)}'`,
			{
				itemIndex: i,
				description: [run.error_message, run.error_code ? `Code ${String(run.error_code)}.` : '']
					.filter(Boolean)
					.join(' '),
			},
		);
	}
	return how.shape(run, simplify);
}

function robotShape(this: IExecuteFunctions, i: number): RunShape {
	const output = this.getNodeParameter('robotOutput', i, 'run') as string;
	return {
		kind: ROBOT_RUN,
		unsuccessful: isRobotRunUnsuccessful,
		shape: (run, simplify) => {
			if (output === 'rows' && Array.isArray(run.rows)) {
				return robotRowsToItems(run, simplify).map((json) => ({ json }));
			}
			return [{ json: simplify ? simplifyRobotRun(run) : run }];
		},
	};
}

const recipeShape: RunShape = {
	kind: RECIPE_RUN,
	unsuccessful: isRecipeRunUnsuccessful,
	shape: (run, simplify) => [{ json: simplify ? simplifyRecipeRun(run) : run }],
};

async function runRobot(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const robotId = locatorValue(this.getNodeParameter('robotId', i));
	if (!robotId) {
		throw new NodeOperationError(this.getNode(), "Choose a robot in 'Robot'", { itemIndex: i });
	}
	const body: IDataObject = {};
	if (this.getNodeParameter('inputsSource', i, 'saved') === 'rows') {
		const inputs = parseRobotInputs.call(this, this.getNodeParameter('robotInputs', i, ''), i);
		if (!inputs) {
			throw new NodeOperationError(this.getNode(), "'Rows (JSON)' has no rows", {
				itemIndex: i,
				description: "Give at least one row, or set 'Inputs' to 'Saved Inputs'.",
			});
		}
		body.inputs = inputs;
	}
	const accepted = await browsaApiRequest.call(
		this,
		'POST',
		`/v1/robots/${encodeURIComponent(robotId)}/run`,
		{ body, itemIndex: i },
	);
	return await finishRun.call(this, i, accepted, 'waitForResult', robotShape.call(this, i));
}

async function getRobotRun(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const id = (this.getNodeParameter('robotRunId', i) as string).trim();
	if (!id) {
		throw new NodeOperationError(this.getNode(), "'Robot Run ID' is empty", { itemIndex: i });
	}
	const wait = this.getNodeParameter('waitForCompletion', i, false) as boolean;
	const how = robotShape.call(this, i);
	if (wait) return await finishRun.call(this, i, { id }, 'waitForCompletion', how);
	const run = await browsaApiRequest.call(this, 'GET', `/v1/robot-runs/${encodeURIComponent(id)}`, {
		itemIndex: i,
	});
	return how.shape(run, false);
}

async function runRecipe(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const recipeId = locatorValue(this.getNodeParameter('recipeId', i));
	if (!recipeId) {
		throw new NodeOperationError(this.getNode(), "Choose a recipe in 'Recipe'", { itemIndex: i });
	}
	const params =
		parseJsonObject.call(this, this.getNodeParameter('recipeParams', i, ''), 'Parameters', i) ?? {};
	const body: IDataObject = { params };
	const wait = this.getNodeParameter('waitForResult', i, true) as boolean;
	if (wait) {
		const timeout = this.getNodeParameter('timeout', i, 600) as number;
		body.wait = Math.min(60, Math.max(1, timeout));
	}
	const accepted = await browsaApiRequest.call(
		this,
		'POST',
		`/v1/recipes/${encodeURIComponent(recipeId)}/run`,
		{ body, timeoutMs: wait ? ((body.wait as number) + 15) * 1000 : undefined, itemIndex: i },
	);
	return await finishRun.call(this, i, accepted, 'waitForResult', recipeShape);
}

async function getRecipeRun(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const id = (this.getNodeParameter('recipeRunId', i) as string).trim();
	if (!id) {
		throw new NodeOperationError(this.getNode(), "'Recipe Run ID' is empty", { itemIndex: i });
	}
	const wait = this.getNodeParameter('waitForCompletion', i, false) as boolean;
	if (wait) return await finishRun.call(this, i, { id }, 'waitForCompletion', recipeShape);
	const run = await browsaApiRequest.call(
		this,
		'GET',
		`/v1/recipe-runs/${encodeURIComponent(id)}`,
		{
			itemIndex: i,
		},
	);
	return [{ json: run }];
}

/** Moves `screenshot_png_b64` out of the JSON into a binary field. */
async function withScreenshotBinary(
	this: IExecuteFunctions,
	response: IDataObject,
	binaryField: string,
	fileName: string,
): Promise<INodeExecutionData> {
	const { screenshot_png_b64: b64, ...json } = response;
	if (typeof b64 !== 'string' || !b64) return { json: response };
	const binary = await this.helpers.prepareBinaryData(
		Buffer.from(b64, 'base64'),
		fileName,
		'image/png',
	);
	return { json, binary: { [binaryField]: binary } };
}
