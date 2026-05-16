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
      .sort((a, b) => {
        // Prefer session accounts over cookie accounts
        const aSession = a.authType === "session" ? 0 : 1;
        const bSession = b.authType === "session" ? 0 : 1;
        if (aSession !== bSession) return aSession - bSession;
        // Then sort by least recently used
        return (a.lastUsed || 0) - (b.lastUsed || 0);
      });
    return available.length > 0 ? available[0] : null;
  }

  private async getContext(account: ProviderAccount): Promise<BrowserContext> {
    if (this.contexts.has(account.id)) {
      return this.contexts.get(account.id)!;
    }

    // For session-based auth, use the saved Playwright state file directly
    let storageState: string | undefined;
    if (account.authType === "session" && account.sessionPath && fs.existsSync(account.sessionPath)) {
      storageState = account.sessionPath;
      logger.info(`Suno: loading saved login session for account ${account.id}`);
    } else {
      // Legacy: check the old session path
      const storagePath = path.join(SESSIONS_DIR, `suno-${account.id}`);
      fs.mkdirSync(storagePath, { recursive: true });
      const stateFile = path.join(storagePath, "state.json");
      if (fs.existsSync(stateFile)) {
        storageState = stateFile;
        logger.info(`Suno: loading saved session for account ${account.id}`);
      }
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
    const state = await context.storageState();
    const stateJson = JSON.stringify(state, null, 2);

    // Save to session-based path if available
    if (account.sessionPath) {
      fs.mkdirSync(path.dirname(account.sessionPath), { recursive: true });
      fs.writeFileSync(account.sessionPath, stateJson);
    }

    // Also save to legacy path for backwards compatibility
    const storagePath = path.join(SESSIONS_DIR, `suno-${account.id}`);
    fs.mkdirSync(storagePath, { recursive: true });
    fs.writeFileSync(path.join(storagePath, "state.json"), stateJson);

    logger.info(`Suno: saved session for account ${account.id}`);
  }

  private async isLoggedIn(page: Page): Promise<boolean> {
    try {
      await page.goto(SUNO_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(5000);

      const url = page.url();
      if (url.includes("sign-in") || url.includes("login") || url.includes("auth")) {
        return false;
      }

      // Check for the chat/create textarea or credits indicator (logged-in indicators)
      const hasTextarea = await page.$('textarea') !== null;
      const hasCredits = await page.$('text=credits') !== null;
      return hasTextarea || hasCredits;
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

  /**
   * Interactive login: opens a visible browser window for the user to log in manually.
   * Saves the session state for future headless use.
   * Returns true if login succeeded.
   */
  async loginInteractive(account: ProviderAccount): Promise<boolean> {
    const sessionPath = account.sessionPath ||
      path.join(SESSIONS_DIR, `${account.id}-state.json`);

    logger.info(`Suno: opening browser for interactive login (account: ${account.id})`);
    console.log("\n================================================");
    console.log("  A browser window will open.");
    console.log("  Please log in to Suno using your Google account.");
    console.log("  The window will close automatically once logged in.");
    console.log("  (or close it manually after logging in)");
    console.log("================================================\n");

    // Launch a HEADED (visible) browser for manual login
    const headedBrowser = await chromium.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    let storageState: string | undefined;
    if (fs.existsSync(sessionPath)) {
      storageState = sessionPath;
    }

    const context = await headedBrowser.newContext({
      storageState: storageState as any,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    try {
      await page.goto(SUNO_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Poll until user is logged in (check every 3 seconds for up to 5 minutes)
      const maxWait = 300000;
      const start = Date.now();
      let loggedIn = false;

      while (Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 3000));

        try {
          const url = page.url();
          if (url.includes("sign-in") || url.includes("accounts.google.com")) {
            continue; // Still in login flow
          }

          const hasCredits = await page.$('text=credits');
          const hasTextarea = await page.$('textarea');
          if (hasCredits || hasTextarea) {
            loggedIn = true;
            break;
          }
        } catch {
          // Page might be navigating
        }
      }

      if (loggedIn) {
        // Save session state
        const state = await context.storageState();
        fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
        fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2));
        account.sessionPath = sessionPath;
        account.authType = "session";

        logger.info(`Suno: login successful! Session saved to ${sessionPath}`);
        console.log("\n  Login successful! Session saved.");
        console.log("  You can now close this browser window.\n");

        // Try to get the email from the page
        try {
          const email = await page.evaluate(() => {
            const text = document.body.innerText;
            const match = text.match(/[\w.-]+@[\w.-]+\.\w+/);
            return match ? match[0] : null;
          });
          if (email) account.email = email;
        } catch {}

        return true;
      } else {
        logger.warn("Suno: login timed out (5 minutes)");
        console.log("\n  Login timed out. Please try again.\n");
        return false;
      }
    } catch (e) {
      logger.error(`Suno: interactive login error — ${e}`);
      return false;
    } finally {
      await context.close();
      await headedBrowser.close();
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
    const capturedAudioUrls: string[] = [];
    const seenClipIds: Set<string> = new Set();
    page.on("response", async (response) => {
      const url = response.url();
      const status = response.status();
      // Broad match: any suno API response that might contain clip data
      const isSunoApi = url.includes("suno.com/api") || url.includes("studio-api") || url.includes("clerk");
      if (!isSunoApi || status !== 200) return;

      try {
        const contentType = response.headers()["content-type"] || "";
        if (!contentType.includes("json")) return;

        const text = await response.text();
        const json = JSON.parse(text);

        // Deep search for audio URLs in any JSON response shape
        const searchForAudio = (obj: any): void => {
          if (!obj || typeof obj !== "object") return;
          if (Array.isArray(obj)) {
            obj.forEach(searchForAudio);
            return;
          }
          // Check if this object has an audio_url
          if (obj.audio_url && typeof obj.audio_url === "string") {
            const clipId = obj.id || obj.clip_id || "unknown";
            const clipStatus = obj.status || "unknown";
            if (!seenClipIds.has(clipId)) {
              seenClipIds.add(clipId);
              logger.info(`Suno: [API] clip ${clipId} status=${clipStatus} audio_url=${obj.audio_url ? "present" : "missing"}`);
            }
            if ((clipStatus === "complete" || clipStatus === "streaming") && !obj.audio_url.includes("sil-100")) {
              capturedAudioUrls.push(obj.audio_url);
              logger.info(`Suno: captured audio URL from API (status: ${clipStatus})`);
            }
          }
          // Recurse into nested objects
          for (const val of Object.values(obj)) {
            if (typeof val === "object" && val !== null) {
              searchForAudio(val);
            }
          }
        };
        searchForAudio(json);
      } catch {
        // Not JSON or parsing failed — ignore
      }
    });

    // Also log key API requests for debugging
    page.on("request", (request) => {
      const url = request.url();
      if ((url.includes("suno.com/api") || url.includes("studio-api")) && request.method() === "POST") {
        logger.info(`Suno: [API] POST ${url.split("?")[0]}`);
      }
    });

    try {
      // Check login — session-based accounts have saved browser state
      let loggedIn = await this.isLoggedIn(page);
      if (!loggedIn && account.authType === "cookie") {
        logger.info(`Suno: attempting cookie login for ${account.id}`);
        loggedIn = await this.loginWithCookie(page, account);
      }
      if (!loggedIn) {
        logger.error(`Suno: login failed for ${account.id} — ${account.authType === "session" ? "session expired, run 'login' command again" : "invalid cookie"}`);
        account.cooldownUntil = Date.now() + 3600000;
        return null;
      }

      await this.saveSession(account, context);
      logger.info(`Suno: logged in as ${account.id} (${account.authType || "cookie"} auth)`);

      await randomDelay(1000, 2000);

      // Build the prompt
      let fullPrompt = options.prompt;
      if (options.mood) fullPrompt += `, ${options.mood}`;

      // Step 1: Navigate directly to the Create workspace
      logger.info("Suno: navigating to Create workspace...");
      await page.goto("https://suno.com/create", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(5000);

      // Wait for Song Description textarea to appear
      try {
        await page.waitForSelector("textarea", { timeout: 15000 });
      } catch {
        logger.error("Suno: Create workspace textarea not found");
        await page.screenshot({ path: path.join(SESSIONS_DIR, `suno-debug-${Date.now()}.png`) });
        return null;
      }

      // Step 2: Fill Song Description using page-level actions (avoids stale element handles)
      await page.click("textarea");
      await randomDelay(300, 600);
      await page.fill("textarea", fullPrompt);
      await randomDelay(500, 1000);
      logger.info(`Suno: filled Song Description with "${fullPrompt}"`);

      // Step 3: Enable Instrumental mode if needed
      if (options.instrumental !== false) {
        try {
          const instrumentalBtn = await page.$('button:has-text("Instrumental")');
          if (instrumentalBtn) {
            const ibox = await instrumentalBtn.boundingBox();
            if (ibox) {
              await page.mouse.click(ibox.x + ibox.width / 2, ibox.y + ibox.height / 2);
            } else {
              await instrumentalBtn.click({ force: true });
            }
            await randomDelay(300, 500);
            logger.info("Suno: instrumental mode toggled");
          }
        } catch {
          logger.warn("Suno: could not toggle instrumental mode");
        }
      }

      // Step 4: Click the Create button to start generation
      await randomDelay(500, 1000);

      // Find the Create button and click using mouse coordinates
      // (Suno has a div overlay that blocks element.click — must use page.mouse.click)
      // Try multiple selectors in order of specificity
      const createSelectors = [
        'button:has-text("Create"):not(:has-text("Advanced"))',
        'button:has(svg) :text("Create")',
        '[role="button"]:has-text("Create")',
      ];

      let submitClicked = false;

      for (const selector of createSelectors) {
        if (submitClicked) break;
        try {
          const btns = await page.$$(selector);
          for (const btn of btns) {
            const box = await btn.boundingBox();
            if (box && box.width > 30 && box.height > 20) {
              const cx = box.x + box.width / 2;
              const cy = box.y + box.height / 2;
              logger.info(`Suno: found Create button (${Math.round(box.width)}x${Math.round(box.height)} at ${Math.round(cx)},${Math.round(cy)})`);
              await page.mouse.click(cx, cy);
              submitClicked = true;
              logger.info("Suno: clicked Create button via mouse coordinates");
              break;
            }
          }
        } catch {
          continue;
        }
      }

      // Fallback: try clicking any element with exact "Create" text
      if (!submitClicked) {
        try {
          const allBtns = await page.$$('button');
          for (const btn of allBtns) {
            const text = await btn.textContent();
            if (text && text.trim() === "Create") {
              const box = await btn.boundingBox();
              if (box) {
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                submitClicked = true;
                logger.info("Suno: clicked Create button via fallback text match");
                break;
              }
            }
          }
        } catch {
          logger.warn("Suno: fallback Create button search failed");
        }
      }

      if (!submitClicked) {
        logger.error("Suno: could not find Create submit button");
        await page.screenshot({ path: path.join(SESSIONS_DIR, `suno-no-create-${Date.now()}.png`) });
        return null;
      }

      // Wait a moment for the click to register, then verify generation started
      await new Promise((r) => setTimeout(r, 3000));

      // Check if a generation POST request was made (indicates click worked)
      const postClickScreenshot = path.join(SESSIONS_DIR, `suno-post-click-${Date.now()}.png`);
      await page.screenshot({ path: postClickScreenshot }).catch(() => {});

      // Check if the page shows a generating/loading state
      const generationStarted = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        // Look for any loading indicators, progress bars, or new track cards appearing
        const loadingIndicators = document.querySelectorAll('[class*="loading"], [class*="progress"], [class*="generating"], [class*="spinner"]');
        const hasLoadingText = text.includes("generating") || text.includes("creating");
        return loadingIndicators.length > 0 || hasLoadingText;
      });

      if (generationStarted) {
        logger.info("Suno: generation started (loading indicator detected)");
      } else {
        logger.warn("Suno: no loading indicator detected after click — generation may not have started, retrying click...");
        // Try clicking the Create button again with page.click()
        try {
          await page.click('button:has-text("Create")', { timeout: 5000, force: true });
          logger.info("Suno: retried Create button click via page.click()");
        } catch {
          logger.warn("Suno: retry click failed — continuing to wait anyway");
        }
        await new Promise((r) => setTimeout(r, 2000));
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

  /** Wait for a generated track's audio URL — checks API interception, DOM audio, and track cards. */
  private async waitForTrack(page: Page, capturedUrls: string[], timeoutMs: number): Promise<string | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      // Check intercepted API responses first (most reliable)
      if (capturedUrls.length > 0) {
        return capturedUrls[capturedUrls.length - 1];
      }

      // Check for audio/video elements and CDN links in the DOM
      const mediaUrl = await page.evaluate(() => {
        // Check <audio> and <video> elements
        const mediaEls = document.querySelectorAll("audio source, audio, video source, video");
        for (const a of mediaEls) {
          const src = (a as HTMLMediaElement).src || (a as HTMLSourceElement).src;
          if (src && (src.includes("cdn1.suno.ai") || src.includes("cdn2.suno.ai")) && !src.includes("sil-100") && !src.includes("silence")) {
            return src;
          }
        }
        // Check <a> download links
        const links = document.querySelectorAll('a[href*="cdn1.suno.ai"], a[href*="cdn2.suno.ai"], a[download]');
        for (const link of links) {
          const href = (link as HTMLAnchorElement).href;
          if (href && (href.endsWith(".mp3") || href.endsWith(".wav")) && !href.includes("sil-100")) {
            return href;
          }
        }
        // Check for any element with a CDN audio URL in data attributes or style
        const allCdn = document.querySelectorAll('[src*="cdn1.suno.ai"], [src*="cdn2.suno.ai"]');
        for (const el of allCdn) {
          const src = (el as HTMLImageElement).src;
          if (src && (src.endsWith(".mp3") || src.endsWith(".wav"))) {
            return src;
          }
        }
        return null;
      });

      if (mediaUrl) {
        logger.info(`Suno: found media URL in DOM: ${mediaUrl.substring(0, 80)}...`);
        return mediaUrl;
      }

      // Check for completed track cards in chat interface
      const trackReady = await page.evaluate(() => {
        // Look for play buttons or track duration indicators that appear when generation is done
        const playBtns = document.querySelectorAll('button[aria-label*="play" i], button[aria-label*="Play" i]');
        // Look for track time displays (e.g. "0:00 / 2:30")
        const timeDisplays = Array.from(document.querySelectorAll('span, div, p')).filter(el => {
          const t = el.textContent || '';
          return /\d+:\d+\s*\/\s*\d+:\d+/.test(t) && !t.includes("credits");
        });
        return playBtns.length > 0 || timeDisplays.length > 0;
      });

      if (trackReady) {
        logger.info("Suno: track card detected in UI, polling API for audio URL...");
        // Track is visible but we haven't captured the URL yet — keep polling API interception
        // The URL should appear soon in the API responses
        await new Promise((r) => setTimeout(r, 3000));
        if (capturedUrls.length > 0) {
          return capturedUrls[capturedUrls.length - 1];
        }
        // Try extracting from page context (look for audio player state)
        const extractedUrl = await page.evaluate(() => {
          // Some SPAs store audio state in React/Next.js internals
          const audioEls = document.querySelectorAll('audio');
          for (const a of audioEls) {
            if (a.src && a.src.includes("cdn") && !a.src.includes("sil-100")) return a.src;
            // Check child sources
            for (const s of a.querySelectorAll('source')) {
              if (s.src && s.src.includes("cdn") && !s.src.includes("sil-100")) return s.src;
            }
          }
          return null;
        });
        if (extractedUrl) return extractedUrl;
      }

      // Direct API poll: fetch the user's latest clips from Suno API via page context
      // This is more reliable than passive interception since we actively request the data
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (elapsed >= 15 && elapsed % 10 === 0) {
        try {
          const apiResult = await page.evaluate(async () => {
            // Try multiple API endpoints to find completed clips
            const endpoints = [
              "https://studio-api.suno.ai/api/feed/?page=0&page_size=4",
              "https://studio-api-prod.suno.com/api/feed/?page=0&page_size=4",
              "https://suno.com/api/feed/?page=0&page_size=4",
            ];
            for (const endpoint of endpoints) {
              try {
                const res = await fetch(endpoint, { credentials: "include" });
                if (!res.ok) continue;
                const data = await res.json();
                const clips = data?.clips || data?.data || (Array.isArray(data) ? data : []);
                for (const clip of clips) {
                  if (clip?.audio_url && (clip?.status === "complete" || clip?.status === "streaming")) {
                    // Check if this clip was created recently (within last 10 minutes)
                    const createdAt = clip.created_at ? new Date(clip.created_at).getTime() : 0;
                    const now = Date.now();
                    if (now - createdAt < 600000) {
                      return { url: clip.audio_url, status: clip.status, id: clip.id, endpoint };
                    }
                  }
                }
              } catch {
                // Endpoint not available
              }
            }
            return null;
          });

          if (apiResult) {
            logger.info(`Suno: [API poll] found clip ${apiResult.id} (${apiResult.status}) via ${apiResult.endpoint}`);
            return apiResult.url;
          }
        } catch {
          // API poll failed — not critical
        }
      }

      // Check for error states
      const hasError = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes("something went wrong") || text.includes("generation failed") || text.includes("out of credits") || text.includes("insufficient credits");
      });

      if (hasError) {
        logger.warn("Suno: detected error state on page");
        await page.screenshot({ path: path.join(SESSIONS_DIR, `suno-error-state-${Date.now()}.png`) }).catch(() => {});
        return null;
      }

      if (elapsed % 30 === 0 && elapsed > 0) {
        logger.info(`Suno: waiting for generation... (${elapsed}s elapsed)`);
        await page.screenshot({ path: path.join(SESSIONS_DIR, `suno-wait-${elapsed}s.png`) }).catch(() => {});
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
