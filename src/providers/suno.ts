/**
 * Suno AI provider — generates music via browser automation (Playwright).
 *
 * Uses persistent browser sessions with saved cookies for authentication.
 * Supports multiple accounts with rotation and cooldown tracking.
 *
 * The Suno API blocks programmatic generation (token validation), so browser
 * automation is the only reliable method for free-tier users.
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import path from "path";
import fs from "fs";
import https from "https";
import http from "http";
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

// Free tier: 50 credits/day, each song costs ~5 credits = ~10 songs/day
const FREE_DAILY_LIMIT = 50;

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
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
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

  private pickAccount(): ProviderAccount | null {
    const now = Date.now();
    const available = this.accounts
      .filter((a) => (!a.cooldownUntil || a.cooldownUntil < now) && a.dailyGenerated < a.dailyLimit)
      .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    return available.length > 0 ? available[0] : null;
  }

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

  private async saveSession(account: ProviderAccount, context: BrowserContext): Promise<void> {
    const storagePath = path.join(SESSIONS_DIR, `suno-${account.id}`);
    const stateFile = path.join(storagePath, "state.json");
    const state = await context.storageState();
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    logger.info(`Suno: saved session for account ${account.id}`);
  }

  private async isLoggedIn(page: Page): Promise<boolean> {
    try {
      // Suno's create page is now the home page
      await page.goto(SUNO_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(5000);

      const url = page.url();
      if (url.includes("sign-in") || url.includes("login") || url.includes("auth")) {
        return false;
      }

      // Check for the chat/create textarea
      const chatInput = await page.$('textarea[placeholder*="Chat"], textarea[placeholder*="music"], textarea[placeholder*="song"], textarea');
      return chatInput !== null;
    } catch {
      return false;
    }
  }

  private async loginWithCookie(page: Page, account: ProviderAccount): Promise<boolean> {
    if (!account.cookiePath) {
      logger.warn(`Suno: no cookie path for account ${account.id}`);
      return false;
    }

    try {
      const cookieData = fs.readFileSync(account.cookiePath, "utf-8").trim();
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
      await page.goto(SUNO_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(5000);
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

    // Intercept audio download URLs from API responses
    let capturedAudioUrls: string[] = [];
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("/api/feed") || url.includes("/api/gen") || url.includes("/api/clip")) {
        try {
          const json = await response.json();
          const clips = Array.isArray(json) ? json : json?.clips || json?.data || [];
          for (const clip of clips) {
            if (clip?.audio_url && clip?.status === "complete") {
              capturedAudioUrls.push(clip.audio_url);
              logger.info(`Suno: captured audio URL from API response`);
            }
          }
        } catch {
          // Not JSON or no clips
        }
      }
    });

    try {
      // Check login
      let loggedIn = await this.isLoggedIn(page);
      if (!loggedIn) {
        logger.info(`Suno: attempting cookie login for ${account.id}`);
        loggedIn = await this.loginWithCookie(page, account);
        if (!loggedIn) {
          logger.error(`Suno: login failed for ${account.id}`);
          account.cooldownUntil = Date.now() + 3600000;
          return null;
        }
      }

      await this.saveSession(account, context);
      logger.info(`Suno: logged in as ${account.id}`);

      await randomDelay(1000, 2000);

      // Build the prompt
      let fullPrompt = options.prompt;
      if (options.mood) fullPrompt += `, ${options.mood}`;
      if (options.instrumental !== false) fullPrompt += ", instrumental";

      // Find the chat/create textarea (Suno's current UI uses "Chat to make music")
      const promptInput = await page.$('textarea[placeholder*="Chat"], textarea[placeholder*="music"], textarea[placeholder*="song"], textarea');
      if (!promptInput) {
        logger.error("Suno: could not find prompt textarea");
        // Take debug screenshot
        await page.screenshot({ path: path.join(SESSIONS_DIR, `suno-debug-${Date.now()}.png`) });
        return null;
      }

      await promptInput.click();
      await randomDelay(300, 600);
      await promptInput.fill(fullPrompt);
      await randomDelay(500, 1000);

      logger.info(`Suno: submitting prompt "${fullPrompt}"`);

      // Click Create button (the one near the textarea, not the nav one)
      // Try multiple selectors for the create/submit button
      let created = false;
      const buttonSelectors = [
        'button:has-text("Create"):near(textarea)',
        'form button[type="submit"]',
        'button:has-text("Create")',
      ];

      for (const sel of buttonSelectors) {
        try {
          const btns = await page.$$(sel);
          // Pick the last "Create" button (usually the one near the input)
          const btn = btns.length > 1 ? btns[btns.length - 1] : btns[0];
          if (btn) {
            await btn.click();
            created = true;
            break;
          }
        } catch {
          continue;
        }
      }

      // Fallback: press Enter to submit
      if (!created) {
        logger.info("Suno: trying Enter key to submit");
        await promptInput.press("Enter");
      }

      logger.info(`Suno: generating "${fullPrompt}" for ${options.genre}`);

      // Wait for generation to complete
      // Monitor both: intercepted API responses and page audio elements
      const audioUrl = await this.waitForTrack(page, capturedAudioUrls, 300000);
      if (!audioUrl) {
        logger.error("Suno: generation timed out or failed");
        await page.screenshot({ path: path.join(SESSIONS_DIR, `suno-timeout-${Date.now()}.png`) });
        return null;
      }

      // Download the track
      const genreFolder = ensureGenreFolder(options.genre);
      const filename = generateTrackFilename(options.genre);
      const filePath = path.join(genreFolder, filename);

      await this.downloadFile(audioUrl, filePath);

      // Update account stats
      account.lastUsed = Date.now();
      account.totalGenerated++;
      account.dailyGenerated += 5; // Each song costs ~5 credits

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

      const sizeMb = fs.existsSync(filePath) ? (fs.statSync(filePath).size / (1024 * 1024)).toFixed(2) : "?";
      logger.info(`Suno: generated ${filename} (${sizeMb} MB) for ${options.genre}`);
      return result;
    } catch (e) {
      logger.error(`Suno: generation error — ${e}`);
      await page.screenshot({ path: path.join(SESSIONS_DIR, `suno-error-${Date.now()}.png`) }).catch(() => {});
      return null;
    } finally {
      await page.close();
    }
  }

  /** Wait for a generated track's audio URL — checks both API interception and DOM. */
  private async waitForTrack(page: Page, capturedUrls: string[], timeoutMs: number): Promise<string | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      // Check intercepted API responses first (most reliable)
      if (capturedUrls.length > 0) {
        return capturedUrls[capturedUrls.length - 1];
      }

      // Also check for audio elements in the DOM
      const audioUrl = await page.evaluate(() => {
        const audios = document.querySelectorAll("audio source, audio");
        for (const a of audios) {
          const src = (a as HTMLAudioElement).src || (a as HTMLSourceElement).src;
          if (src && (src.includes("cdn") || src.includes(".mp3") || src.includes("audio"))) return src;
        }
        // Check for download links
        const links = document.querySelectorAll('a[href*="cdn"], a[download], a[href*=".mp3"]');
        for (const l of links) {
          const href = (l as HTMLAnchorElement).href;
          if (href) return href;
        }
        return null;
      });

      if (audioUrl) {
        return audioUrl;
      }

      // Check for error states
      const hasError = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes("something went wrong") || text.includes("generation failed") || text.includes("out of credits");
      });

      if (hasError) {
        logger.warn("Suno: detected error state on page");
        return null;
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (elapsed % 30 === 0) {
        logger.info(`Suno: waiting for generation... (${elapsed}s elapsed)`);
      }

      await new Promise((r) => setTimeout(r, 5000));
    }

    return null;
  }

  /** Download a file from URL, following redirects. */
  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const doGet = (downloadUrl: string, redirectCount: number = 0) => {
        if (redirectCount > 5) { reject(new Error("Too many redirects")); return; }
        const client = downloadUrl.startsWith("https") ? https : http;
        client.get(downloadUrl, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            if (res.headers.location) {
              doGet(res.headers.location, redirectCount + 1);
            } else {
              reject(new Error("Redirect without location"));
            }
            return;
          }
          const file = fs.createWriteStream(destPath);
          res.pipe(file);
          file.on("finish", () => { file.close(); resolve(); });
          file.on("error", reject);
        }).on("error", reject);
      };
      doGet(url);
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
