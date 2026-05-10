/**
 * Orchestrator — ties providers, queue, and config together.
 *
 * Handles:
 *  - Initializing providers from config
 *  - Running generation batches
 *  - Continuous mode (generate forever for a genre)
 */

import { MusicProvider, ProviderAccount } from "../providers/provider-interface";
import { SunoProvider } from "../providers/suno";
import { SunoApiProvider } from "../providers/suno-api";
import { UdioProvider } from "../providers/udio";
import { GenerationQueue, QueueStats, QueueJob } from "../queue/queue";
import { loadConfig, AppConfig } from "../storage/config";
import { logger } from "../utils/logger";
import { countTracks, listGenres } from "../utils/helpers";

export interface GenerationRequest {
  genre: string;
  count: number;
  duration?: number;
  mood?: string;
  prompt?: string;
}

export class Orchestrator {
  private providers: MusicProvider[] = [];
  private queue: GenerationQueue | null = null;
  private config: AppConfig;
  private initialized = false;

  constructor() {
    this.config = loadConfig();
  }

  /** Initialize all enabled providers. */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Initialize Suno
    if (this.config.providers.suno.enabled) {
      const sunoAccounts = this.config.providers.suno.accounts;
      if (sunoAccounts.length > 0) {
        if (this.config.providers.suno.useApi) {
          const sunoApi = new SunoApiProvider();
          for (const acc of sunoAccounts) {
            sunoApi.addAccount(this.resetDailyStats(acc));
          }
          await sunoApi.init();
          if (await sunoApi.isReady()) {
            this.providers.push(sunoApi);
            logger.info("Orchestrator: Suno API provider ready");
          } else {
            logger.warn("Orchestrator: Suno API failed, trying browser mode");
            const sunoBrowser = new SunoProvider();
            for (const acc of sunoAccounts) {
              sunoBrowser.addAccount(this.resetDailyStats(acc));
            }
            await sunoBrowser.init();
            this.providers.push(sunoBrowser);
          }
        } else {
          const suno = new SunoProvider();
          for (const acc of sunoAccounts) {
            suno.addAccount(this.resetDailyStats(acc));
          }
          await suno.init();
          this.providers.push(suno);
        }
      }
    }

    // Initialize Udio
    if (this.config.providers.udio.enabled) {
      const udioAccounts = this.config.providers.udio.accounts;
      if (udioAccounts.length > 0) {
        const udio = new UdioProvider();
        for (const acc of udioAccounts) {
          udio.addAccount(this.resetDailyStats(acc));
        }
        await udio.init();
        this.providers.push(udio);
      }
    }

    if (this.providers.length === 0) {
      logger.warn("Orchestrator: no providers initialized — add accounts first");
    }

    this.initialized = true;
  }

  private resetDailyStats(account: ProviderAccount): ProviderAccount {
    return {
      ...account,
      dailyGenerated: 0,
      cooldownUntil: undefined,
    };
  }

  /** Generate a batch of tracks for a genre. */
  async generate(request: GenerationRequest): Promise<QueueStats> {
    await this.init();

    if (this.providers.length === 0) {
      throw new Error("No providers available. Add at least one account first.");
    }

    this.queue = new GenerationQueue(this.providers, {
      maxRetries: this.config.generation.maxRetries,
      onJobComplete: (job) => {
        const stats = this.queue!.getStats();
        const percent = Math.round(((stats.done + stats.failed) / stats.total) * 100);
        logger.info(
          `Progress: ${percent}% (${stats.done} done, ${stats.failed} failed, ${stats.pending} pending)`
        );
      },
    });

    this.queue.addBatch(
      request.genre,
      request.count,
      request.prompt,
      request.mood
    );

    await this.queue.start();
    return this.queue.getStats();
  }

  /** Continuous mode — keep generating for a genre until stopped. */
  async generateContinuous(
    genre: string,
    mood?: string,
    targetCount?: number
  ): Promise<void> {
    await this.init();

    if (this.providers.length === 0) {
      throw new Error("No providers available.");
    }

    let generated = 0;
    const batchSize = 5;

    logger.info(
      `Continuous mode: generating "${genre}" ${targetCount ? `(target: ${targetCount})` : "indefinitely"}`
    );

    while (!targetCount || generated < targetCount) {
      const remaining = targetCount ? targetCount - generated : batchSize;
      const batch = Math.min(remaining, batchSize);

      const stats = await this.generate({
        genre,
        count: batch,
        mood,
      });

      generated += stats.done;

      if (stats.failed === batch) {
        logger.warn("Continuous: full batch failed, waiting 5 minutes");
        await new Promise((r) => setTimeout(r, 300000));
      } else {
        await new Promise((r) =>
          setTimeout(r, this.config.generation.delayBetweenJobs)
        );
      }
    }

    logger.info(`Continuous mode: completed — ${generated} tracks generated for "${genre}"`);
  }

  /** Get library summary. */
  getLibrarySummary(): { genre: string; trackCount: number }[] {
    return listGenres().map((g) => ({
      genre: g,
      trackCount: countTracks(g),
    }));
  }

  /** Get current queue stats. */
  getQueueStats(): QueueStats | null {
    return this.queue?.getStats() || null;
  }

  /** Get all queue jobs. */
  getJobs(): QueueJob[] {
    return this.queue?.getJobs() || [];
  }

  /** Stop current generation. */
  stop(): void {
    if (this.queue) {
      this.queue.stop();
    }
  }

  /** Cleanup all providers. */
  async destroy(): Promise<void> {
    for (const p of this.providers) {
      await p.destroy();
    }
    this.providers = [];
    this.initialized = false;
  }
}
