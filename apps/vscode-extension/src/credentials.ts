/**
 * Thin credential interface (guide §9). Offline FakeProvider needs no secrets.
 * VS Code implementation uses SecretStorage; never put secrets in panel payloads.
 */
export interface CredentialStore {
  get(providerId: string): Promise<string | undefined>;
  set(providerId: string, secret: string): Promise<void>;
  delete(providerId: string): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly map = new Map<string, string>();

  async get(providerId: string): Promise<string | undefined> {
    return this.map.get(providerId);
  }

  async set(providerId: string, secret: string): Promise<void> {
    this.map.set(providerId, secret);
  }

  async delete(providerId: string): Promise<void> {
    this.map.delete(providerId);
  }
}

/** VS Code SecretStorage-backed store. Constructed only when `vscode` is available. */
export class VsCodeCredentialStore implements CredentialStore {
  constructor(
    private readonly secrets: {
      get(key: string): Thenable<string | undefined>;
      store(key: string, value: string): Thenable<void>;
      delete(key: string): Thenable<void>;
    },
    private readonly prefix = "kur3.provider.",
  ) {}

  async get(providerId: string): Promise<string | undefined> {
    return this.secrets.get(this.prefix + providerId);
  }

  async set(providerId: string, secret: string): Promise<void> {
    await this.secrets.store(this.prefix + providerId, secret);
  }

  async delete(providerId: string): Promise<void> {
    await this.secrets.delete(this.prefix + providerId);
  }
}
