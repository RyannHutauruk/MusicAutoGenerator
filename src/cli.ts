#!/usr/bin/env node
/**
 * CLI interface for Music Generator.
 *
 * Usage:
 *   npx ts-node src/cli.ts generate --genre "lofi hip hop" --count 5
 *   npx ts-node src/cli.ts add-account --provider suno --cookie "..."
 *   npx ts-node src/cli.ts status
 *   npx ts-node src/cli.ts interactive
 */

import { Command } from "commander";
import inquirer from "inquirer";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { Orchestrator } from "./automation/orchestrator";
import { addSunoAccount, addUdioAccount, loadConfig } from "./storage/config";
import { listGenres, countTracks } from "./utils/helpers";
import { logger } from "./utils/logger";

const program = new Command();

program
  .name("music-gen")
  .description("AI Music Generation Automation Tool")
  .version("1.0.0");

// --- Interactive mode ---
program
  .command("interactive")
  .alias("i")
  .description("Interactive prompt mode")
  .action(async () => {
    console.log(chalk.cyan.bold("\n🎵 Music Generator — Interactive Mode\n"));

    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "genre",
        message: "Enter genre/topic:",
        validate: (v: string) => v.trim().length > 0 || "Genre is required",
      },
      {
        type: "number",
        name: "count",
        message: "Number of songs:",
        default: 5,
        validate: (v: number) => v > 0 || "Must be at least 1",
      },
      {
        type: "list",
        name: "duration",
        message: "Duration preference:",
        choices: [
          { name: "Short (~1 min)", value: 60 },
          { name: "Medium (~2 min)", value: 120 },
          { name: "Long (~3 min)", value: 180 },
        ],
        default: 120,
      },
      {
        type: "input",
        name: "mood",
        message: "Optional mood (press enter to skip):",
      },
    ]);

    console.log(
      chalk.yellow(
        `\nGenerating ${answers.count} "${answers.genre}" tracks...`
      )
    );

    const orchestrator = new Orchestrator();
    try {
      const stats = await orchestrator.generate({
        genre: answers.genre,
        count: answers.count,
        duration: answers.duration,
        mood: answers.mood || undefined,
      });

      console.log(chalk.green(`\nDone!`));
      console.log(`  Completed: ${stats.done}`);
      console.log(`  Failed: ${stats.failed}`);
      console.log(
        `  Output: music-library/${answers.genre
          .toLowerCase()
          .replace(/\s+/g, "-")}/`
      );
    } catch (e) {
      console.error(chalk.red(`Error: ${e}`));
    } finally {
      await orchestrator.destroy();
    }
  });

// --- Generate command ---
program
  .command("generate")
  .alias("gen")
  .description("Generate music tracks")
  .requiredOption("-g, --genre <genre>", "Genre/topic (e.g. 'lofi hip hop')")
  .requiredOption("-n, --count <count>", "Number of songs", parseInt)
  .option("-d, --duration <seconds>", "Duration in seconds", parseInt)
  .option("-m, --mood <mood>", "Optional mood descriptor")
  .option("-p, --prompt <prompt>", "Custom prompt (overrides genre-based prompt)")
  .option("--continuous", "Run in continuous mode (keep generating)")
  .action(async (opts) => {
    console.log(
      chalk.cyan(
        `Generating ${opts.continuous ? "continuous" : opts.count} "${opts.genre}" tracks...`
      )
    );

    const orchestrator = new Orchestrator();
    try {
      if (opts.continuous) {
        await orchestrator.generateContinuous(
          opts.genre,
          opts.mood,
          opts.count
        );
      } else {
        const stats = await orchestrator.generate({
          genre: opts.genre,
          count: opts.count,
          duration: opts.duration,
          mood: opts.mood,
          prompt: opts.prompt,
        });
        console.log(chalk.green(`Done! ${stats.done} tracks, ${stats.failed} failed`));
      }
    } catch (e) {
      console.error(chalk.red(`Error: ${e}`));
    } finally {
      await orchestrator.destroy();
    }
  });

// --- Add account ---
program
  .command("add-account")
  .description("Add a provider account")
  .requiredOption("--provider <provider>", "Provider name (suno or udio)")
  .option("--cookie <cookie>", "Session cookie value")
  .option("--cookie-file <path>", "Path to cookie file")
  .option("--id <id>", "Account ID")
  .action(async (opts) => {
    let cookie = opts.cookie;
    if (opts.cookieFile) {
      cookie = fs.readFileSync(opts.cookieFile, "utf-8").trim();
    }

    if (!cookie) {
      const answer = await inquirer.prompt([
        {
          type: "password",
          name: "cookie",
          message: `Enter ${opts.provider} session cookie:`,
          mask: "*",
        },
      ]);
      cookie = answer.cookie;
    }

    if (opts.provider === "suno") {
      const account = addSunoAccount(cookie, opts.id);
      console.log(chalk.green(`Added Suno account: ${account.id}`));
    } else if (opts.provider === "udio") {
      const account = addUdioAccount(cookie, opts.id);
      console.log(chalk.green(`Added Udio account: ${account.id}`));
    } else {
      console.error(chalk.red(`Unknown provider: ${opts.provider}`));
    }
  });

// --- Status ---
program
  .command("status")
  .description("Show library status and account info")
  .action(() => {
    const config = loadConfig();
    console.log(chalk.cyan.bold("\n📊 Music Generator Status\n"));

    // Providers
    console.log(chalk.yellow("Providers:"));
    console.log(
      `  Suno: ${config.providers.suno.enabled ? chalk.green("enabled") : chalk.gray("disabled")} (${config.providers.suno.accounts.length} accounts, API mode: ${config.providers.suno.useApi ? "yes" : "no"})`
    );
    console.log(
      `  Udio: ${config.providers.udio.enabled ? chalk.green("enabled") : chalk.gray("disabled")} (${config.providers.udio.accounts.length} accounts)`
    );

    // Library
    console.log(chalk.yellow("\nMusic Library:"));
    const genres = listGenres();
    if (genres.length === 0) {
      console.log("  (empty)");
    } else {
      let total = 0;
      for (const g of genres) {
        const count = countTracks(g);
        total += count;
        console.log(`  ${g}: ${count} tracks`);
      }
      console.log(`  Total: ${total} tracks`);
    }

    console.log();
  });

// --- Library ---
program
  .command("library")
  .description("List all tracks in the library")
  .option("-g, --genre <genre>", "Filter by genre")
  .action((opts) => {
    const libraryPath = path.resolve(process.cwd(), "music-library");
    if (!fs.existsSync(libraryPath)) {
      console.log(chalk.yellow("Library is empty"));
      return;
    }

    const genres = opts.genre
      ? [opts.genre.toLowerCase().replace(/\s+/g, "-")]
      : fs
          .readdirSync(libraryPath, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);

    for (const genre of genres) {
      const genrePath = path.join(libraryPath, genre);
      if (!fs.existsSync(genrePath)) continue;

      const tracks = fs.readdirSync(genrePath).filter((f) => f.endsWith(".mp3"));
      console.log(chalk.cyan(`\n${genre}/ (${tracks.length} tracks)`));
      for (const t of tracks) {
        const size = (
          fs.statSync(path.join(genrePath, t)).size /
          (1024 * 1024)
        ).toFixed(2);
        console.log(`  ${t} (${size} MB)`);
      }
    }
    console.log();
  });

program.parse();
