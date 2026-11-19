import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	browsaApiRequest,
	findErrorEnvelope,
	matchEvent,
	subscriptionEvents,
} from '../Browsa/GenericFunctions';
import { verifySignature } from './Signature';

/*
 * Registers a Browsa webhook (POST /v1/webhooks) when the workflow is
 * activated and removes it (DELETE /v1/webhooks/{id}) when it is
 * deactivated. Every delivery is signed with the workspace secret
 * (GET /v1/webhooks/signing-secret); the trigger checks it before it starts
 * the workflow.
 */

interface TriggerStaticData extends IDataObject {
	webhookId?: string;
	webhookUrl?: string;
	/** True when Browsa did not know an event name and the webhook gets every event. */
	allEvents?: boolean;
	signingSecret?: string;
}

async function fetchSigningSecret(this: IHookFunctions | IWebhookFunctions): Promise<string> {
	const r = await browsaApiRequest.call(this, 'GET', '/v1/webhooks/signing-secret');
	return typeof r.secret === 'string' ? r.secret : '';
}

/** POST /v1/webhooks, returning the refusal instead of throwing it. */
async function postWebhook(
	this: IHookFunctions,
	body: IDataObject,
): Promise<{ created?: IDataObject; refused?: unknown }> {
	try {
		return { created: await browsaApiRequest.call(this, 'POST', '/v1/webhooks', { body }) };
	} catch (thrown) {
		return { refused: thrown };
	}
}

function asNodeError(this: IHookFunctions, err: unknown): NodeApiError | NodeOperationError {
	if (err instanceof NodeApiError || err instanceof NodeOperationError) return err;
	return new NodeApiError(this.getNode(), err as JsonObject);
}

export class BrowsaTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Browsa Trigger',
		name: 'browsaTrigger',
		icon: { light: 'file:../../icons/browsa.svg', dark: 'file:../../icons/browsa.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description:
			'Starts the workflow when a Browsa robot run ends, a robot alert fires, a recipe run ends or an agent task finishes or asks a question',
		defaults: {
			name: 'Browsa Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'browsaApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'Browsa sends events to this workflow over the internet, so n8n needs a public HTTPS URL (n8n Cloud, or WEBHOOK_URL on a self-hosted instance).',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['robot.run.completed'],
				options: [
					{
						name: 'Recipe Run Completed',
						value: 'recipe.run.completed',
						description: 'A recipe run returned its output',
					},
					{
						name: 'Robot Alert',
						value: 'robot.alert',
						description: 'A robot monitor fired, for example a price dropped below your value',
					},
					{
						name: 'Robot Failed',
						value: 'robot.failed',
						description: 'A robot run failed as a whole',
					},
					{
						name: 'Robot Run Completed',
						value: 'robot.run.completed',
						description: 'A robot run ended, with one result per input row',
					},
					{
						name: 'Task Completed',
						value: 'task.completed',
						description: 'An agent task finished',
					},
					{
						name: 'Task Needs User',
						value: 'task.needs_user',
						description: 'An agent task asked a question and waits for an answer',
					},
				],
				description: 'The events that start the workflow',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Check Signature',
						name: 'checkSignature',
						type: 'boolean',
						default: true,
						description:
							"Whether to refuse deliveries whose X-Agents-Signature does not match the workspace's signing secret. Leave on unless you debug a proxy that changes the body.",
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as TriggerStaticData;
				const url = this.getNodeWebhookUrl('default');
				if (!data.webhookId) return false;
				const r = await browsaApiRequest.call(this, 'GET', '/v1/webhooks');
				const list = Array.isArray(r.webhooks) ? (r.webhooks as IDataObject[]) : [];
				const found = list.find((w) => w.id === data.webhookId);
				if (found && found.url === url && !found.disabled_at) return true;
				delete data.webhookId;
				delete data.webhookUrl;
				delete data.allEvents;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as TriggerStaticData;
				const url = this.getNodeWebhookUrl('default');
				if (!url) {
					throw new NodeOperationError(this.getNode(), 'n8n gave no webhook URL for this trigger');
				}
				const events = subscriptionEvents(this.getNodeParameter('events', []) as string[]);
				if (events.length === 0) {
					throw new NodeOperationError(this.getNode(), "Choose at least one event in 'Events'");
				}

				let allEvents = false;
				let attempt = await postWebhook.call(this, { url, events });
				if (attempt.refused !== undefined) {
					// Browsa refuses event names it does not know yet (400 BAD_REQUEST).
					// Subscribe to every event then; the trigger filters them itself.
					const env = findErrorEnvelope(attempt.refused);
					const unknownEvent =
						env?.code === 'BAD_REQUEST' && /unknown event/i.test(env.error ?? '');
					if (!unknownEvent) throw asNodeError.call(this, attempt.refused);
					attempt = await postWebhook.call(this, { url });
					if (attempt.refused !== undefined) throw asNodeError.call(this, attempt.refused);
					allEvents = true;
				}
				const created = attempt.created ?? {};
				if (typeof created.id !== 'string' || !created.id) {
					throw new NodeOperationError(this.getNode(), 'Browsa did not return a webhook ID');
				}
				data.webhookId = created.id;
				data.webhookUrl = url;
				data.allEvents = allEvents;

				const options = this.getNodeParameter('options', {}) as IDataObject;
				if (options.checkSignature !== false) {
					data.signingSecret = await fetchSigningSecret.call(this);
				}
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as TriggerStaticData;
				if (data.webhookId) {
					try {
						await browsaApiRequest.call(
							this,
							'DELETE',
							`/v1/webhooks/${encodeURIComponent(data.webhookId)}`,
						);
					} catch (thrown) {
						// Already gone on Browsa: nothing left to remove.
						if (findErrorEnvelope(thrown)?.code !== 'NOT_FOUND') return false;
					}
				}
				delete data.webhookId;
				delete data.webhookUrl;
				delete data.allEvents;
				delete data.signingSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const options = this.getNodeParameter('options', {}) as IDataObject;

		if (options.checkSignature !== false) {
			const data = this.getWorkflowStaticData('node') as TriggerStaticData;
			const header = String(this.getHeaderData()['x-agents-signature'] ?? '');
			if (!req.rawBody && typeof req.readRawBody === 'function') await req.readRawBody();
			const raw = req.rawBody;
			let secret = data.signingSecret ?? '';
			if (!secret) {
				secret = await fetchSigningSecret.call(this);
				data.signingSecret = secret;
			}
			if (!raw || !verifySignature(raw, header, secret)) {
				const res = this.getResponseObject();
				res.status(401).json({ error: 'signature check failed' });
				return { noWebhookResponse: true };
			}
		}

		const body = this.getBodyData();
		const selected = this.getNodeParameter('events', []) as string[];
		const event = matchEvent(selected, body);
		// Other events (another selection, webhook.test, or every event after a
		// fallback subscription) are acknowledged and do not start the workflow.
		if (!event) return { webhookResponse: { ok: true, ignored: true } };

		return {
			workflowData: [this.helpers.returnJsonArray([{ event, ...body }])],
		};
	}
}
