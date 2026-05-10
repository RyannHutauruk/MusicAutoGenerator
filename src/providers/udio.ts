/**
 * Udio AI provider — generates music via browser automation (Playwright).
 *
 * Uses persistent browser sessions with saved cookies for authentication.
 * Udio offers a free tier with limited daily generations.
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import {
  MusicProvider,
  ProviderAccount,
  GenerateOptions,
  TrackResult,
  ProviderStatus,
} from "./provider-interface";
import { logger } from "../utils/logger";
import {
  ensureGenreFolder,
  generateTrackFilename,
  saveMetadata,
  randomDelay,
} from "../utils/helpers";

const SESSIONS_DIR = path.resolve(process.cwd(), "sessions");
const UDIO_URL = "https://www.udio.com";
const UDIO_CREATE_URL = "https://www.udio.com/create";

const FREE_DAILY_LIMIT = 10; // Udio free tier

export class UdioProvider implements MusicProvider {
  readonly name = "udio";
  private browser: Browser | null = null;
  private accounts: ProviderAccount[] = [];
  private contexts: Map<string, BrowserContext> = new Map();

  addAccount(account: ProviderAccount): void {
    account.provider = this.name;
    account.dailyLimit = account.dailyLimit || FREE_DAILY_LIMIT;
    this.accounts.push(account);
    logger.info(`Udio: added account ${account.id}`);
  }

  getAccounts(): ProviderAccount[] {
    return this.accounts;
  }

  async init(): Promise<void> {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    logger.info("Udio: browser launched");
  }

  async isReady(): Promise<boolean> {
    return this.browser !== null && this.accounts.length > 0;
  }

  async getStatus(): Promise<ProviderStatus> {
    const now = Date.now();
    const ready = this.accounts.filter(
      (a) => !a.cooldownUntil || a.cooldownUntil < now
    );
    const remaining = ready.reduce(
      (sum, a) => sum + (a.dailyLimit - a.dailyGenerated),
      0
    );
    return {
      name: this.name,
      available: this.browser !== null,
      accountCount: this.accounts.length,
      readyAccounts: ready.length,
      dailyRemaining: remaining,
    };
  }

  private pickAccount(): ProviderAccount | null {
    const now = Date.now();
    const available = this.accounts
      .filter(
        (a) =>
          (!a.cooldownUntil || a.cooldownUntil < now) &&
          a.dailyGenerated < a.dailyLimit
      )
      .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    return available.length > 0 ? available[0] : null;
  }

  private async getContext(account: ProviderAccount): Promise<BrowserContext> {
    if (this.contexts.has(account.id)) {
      return this.contexts.get(account.id)!;
    }

    const storagePath = path.join(SESSIONS_DIR, `udio-${account.id}`);
    fs.mkdirSync(storagePath, { recursive: true });
    const stateFile = path.join(storagePath, "state.json");

    let storageState: string | undefined;
    if (fs.existsSync(stateFile)) {
      storageState = stateFile;
      logger.info(`Udio: loading saved session for account ${account.id}`);
    }

    const context = await this.browser!.newContext({
      storageState: storageState as any,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
    });

    this.contexts.set(account.id, context);
    return context;
  }

  private async saveSession(
    account: ProviderAccount,
    context: BrowserContext
  ): Promise<void> {
    const storagePath = path.join(SESSIONS_DIR, `udio-${account.id}`);
    const stateFile = path.join(storagePath, "state.json");
    const state = await context.storageState();
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  async generate(options: GenerateOptions): Promise<TrackResult | null> {
    const account = this.pickAccount();
    if (!account) {
      logger.warn("Udio: no available accounts");
      return null;
    }

    const context = await this.getContext(account);
    const page = await context.newPage();

    try {
      await page.goto(UDIO_CREATE_URL, {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await randomDelay(1500, 3000);

      // Check if logged in
      const url = page.url();
      if (url.includes("sign-in") || url.includes("login")) {
        logger.warn(`Udio: account ${account.id} not logged in`);
        account.cooldownUntil = Date.now() + 3600000;
        return null;
      }

      // Build prompt
      let fullPrompt = options.prompt;
      if (options.mood) fullPrompt += `, ${options.mood} mood`;

      // Find prompt input
      const promptInput = await page.$(
        'textarea, input[type="text"][placeholder*="describe"], [data-testid="prompt-input"]'
      );
      if (!promptInput) {
        logger.error("Udio: could not find prompt input");
        return null;
      }

      await promptInput.click();
      await randomDelay(300, 600);
      await promptInput.fill(fullPrompt);
      await randomDelay(500, 1000);

      // Click create
      const createBtn = await page.$(
        'button:has-text("Create"), button:has-text("Generate"), button[type="submit"]'
      );
      if (!createBtn) {
        logger.error("Udio: could not find create button");
        return null;
      }

      await createBtn.click();
      logger.info(`Udio: generating "${fullPrompt}" for ${options.genre}`);

      // Wait for audio
      const trackUrl = await this.waitForTrack(page, 300000);
      if (!trackUrl) {
        logger.error("Udio: generation timed out");
        return null;
      }

      // Download
      const genreFolder = ensureGenreFolder(options.genre);
      const filename = generateTrackFilename(options.genre);
      const filePath = path.join(genreFolder, filename);
      await this.downloadTrack(page, trackUrl, filePath);

      account.lastUsed = Date.now();
      account.totalGenerated++;
      account.dailyGenerated++;
      await this.saveSession(account, context);

      const result: TrackResult = {
        id: nanoid(),
        title: fullPrompt.substring(0, 50),
        prompt: fullPrompt,
        provider: this.name,
        filePath,
        duration: options.duration || 120,
        genre: options.genre,
        createdAt: new Date().toISOString(),
      };

      saveMetadata(filePath, {
        prompt: fullPrompt,
        provider: this.name,
        createdAt: result.createdAt,
        duration: result.duration,
        genre: options.genre,
      });

      logger.info(`Udio: generated ${filename} for ${options.genre}`);
      return result;
    } catch (e) {
      logger.error(`Udio: generation error — ${e}`);
      return null;
    } finally {
      await page.close();
    }
  }

  private async waitForTrack(
    page: Page,
    timeoutMs: number
  ): Promise<string | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await randomDelay(5000, 8000);
      const audioUrl = await page.evaluate(() => {
        const audios = document.querySelectorAll("audio source, audio");
        for (const a of audios) {
          const src =
            (a as HTMLAudioElement).src || (a as HTMLSourceElement).src;
          if (src && (src.includes("cdn") || src.includes(".mp3"))) return src;
        }
        return null;
      });
      if (audioUrl) return audioUrl;
    }
    return null;
  }

  private async downloadTrack(
    page: Page,
    url: string,
    destPath: string
  ): Promise<void> {
    // Use page context for download (handles auth cookies)
    const response = await page.request.get(url);
    const buffer = await response.body();
    fs.writeFileSync(destPath, buffer);
  }

  async destroy(): Promise<void> {
    for (const [, ctx] of this.contexts) {
      await ctx.close().catch(() => {});
    }
    this.contexts.clear();
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    logger.info("Udio: browser closed");
  }
}
