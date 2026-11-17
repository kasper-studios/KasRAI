export class BaseAdapter {
  constructor(providerConfig) {
    this.config = providerConfig;
  }

  get id() {
    return this.config.id;
  }

  get name() {
    return this.config.name;
  }

  get baseURL() {
    return this.config.baseURL?.replace(/\/+$/, '') || '';
  }

  get apiKey() {
    return this.config.apiKey || '';
  }

  /**
   * Execute non-streaming completion.
   * Must return standard OpenAI ChatCompletion object.
   * @param {object} [options] - optional `{ signal }` (AbortSignal) to cancel the upstream request.
   */
  async complete(requestPayload, targetModel, options = {}) {
    throw new Error('Method complete() must be implemented by adapter subclass');
  }

  /**
   * Execute streaming completion.
   * Pipes normalized OpenAI SSE chunks to Express response stream.
   * @param {object} [options] - optional `{ signal, idleMs }` (AbortSignal from the router + idle-between-chunks timeout).
   */
  async stream(requestPayload, targetModel, res, options = {}) {
    throw new Error('Method stream() must be implemented by adapter subclass');
  }
}
