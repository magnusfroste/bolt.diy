import type { LanguageModel } from 'ai';
import { BaseProvider, getOpenAILikeModel } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import { logger } from '~/utils/logger';

/*
 * GarageAI – an OpenAI-compatible gateway in front of self-hosted models (api.garageai.eu).
 * `garageai/auto` lets the gateway pick the model per request. This is the default provider
 * of the Shipholm build (code.shipholm.com); the key lives server-side in GARAGEAI_API_KEY.
 */
export const GARAGEAI_DEFAULT_BASE_URL = 'https://api.garageai.eu/v1';
export const GARAGEAI_AUTO_MODEL = 'garageai/auto';

interface ModelsResponse {
  data: Array<{ id: string; max_input_tokens?: number; max_output_tokens?: number; mode?: string }>;
}

export default class GarageAIProvider extends BaseProvider {
  name = 'GarageAI';
  getApiKeyLink = 'https://garageai.eu';

  config = {
    baseUrlKey: 'GARAGEAI_API_BASE_URL',
    apiTokenKey: 'GARAGEAI_API_KEY',
  };

  staticModels: ModelInfo[] = [
    {
      name: GARAGEAI_AUTO_MODEL,
      label: 'GarageAI Auto',
      provider: 'GarageAI',
      maxTokenAllowed: 1048576,
      maxCompletionTokens: 32768,
    },
  ];

  private _resolve(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ) {
    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv,
      defaultBaseUrlKey: 'GARAGEAI_API_BASE_URL',
      defaultApiTokenKey: 'GARAGEAI_API_KEY',
    });

    return { baseUrl: (baseUrl || GARAGEAI_DEFAULT_BASE_URL).replace(/\/+$/, ''), apiKey };
  }

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    const { baseUrl, apiKey } = this._resolve(apiKeys, settings, serverEnv);

    if (!apiKey) {
      return [];
    }

    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: this.createTimeoutSignal(),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const res = (await response.json()) as ModelsResponse;

      return res.data
        .filter((m) => m.id !== GARAGEAI_AUTO_MODEL && (!m.mode || m.mode === 'chat'))
        .map((m) => ({
          name: m.id,
          label: m.id,
          provider: this.name,
          maxTokenAllowed: m.max_input_tokens || 32768,
          maxCompletionTokens: m.max_output_tokens || 8192,
        }));
    } catch (error) {
      logger.info(`${this.name}: could not list models`, error);
      return [];
    }
  }

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModel {
    const { model, serverEnv, apiKeys, providerSettings } = options;

    const { baseUrl, apiKey } = this._resolve(
      apiKeys,
      providerSettings?.[this.name],
      this.convertEnvToRecord(serverEnv),
    );

    if (!apiKey) {
      throw new Error(`Missing API key for ${this.name} (GARAGEAI_API_KEY)`);
    }

    return getOpenAILikeModel(baseUrl, apiKey, model);
  }
}
