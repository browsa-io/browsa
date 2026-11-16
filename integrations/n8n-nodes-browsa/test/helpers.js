'use strict';

// A small stand-in for n8n's IExecuteFunctions: enough for the Browsa node.
// `responses` is a queue: each HTTP call takes the next entry (an object to
// return, an Error to throw, or a function of the request).
function makeContext({ params = {}, responses = [], items = [{ json: {} }], continueOnFail = false } = {}) {
	const calls = [];
	const node = {
		id: 'test-node',
		name: 'Browsa',
		type: 'n8n-nodes-browsa.browsa',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};
	return {
		calls,
		getInputData: () => items,
		getNodeParameter: (name, _itemIndex, fallback) =>
			Object.prototype.hasOwnProperty.call(params, name) ? params[name] : fallback,
		getNode: () => node,
		continueOnFail: () => continueOnFail,
		getExecutionCancelSignal: () => undefined,
		helpers: {
			async httpRequestWithAuthentication(credentialType, request) {
				calls.push({ credentialType, request });
				if (responses.length === 0) throw new Error(`unexpected request ${request.method} ${request.url}`);
				const next = responses.shift();
				if (next instanceof Error) throw next;
				return typeof next === 'function' ? next(request) : next;
			},
			async prepareBinaryData(buffer, fileName, mimeType) {
				return { data: buffer.toString('base64'), fileName, mimeType };
			},
		},
	};
}

// What n8n's httpRequestWithAuthentication throws for a non-2xx answer:
// a NodeApiError built from the Axios error, Browsa's envelope in context.data.
function apiFailure(status, envelope) {
	const { NodeApiError } = require('n8n-workflow');
	const axiosLike = new Error(`Request failed with status code ${status}`);
	axiosLike.response = { status, data: envelope };
	axiosLike.isAxiosError = true;
	return new NodeApiError(makeContext().getNode(), axiosLike);
}

module.exports = { makeContext, apiFailure };
