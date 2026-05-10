/**
 * Simple job queue with retry support, provider rotation, and cooldown awareness.
 */

import { nanoid } from "nanoid";
import { MusicProvider, GenerateOptions, TrackResult } from "../providers/provider-interface";
import { logger } from "../utils/logger";
import { randomDelay } from "../utils/helpers";

export type JobStatus = "pending" | "running" | "done" | "failed" | "retrying";

export interface QueueJob {
  id: string;
  options: GenerateOptions;
  status: JobStatus;
  result: TrackResult | null;
  attempts: number;
  maxRetries: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  provider?: string;
}

export interface QueueStats {
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
}

export class GenerationQueue {
  private jobs: QueueJob[] = [];
  private providers: MusicProvider[] = [];
  private running = false;
  private concurrency = 1; // Sequential by default — providers usually don't support parallel
  private activeJobs = 0;
  private maxRetries = 3;
  private onJobComplete?: (job: QueueJob) => void;

  constructor(
    providers: MusicProvider[],
    options?: {
      concurrency?: number;
      maxRetries?: number;
      onJobComplete?: (job: QueueJob) => void;
    }
  ) {
    this.providers = providers;
    if (options?.concurrency) this.concurrency = options.concurrency;
    if (options?.maxRetries) this.maxRetries = options.maxRetries;
    if (options?.onJobComplete) this.onJobComplete = options.onJobComplete;
  }

  /** Add a generation job to the queue. */
  addJob(options: GenerateOptions, retries?: number): string {
    const job: QueueJob = {
      id: nanoid(),
      options,
      status: "pending",
      result: null,
      attempts: 0,
      maxRetries: retries ?? this.maxRetries,
      createdAt: Date.now(),
    };
    this.jobs.push(job);
    logger.info(
      `Queue: added job ${job.id} — "${options.prompt}" (${options.genre})`
    );
    return job.id;
  }

  /** Add multiple jobs for a genre batch. */
  addBatch(genre: string, count: number, prompt?: string, mood?: string): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const genPrompt = prompt || this.buildDefaultPrompt(genre, i);
      ids.push(
        this.addJob({
          prompt: genPrompt,
          genre,
          mood,
          instrumental: true,
        })
      );
    }
    logger.info(`Queue: added batch of ${count} jobs for "${genre}"`);
    return ids;
  }

  private buildDefaultPrompt(genre: string, variation: number): string {
    const variations = [
      `${genre}, smooth and relaxing`,
      `${genre}, mellow with gentle rhythm`,
      `${genre}, chill vibes background music`,
      `${genre}, soft and atmospheric`,
      `${genre}, laid-back and easy listening`,
      `${genre}, calm and peaceful`,
      `${genre}, dreamy and flowing`,
      `${genre}, warm and soothing`,
      `${genre}, gentle and serene`,
      `${genre}, muted tones and soft beats`,
    ];
    return variations[variation % variations.length];
  }

  /** Start processing the queue. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info("Queue: started processing");

    while (this.running) {
      const pending = this.jobs.find(
        (j) => j.status === "pending" || j.status === "retrying"
      );
      if (!pending) {
        if (this.activeJobs === 0) {
          logger.info("Queue: all jobs completed");
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      if (this.activeJobs >= this.concurrency) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      // Pick a provider with available capacity
      const provider = await this.pickProvider();
      if (!provider) {
        logger.warn("Queue: no providers available, waiting...");
        await new Promise((r) => setTimeout(r, 30000));
        continue;
      }

      // Process job
      this.processJob(pending, provider);
    }

    this.running = false;
  }

  /** Process a single job. */
  private async processJob(
    job: QueueJob,
    provider: MusicProvider
  ): Promise<void> {
    this.activeJobs++;
    job.status = "running";
    job.startedAt = Date.now();
    job.attempts++;
    job.provider = provider.name;

    logger.info(
      `Queue: processing ${job.id} with ${provider.name} (attempt ${job.attempts})`
    );

    try {
      const result = await provider.generate(job.options);

      if (result) {
        job.status = "done";
        job.result = result;
        job.completedAt = Date.now();
        logger.info(
          `Queue: job ${job.id} completed — ${result.filePath}`
        );
      } else if (job.attempts < job.maxRetries) {
        job.status = "retrying";
        logger.warn(
          `Queue: job ${job.id} failed, retrying (${job.attempts}/${job.maxRetries})`
        );
        await randomDelay(5000, 15000); // Back off before retry
      } else {
        job.status = "failed";
        job.error = "Max retries exceeded";
        job.completedAt = Date.now();
        logger.error(`Queue: job ${job.id} failed permanently`);
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      if (job.attempts < job.maxRetries) {
        job.status = "retrying";
        job.error = err;
        logger.warn(`Queue: job ${job.id} error: ${err}, retrying`);
      } else {
        job.status = "failed";
        job.error = err;
        job.completedAt = Date.now();
        logger.error(`Queue: job ${job.id} failed: ${err}`);
      }
    } finally {
      this.activeJobs--;
      if (this.onJobComplete) this.onJobComplete(job);
    }
  }

  /** Pick the best available provider (round-robin by remaining capacity). */
  private async pickProvider(): Promise<MusicProvider | null> {
    const statuses = await Promise.all(
      this.providers.map(async (p) => ({
        provider: p,
        status: await p.getStatus(),
      }))
    );

    const available = statuses
      .filter((s) => s.status.available && s.status.readyAccounts > 0 && s.status.dailyRemaining > 0)
      .sort((a, b) => b.status.dailyRemaining - a.status.dailyRemaining);

    return available.length > 0 ? available[0].provider : null;
  }

  /** Stop processing. */
  stop(): void {
    this.running = false;
    logger.info("Queue: stopped");
  }

  /** Get queue statistics. */
  getStats(): QueueStats {
    return {
      total: this.jobs.length,
      pending: this.jobs.filter((j) => j.status === "pending" || j.status === "retrying").length,
      running: this.jobs.filter((j) => j.status === "running").length,
      done: this.jobs.filter((j) => j.status === "done").length,
      failed: this.jobs.filter((j) => j.status === "failed").length,
    };
  }

  /** Get all jobs. */
  getJobs(): QueueJob[] {
    return this.jobs;
  }

  /** Get a specific job. */
  getJob(id: string): QueueJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  /** Check if queue is actively running. */
  isRunning(): boolean {
    return this.running;
  }

  /** Clear completed/failed jobs from the queue. */
  clearCompleted(): void {
    this.jobs = this.jobs.filter(
      (j) => j.status === "pending" || j.status === "running" || j.status === "retrying"
    );
  }
}
