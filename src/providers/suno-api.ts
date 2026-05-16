/**
 * Suno API provider — direct HTTP API calls (faster than browser automation).
 *
 * Uses the Clerk auth + studio-api.prod.suno.com endpoint.
 * Falls back to browser automation if API calls fail.
 */

import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
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
} from "../utils/helpers";

const CLERK_BASE = "https://clerk.suno.com";
const API_BASE = "https://studio-api.prod.suno.com";
const CLERK_JS_VERSION = "4.72.1";

interface SunoSession {
  accountId: string;
  cookie: string;
  sessionId: string;
  token: string;
  tokenExpiry: number;
}

export class SunoApiProvider implements MusicProvider {
  readonly name = "suno-api";
  private accounts: ProviderAccount[] = [];
  private sessions: Map<string, SunoSession> = new Map();

  addAccount(account: ProviderAccount): void {
    account.provider = this.name;
    account.dailyLimit = account.dailyLimit || 50;
    this.accounts.push(account);
    logger.info(`SunoAPI: added account ${account.id}`);
  }

  getAccounts(): ProviderAccount[] {
    return this.accounts;
  }

  async init(): Promise<void> {
    // Authenticate all accounts
    for (const account of this.accounts) {
      try {
        await this.authenticate(account);
      } catch (e) {
        logger.error(`SunoAPI: failed to authenticate ${account.id}: ${e}`);
      }
    }
  }

  async isReady(): Promise<boolean> {
    return this.sessions.size > 0;
  }

  async getStatus(): Promise<ProviderStatus> {
    const now = Date.now();
    const ready = this.accounts.filter(
      (a) => this.sessions.has(a.id) && (!a.cooldownUntil || a.cooldownUntil < now)
    );
    const remaining = ready.reduce(
      (sum, a) => sum + (a.dailyLimit - a.dailyGenerated),
      0
    );
    return {
      name: this.name,
      available: this.sessions.size > 0,
      accountCount: this.accounts.length,
      readyAccounts: ready.length,
      dailyRemaining: remaining,
    };
  }

  private async authenticate(account: ProviderAccount): Promise<void> {
    let cookie = "";
    if (account.cookiePath && fs.existsSync(account.cookiePath)) {
      cookie = fs.readFileSync(account.cookiePath, "utf-8").trim();
    }
    if (!cookie) {
      throw new Error(`No cookie for account ${account.id}`);
    }
    if (!cookie.startsWith("__client=")) {
      cookie = `__client=${cookie}`;
    }

    // Get session ID
    const clientResp = await this.httpGet(
      `${CLERK_BASE}/v1/client?_clerk_js_version=${CLERK_JS_VERSION}`,
      { Cookie: cookie }
    );
    const clientData = JSON.parse(clientResp);
    const sessionId = clientData?.response?.last_active_session_id;
    if (!sessionId) {
      throw new Error("Failed to get session ID");
    }

    // Get token
    const tokenResp = await this.httpPost(
      `${CLERK_BASE}/v1/client/sessions/${sessionId}/tokens?_clerk_js_version=${CLERK_JS_VERSION}`,
      {},
      { Cookie: cookie }
    );
    const tokenData = JSON.parse(tokenResp);
    const token = tokenData.jwt;

    this.sessions.set(account.id, {
      accountId: account.id,
      cookie,
      sessionId,
      token,
      tokenExpiry: Date.now() + 50000, // ~50s, Clerk tokens are short-lived
    });

    logger.info(`SunoAPI: authenticated account ${account.id} (session=${sessionId.substring(0, 12)})`);
  }

  private async ensureToken(accountId: string): Promise<string> {
    const session = this.sessions.get(accountId);
    if (!session) throw new Error(`No session for ${accountId}`);

    if (Date.now() > session.tokenExpiry) {
      const tokenResp = await this.httpPost(
        `${CLERK_BASE}/v1/client/sessions/${session.sessionId}/tokens?_clerk_js_version=${CLERK_JS_VERSION}`,
        {},
        { Cookie: session.cookie }
      );
      const tokenData = JSON.parse(tokenResp);
      session.token = tokenData.jwt;
      session.tokenExpiry = Date.now() + 50000;
    }

    return session.token;
  }

  private pickAccount(): ProviderAccount | null {
    const now = Date.now();
    const available = this.accounts
      .filter(
        (a) =>
          this.sessions.has(a.id) &&
          (!a.cooldownUntil || a.cooldownUntil < now) &&
          a.dailyGenerated < a.dailyLimit
      )
      .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    return available.length > 0 ? available[0] : null;
  }

  async generate(options: GenerateOptions): Promise<TrackResult | null> {
    const account = this.pickAccount();
    if (!account) {
      logger.warn("SunoAPI: no available accounts");
      return null;
    }

    try {
      const token = await this.ensureToken(account.id);

      // Build generation payload
      const tags = options.tags || this.genreToTags(options.genre);
      const payload: Record<string, unknown> = {
        gpt_description_prompt: options.prompt,
        tags,
        title: "",
        make_instrumental: options.instrumental !== false,
        mv: "chirp-auk-turbo", // v4.5 free model
      };

      logger.info(`SunoAPI: generating "${options.prompt}" (${options.genre})`);
      const genResp = await this.httpPost(
        `${API_BASE}/api/generate/v2/`,
        payload,
        { Authorization: `Bearer ${token}` }
      );
      const genData = JSON.parse(genResp);
      const clips = genData.clips || [];

      if (clips.length === 0) {
        logger.warn("SunoAPI: no clips returned");
        return null;
      }

      // Wait for completion
      const clipId = clips[0].id;
      const completedClip = await this.waitForClip(account.id, clipId, 300000);
      if (!completedClip || !completedClip.audio_url) {
        logger.error("SunoAPI: clip generation timed out or failed");
        return null;
      }

      // Download
      const genreFolder = ensureGenreFolder(options.genre);
      const filename = generateTrackFilename(options.genre);
      const filePath = path.join(genreFolder, filename);
      await this.downloadFile(completedClip.audio_url, filePath);

      // Update stats
      account.lastUsed = Date.now();
      account.totalGenerated++;
      account.dailyGenerated++;

      const result: TrackResult = {
        id: nanoid(),
        title: completedClip.title || options.prompt.substring(0, 50),
        prompt: options.prompt,
        provider: this.name,
        filePath,
        duration: completedClip.metadata?.duration || options.duration || 120,
        genre: options.genre,
        createdAt: new Date().toISOString(),
      };

      saveMetadata(filePath, {
        prompt: options.prompt,
        provider: this.name,
        createdAt: result.createdAt,
        duration: result.duration,
        genre: options.genre,
      });

      const sizeMb = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(2);
      logger.info(`SunoAPI: generated ${filename} (${sizeMb} MB) for ${options.genre}`);
      return result;
    } catch (e) {
      logger.error(`SunoAPI: generation failed — ${e}`);
      account.cooldownUntil = Date.now() + 60000; // 1 min cooldown on error
      return null;
    }
  }

  private async waitForClip(
    accountId: string,
    clipId: string,
    timeoutMs: number
  ): Promise<Record<string, any> | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 10000));
      try {
        const token = await this.ensureToken(accountId);
        const resp = await this.httpGet(`${API_BASE}/api/feed/?ids=${clipId}`, {
          Authorization: `Bearer ${token}`,
        });
        const data = JSON.parse(resp);
        const clip = Array.isArray(data) ? data[0] : data;

        if (clip?.status === "complete" && clip?.audio_url) {
          return clip;
        }
        if (clip?.status === "error" || clip?.status === "failed") {
          logger.error(`SunoAPI: clip ${clipId} failed`);
          return null;
        }
        logger.info(`SunoAPI: clip ${clipId} status=${clip?.status || "unknown"}, waiting...`);
      } catch (e) {
        logger.warn(`SunoAPI: poll error — ${e}`);
      }
    }
    return null;
  }

  private genreToTags(genre: string): string {
    const tagMap: Record<string, string> = {
      "lofi": "lo-fi, hip hop, chill, relaxing, instrumental",
      "lofi-hiphop": "lo-fi, hip hop, chill, relaxing, instrumental, beats",
      "jazz": "jazz, smooth, instrumental, relaxing, sophisticated",
      "ambient": "ambient, atmospheric, instrumental, meditative, calm",
      "blues": "blues, slow, guitar, soulful, instrumental",
      "lullaby": "lullaby, gentle, soft, baby, peaceful, instrumental",
      "synthwave": "synthwave, retro, electronic, 80s, cyberpunk, instrumental",
      "piano": "piano, classical, relaxing, soft, instrumental",
      "classical": "classical, orchestral, elegant, instrumental",
    };
    const lower = genre.toLowerCase().replace(/\s+/g, "-");
    return tagMap[lower] || `${genre}, instrumental, relaxing`;
  }

  private httpGet(url: string, headers: Record<string, string> = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const client = parsed.protocol === "https:" ? https : http;
      const req = client.get(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            ...headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        }
      );
      req.on("error", reject);
    });
  }

  private httpPost(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const client = parsed.protocol === "https:" ? https : http;
      const bodyStr = JSON.stringify(body);
      const req = client.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyStr),
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            ...headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        }
      );
      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    });
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;
      const file = fs.createWriteStream(destPath);

      const doGet = (downloadUrl: string) => {
        const c = downloadUrl.startsWith("https") ? https : http;
        c.get(downloadUrl, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            if (res.headers.location) {
              doGet(res.headers.location);
            } else {
              reject(new Error("Redirect without location"));
            }
            return;
          }
          res.pipe(file);
          file.on("finish", () => { file.close(); resolve(); });
        }).on("error", reject);
      };

      doGet(url);
    });
  }

  async destroy(): Promise<void> {
    this.sessions.clear();
    logger.info("SunoAPI: cleaned up");
  }
}
