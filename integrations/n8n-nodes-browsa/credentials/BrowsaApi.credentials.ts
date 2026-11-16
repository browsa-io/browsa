import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class BrowsaApi implements ICredentialType {
	name = 'browsaApi';

	displayName = 'Browsa API';

	icon: Icon = { light: 'file:../icons/browsa.svg', dark: 'file:../icons/browsa.dark.svg' };

	documentationUrl = 'https://browsa.io/docs#auth';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'e.g. agt_live_...',
			description:
				'Your Browsa API key. Create one in the Browsa dashboard under API keys (https://app.browsa.io/dashboard/keys).',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-API-Key': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://browsa.io',
			url: '/v1/credits',
			method: 'GET',
		},
	};
}
