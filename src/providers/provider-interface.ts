/** Core provider interface — all music providers must implement this. */

export interface TrackResult {
  id: string;
  title: string;
  prompt: string;
  provider: string;
  filePath: string;
  duration: number; // seconds
  genre: string;
  createdAt: string;
}

export interface ProviderAccount {
  id: string;
  provider: string;
  email?: string;
  cookiePath?: string;
  /** Authentication type: 'cookie' (manual cookie paste) or 'session' (browser login, persistent) */
  authType?: "cookie" | "session";
  /** Path to saved Playwright browser state for session-based auth */
  sessionPath?: string;
  lastUsed?: number;
  cooldownUntil?: number;
  totalGenerated: number;
  dailyGenerated: number;
  dailyLimit: number;
}

export interface GenerateOptions {
  prompt: string;
  genre: string;
  duration?: number; // seconds
  mood?: string;
  instrumental?: boolean;
  tags?: string;
}

export interface ProviderStatus {
  name: string;
  available: boolean;
  accountCount: number;
  readyAccounts: number;
  dailyRemaining: number;
}

export interface MusicProvider {
  /** Provider name (e.g. "suno", "udio") */
  readonly name: string;

  /** Initialize the provider (launch browser, etc.) */
  init(): Promise<void>;

  /** Check if provider is ready to generate */
  isReady(): Promise<boolean>;

  /** Get provider status */
  getStatus(): Promise<ProviderStatus>;

  /** Generate a track. Returns null if generation fails. */
  generate(options: GenerateOptions): Promise<TrackResult | null>;

  /** Add an account to this provider */
  addAccount(account: ProviderAccount): void;

  /** Get all accounts */
  getAccounts(): ProviderAccount[];

  /** Cleanup (close browser, etc.) */
  destroy(): Promise<void>;
}
