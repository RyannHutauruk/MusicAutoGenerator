/**
 * Suno AI provider — generates music via browser automation (Playwright).
 *
 * Uses persistent browser sessions with saved cookies for authentication.
 * Supports multiple accounts with rotation and cooldown tracking.
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
const SUNO_URL = "https://suno.com";
const SUNO_CREATE_URL = "https://suno.com/create";

// Daily free tier limit per account
const FREE_DAILY_LIMIT = 50; // credits (each song costs ~5 credits, so ~10 songs/day)

export class SunoProvider implements MusicProvider {
  readonly name = "suno";
  private browser: Browser | null = null;
  private accounts: ProviderAccount[] = [];
  private contexts: Map<string, BrowserContext> = new Map();

  addAccount(account: ProviderAccount): void {
    account.provider = this.name;
    account.dailyLimit = account.dailyLimit || FREE_DAILY_LIMIT;
    this.accounts.push(account);
    logger.info(`Suno: added account ${account.id}`);
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
    logger.info("Suno: browser launched");
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

  /** Pick the next available account (round-robin with cooldown awareness). */
  private pickAccount(): ProviderAccount | null {
    const now = Date.now();
    const available = this.accounts
      .filter((a) => (!a.cooldownUntil || a.cooldownUntil < now) && a.dailyGenerated < a.dailyLimit)
      .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    return available.length > 0 ? available[0] : null;
  }

  /** Get or create a browser context with persistent cookies for an account. */
  private async getContext(account: ProviderAccount): Promise<BrowserContext> {
    if (this.contexts.has(account.id)) {
      return this.contexts.get(account.id)!;
    }

    const storagePath = path.join(SESSIONS_DIR, `suno-${account.id}`);
    fs.mkdirSync(storagePath, { recursive: true });

    const stateFile = path.join(storagePath, "state.json");
    let storageState: string | undefined;
    if (fs.existsSync(stateFile)) {
      storageState = stateFile;
      logger.info(`Suno: loading saved session for account ${account.id}`);
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

  /** Save browser state (cookies, localStorage) for an account. */
  private async saveSession(account: ProviderAccount, context: BrowserContext): Promise<void> {
    const storagePath = path.join(SESSIONS_DIR, `suno-${account.id}`);
    const stateFile = path.join(storagePath, "state.json");
    const state = await context.storageState();
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    logger.info(`Suno: saved session for account ${account.id}`);
  }

  /** Check if we're logged into Suno. */
  private async isLoggedIn(page: Page): Promise<boolean> {
    try {
      await page.goto(SUNO_CREATE_URL, { waitUntil: "networkidle", timeout: 30000 });
      // If we're redirected to login or see sign-in button, not logged in
      const url = page.url();
      if (url.includes("sign-in") || url.includes("login")) {
        return false;
      }
      // Check for create button or textarea as indicator of logged-in state
      const createArea = await page.$('textarea, [data-testid="create-input"], [placeholder*="song"]');
      return createArea !== null;
    } catch {
      return false;
    }
  }

  /** Login with cookie — user must provide their session cookie. */
  private async loginWithCookie(page: Page, account: ProviderAccount): Promise<boolean> {
    if (!account.cookiePath) {
      logger.warn(`Suno: no cookie path for account ${account.id}`);
      return false;
    }

    try {
      const cookieData = fs.readFileSync(account.cookiePath, "utf-8").trim();
      // Set the __client cookie
      await page.context().addCookies([
        {
          name: "__client",
          value: cookieData,
          domain: ".suno.com",
          path: "/",
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
        },
      ]);
      await page.goto(SUNO_CREATE_URL, { waitUntil: "networkidle", timeout: 30000 });
      return await this.isLoggedIn(page);
    } catch (e) {
      logger.error(`Suno: cookie login failed for ${account.id}: ${e}`);
      return false;
    }
  }

  async generate(options: GenerateOptions): Promise<TrackResult | null> {
    const account = this.pickAccount();
    if (!account) {
      logger.warn("Suno: no available accounts");
      return null;
    }

    const context = await this.getContext(account);
    const page = await context.newPage();

    try {
      // Check login
      const loggedIn = await this.isLoggedIn(page);
      if (!loggedIn) {
        logger.info(`Suno: attempting cookie login for ${account.id}`);
        const loginOk = await this.loginWithCookie(page, account);
        if (!loginOk) {
          logger.error(`Suno: login failed for ${account.id}`);
          account.cooldownUntil = Date.now() + 3600000; // 1 hour cooldown
          return null;
        }
      }

      await this.saveSession(account, context);

      // Navigate to create page
      if (!page.url().includes("/create")) {
        await page.goto(SUNO_CREATE_URL, { waitUntil: "networkidle", timeout: 30000 });
      }

      await randomDelay(1000, 2000);

      // Build the prompt with mood/tags
      let fullPrompt = options.prompt;
      if (options.mood) fullPrompt += `, ${options.mood}`;

      // Look for the song description input and fill it
      const promptInput = await page.$(
        'textarea[placeholder*="song"], textarea[placeholder*="describe"], [data-testid="create-input"], textarea'
      );
      if (!promptInput) {
        logger.error("Suno: could not find prompt input");
        return null;
      }

      await promptInput.click();
      await randomDelay(300, 600);
      await promptInput.fill(fullPrompt);
      await randomDelay(500, 1000);

      // Toggle instrumental if needed
      if (options.instrumental !== false) {
        const instrumentalToggle = await page.$(
          'button:has-text("Instrumental"), [aria-label*="nstrumental"], label:has-text("Instrumental")'
        );
        if (instrumentalToggle) {
          await instrumentalToggle.click();
          await randomDelay(300, 500);
        }
      }

      // Click create/generate button
      const createBtn = await page.$(
        'button:has-text("Create"), button:has-text("Generate"), button[data-testid="create-button"]'
      );
      if (!createBtn) {
        logger.error("Suno: could not find create button");
        return null;
      }

      await createBtn.click();
      logger.info(`Suno: generating "${fullPrompt}" for ${options.genre}`);

      // Wait for generation to complete (poll for audio)
      const trackUrl = await this.waitForTrack(page, 300000); // 5 min timeout
      if (!trackUrl) {
        logger.error("Suno: generation timed out or failed");
        return null;
      }

      // Download the track
      const genreFolder = ensureGenreFolder(options.genre);
      const filename = generateTrackFilename(options.genre);
      const filePath = path.join(genreFolder, filename);

      await this.downloadTrack(trackUrl, filePath);

      // Update account stats
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

      // Save metadata
      saveMetadata(filePath, {
        prompt: fullPrompt,
        provider: this.name,
        createdAt: result.createdAt,
        duration: result.duration,
        genre: options.genre,
      });

      logger.info(`Suno: generated ${filename} for ${options.genre}`);
      return result;
    } catch (e) {
      logger.error(`Suno: generation error — ${e}`);
      return null;
    } finally {
      await page.close();
    }
  }

  /** Wait for a generated track's audio URL to appear. */
  private async waitForTrack(page: Page, timeoutMs: number): Promise<string | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      await randomDelay(5000, 8000);

      // Look for audio elements or download links
      const audioUrl = await page.evaluate(() => {
        // Check for audio elements
        const audios = document.querySelectorAll("audio source, audio");
        for (const a of audios) {
          const src = (a as HTMLAudioElement).src || (a as HTMLSourceElement).src;
          if (src && src.includes("cdn")) return src;
        }
        // Check for download links
        const links = document.querySelectorAll('a[href*="cdn"], a[download]');
        for (const l of links) {
          const href = (l as HTMLAnchorElement).href;
          if (href && href.includes(".mp3")) return href;
        }
        return null;
      });

      if (audioUrl) {
        return audioUrl;
      }

      // Check for error states
      const hasError = await page.$('text="error"');
      if (hasError) {
        logger.warn("Suno: detected error state on page");
        return null;
      }
    }

    return null;
  }

  /** Download audio file from URL. */
  private async downloadTrack(url: string, destPath: string): Promise<void> {
    const { default: https } = await import("https");
    const { default: http } = await import("http");

    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;
      const file = fs.createWriteStream(destPath);
      client.get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          // Follow redirect
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            const redirectClient = redirectUrl.startsWith("https") ? https : http;
            redirectClient.get(redirectUrl, (res2) => {
              res2.pipe(file);
              file.on("finish", () => { file.close(); resolve(); });
            }).on("error", reject);
          } else {
            reject(new Error("Redirect without location"));
          }
        } else {
          res.pipe(file);
          file.on("finish", () => { file.close(); resolve(); });
        }
      }).on("error", reject);
    });
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
    logger.info("Suno: browser closed");
  }
}
