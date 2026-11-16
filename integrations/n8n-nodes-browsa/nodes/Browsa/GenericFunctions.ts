import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

export const BROWSA_BASE_URL = 'https://browsa.io';

/** Job statuses after which a job no longer changes (see Job.status in openapi.yaml). */
export const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

/** A task waiting for an answer (POST /v1/jobs/{id}/respond) also ends the wait. */
export const WAIT_END_STATUSES = [...TERMINAL_STATUSES, 'input_required'];

/** What to do for the codes most workflows meet. Wording follows the Browsa docs. */
const HINTS: Record<string, string> = {
	INSUFFICIENT_CREDIT:
		'The workspace has no credits left. Buy a credit pack at https://app.browsa.io/dashboard/credits.',
	BUDGET_REACHED:
		"The workspace's monthly spending limit is reached. Raise it in the Browsa dashboard or wait until the 1st of the month (UTC).",
	KEY_BUDGET_REACHED:
		"This API key's monthly spending limit is reached. Raise it at https://app.browsa.io/dashboard/keys or use another key.",
	TOO_MANY_REQUESTS:
		"Every browser slot of the workspace is in use. Nothing was charged. Retry in about 30 seconds, for example with the node's 'Retry On Fail' setting.",
	UNAUTHORIZED: "Check the API key in the 'Browsa API' credential.",
	INVALID_API_KEY: "Check the API key in the 'Browsa API' credential.",
	MISSING_API_KEY: "Check the API key in the 'Browsa API' credential.",
	LLM_KEY_REQUIRED:
		"Choose a hosted model in 'Model' (Browsa, Browsa Fast or Browsa Smart), or give your own model key.",
	TARGET_UNREACHABLE:
		'The site did not load (DNS, connection, certificate or HTTP status). The credit is refunded.',
	UPSTREAM_UNAVAILABLE:
		'The Phantom browser did not finish the request. The credit is refunded; retry later.',
	UPSTREAM_TIMEOUT: 'The page took too long to load. Retry later.',
	UNSUPPORTED_CONTENT:
		'The URL is a PDF, a file download or other content that is not a page. The credit is refunded.',
};

export interface BrowsaErrorEnvelope {
	error?: string;
	code?: string;
	request_id?: string;
}

function asObject(value: unknown): IDataObject | undefined {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as IDataObject;
	if (typeof value === 'string' && value.startsWith('{')) {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
				return parsed as IDataObject;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Finds Browsa's `{error, code, request_id}` envelope in whatever n8n's HTTP
 * helper threw: a NodeApiError (envelope in context.data), or the raw Axios
 * error (envelope in response.data).
 */
export function findErrorEnvelope(thrown: unknown): BrowsaErrorEnvelope | undefined {
	const t = thrown as IDataObject & {
		context?: IDataObject;
		cause?: IDataObject;
		response?: IDataObject;
	};
	if (!t || typeof t !== 'object') return undefined;
	const cause = t.cause as (IDataObject & { response?: IDataObject }) | undefined;
	const candidates: unknown[] = [
		t.context?.data,
		t.response?.data,
		t.response?.body,
		cause?.response?.data,
		cause?.response?.body,
		t.error,
	];
	for (const c of candidates) {
		const obj = asObject(c);
		if (obj && typeof obj.code === 'string') {
			return {
				error: typeof obj.error === 'string' ? obj.error : undefined,
				code: obj.code,
				request_id: typeof obj.request_id === 'string' ? obj.request_id : undefined,
			};
		}
	}
	return undefined;
}

function findHttpStatus(thrown: unknown): string | undefined {
	const t = thrown as IDataObject & { response?: IDataObject; cause?: IDataObject };
	const raw =
		t?.httpCode ??
		(t?.response as IDataObject | undefined)?.status ??
		((t?.cause as IDataObject | undefined)?.response as IDataObject | undefined)?.status;
	return raw === undefined || raw === null ? undefined : String(raw);
}

/** Builds the message n8n shows when Browsa answers with an error envelope. */
export function describeEnvelope(env: BrowsaErrorEnvelope): {
	message: string;
	description: string;
} {
	const code = env.code ?? 'UNKNOWN';
	const message = env.error
		? `Browsa: ${env.error} [${code}]`
		: `Browsa answered with code ${code}`;
	const parts: string[] = [];
	if (HINTS[code]) parts.push(HINTS[code]);
	if (env.request_id) parts.push(`Request ID ${env.request_id} (quote it to support@browsa.io).`);
	return { message, description: parts.join(' ') };
}

/** One call to the Browsa REST API with the node's "Browsa API" credential. */
export async function browsaApiRequest(
	this: IExecuteFunctions,
	method: IHttpRequestMethods,
	path: string,
	options: { body?: IDataObject; qs?: IDataObject; timeoutMs?: number; itemIndex?: number } = {},
): Promise<IDataObject> {
	const request: IHttpRequestOptions = {
		method,
		baseURL: BROWSA_BASE_URL,
		url: path,
		json: true,
		headers: { Accept: 'application/json' },
		timeout: options.timeoutMs ?? 60_000,
	};
	if (options.body !== undefined) request.body = options.body;
	if (options.qs !== undefined) request.qs = options.qs;

	try {
		return (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'browsaApi',
			request,
		)) as IDataObject;
	} catch (thrown) {
		const envelope = findErrorEnvelope(thrown);
		if (envelope) {
			const { message, description } = describeEnvelope(envelope);
			throw new NodeApiError(this.getNode(), envelope as JsonObject, {
				message,
				description,
				httpCode: findHttpStatus(thrown),
				itemIndex: options.itemIndex,
			});
		}
		throw new NodeApiError(this.getNode(), thrown as JsonObject, { itemIndex: options.itemIndex });
	}
}

/** The id of a job, from a job (`id`) or a 202 envelope (`job_id`). */
export function jobIdOf(job: IDataObject): string {
	const id = job.id ?? job.job_id;
	return typeof id === 'string' ? id : '';
}

export interface WaitResult {
	job: IDataObject;
	timedOut: boolean;
}

/**
 * Waits for a job to end. Uses the server's long poll (GET /v1/jobs/{id}?wait=N,
 * at most 30 seconds a call) until the job is completed, failed, cancelled or
 * waiting for input, or until `timeoutSeconds` have passed. Polling is free.
 */
export async function waitForJob(
	this: IExecuteFunctions,
	jobId: string,
	timeoutSeconds: number,
	itemIndex: number,
	pauseMs = 1000,
): Promise<WaitResult> {
	const deadline = Date.now() + Math.max(0, timeoutSeconds) * 1000;
	const signal = this.getExecutionCancelSignal?.();
	let job: IDataObject = {};
	for (;;) {
		const remaining = Math.ceil((deadline - Date.now()) / 1000);
		const wait = Math.min(30, Math.max(1, remaining));
		job = await browsaApiRequest.call(this, 'GET', `/v1/jobs/${encodeURIComponent(jobId)}`, {
			qs: { wait },
			timeoutMs: (wait + 15) * 1000,
			itemIndex,
		});
		if (WAIT_END_STATUSES.includes(String(job.status))) return { job, timedOut: false };
		if (Date.now() >= deadline) return { job, timedOut: true };
		if (signal?.aborted) {
			throw new NodeOperationError(this.getNode(), `Stopped waiting for Browsa job ${jobId}`, {
				itemIndex,
				description: 'The execution was cancelled. The job keeps running on Browsa.',
			});
		}
		if (pauseMs > 0) await sleep(pauseMs);
	}
}

/** The answer of a finished job: structured output, then final text, then the raw result. */
export function resultOf(job: IDataObject): unknown {
	const result = job.result as IDataObject | undefined;
	if (!result || typeof result !== 'object') return null;
	if (job.kind === 'task') {
		if (result.structured_output !== undefined && result.structured_output !== null) {
			return result.structured_output;
		}
		if (result.final_result !== undefined) return result.final_result;
	}
	return result;
}

/** At most 10 fields, the most used first (n8n UX guideline for Simplify). */
export function simplifyJob(job: IDataObject): IDataObject {
	return {
		id: jobIdOf(job),
		kind: job.kind ?? null,
		status: job.status ?? null,
		outcome: job.outcome ?? null,
		outcome_message: job.outcome_message ?? null,
		result: resultOf(job) as IDataObject,
		error_code: job.error_code ?? null,
		error_message: job.error_message ?? null,
		credits_charged: job.credits_charged ?? null,
		duration_ms: job.duration_ms ?? null,
	};
}

/** True when a finished job did not end the way it was asked to. */
export function isUnsuccessful(job: IDataObject): boolean {
	if (!TERMINAL_STATUSES.includes(String(job.status))) return false;
	return (
		job.status !== 'completed' ||
		(job.outcome !== null && job.outcome !== undefined && job.outcome !== 'completed')
	);
}

/** Parses a JSON parameter that n8n may hand over as a string or as an object. */
export function parseJsonObject(
	this: IExecuteFunctions,
	value: unknown,
	parameterName: string,
	itemIndex: number,
): IDataObject | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	let parsed: unknown = value;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed === '' || trimmed === '{}') return undefined;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new NodeOperationError(this.getNode(), `'${parameterName}' is not valid JSON`, {
				itemIndex,
				description:
					'Enter a JSON Schema object, for example {"type": "object", "properties": {"title": {"type": "string"}}}.',
			});
		}
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new NodeOperationError(this.getNode(), `'${parameterName}' must be a JSON object`, {
			itemIndex,
			description: 'A JSON Schema with "type": "object" at the top level.',
		});
	}
	if (Object.keys(parsed as IDataObject).length === 0) return undefined;
	return parsed as IDataObject;
}

/** Splits "a.com, b.com" or a newline list into a clean array. */
export function splitList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
	if (typeof value !== 'string') return [];
	return value
		.split(/[,\n]/)
		.map((v) => v.trim())
		.filter(Boolean);
}

/** One n8n item per crawled page: the page's URL and status, then its scraped fields. */
export function crawlPagesToItems(job: IDataObject): IDataObject[] {
	const result = (job.result ?? {}) as IDataObject;
	const pages = Array.isArray(result.pages) ? (result.pages as IDataObject[]) : [];
	return pages.map((page) => {
		const data = (page.data ?? {}) as IDataObject;
		const item: IDataObject = {
			url: page.url ?? data.url ?? null,
			status: page.status ?? null,
			...data,
			job_id: jobIdOf(job),
		};
		if (page.error_code) item.error_code = page.error_code;
		if (page.error_message) item.error_message = page.error_message;
		return item;
	});
}
