import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';

export default class XAIProvider extends BaseProvider {
  name = 'xAI';
  getApiKeyLink = 'https://docs.x.ai/docs/quickstart#creating-an-api-key';

  config = {
    apiTokenKey: 'XAI_API_KEY',
  };

  staticModels: ModelInfo[] = [
    { name: 'grok-4', label: 'xAI Grok 4', provider: 'xAI', maxTokenAllowed: 256000 },
    { name: 'grok-4-07-09', label: 'xAI Grok 4 (07-09)', provider: 'xAI', maxTokenAllowed: 256000 },
    { name: 'grok-3-mini', label: 'xAI Grok 3 Mini', provider: 'xAI', maxTokenAllowed: 131000 },
    { name: 'grok-3-mini-fast', label: 'xAI Grok 3 Mini Fast', provider: 'xAI', maxTokenAllowed: 131000 },
    { name: 'grok-code-fast-1', label: 'xAI Grok Code Fast 1', provider: 'xAI', maxTokenAllowed: 131000 },
  ];
}
