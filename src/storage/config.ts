/**
 * Configuration & account storage — JSON-based for simplicity.
 */

import fs from "fs";
import path from "path";
import { ProviderAccount } from "../providers/provider-interface";

const CONFIG_PATH = path.resolve(process.cwd(), "config.json");

export interface AppConfig {
  providers: {
    suno: { enabled: boolean; useApi: boolean; accounts: ProviderAccount[] };
    udio: { enabled: boolean; accounts: ProviderAccount[] };
  };
  generation: {
    maxRetries: number;
    delayBetweenJobs: number;
    defaultDuration: number;
    instrumental: boolean;
  };
  storage: {
    libraryPath: string;
    logsPath: string;
    sessionsPath: string;
  };
}

const DEFAULT_CONFIG: AppConfig = {
  providers: {
    suno: { enabled: true, useApi: true, accounts: [] },
    udio: { enabled: false, accounts: [] },
  },
  generation: {
    maxRetries: 3,
    delayBetweenJobs: 5000,
    defaultDuration: 120,
    instrumental: true,
  },
  storage: {
    libraryPath: "./music-library",
    logsPath: "./logs",
    sessionsPath: "./sessions",
  },
};

export function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: AppConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function addSunoAccount(
  cookieOrPath: string,
  accountId?: string
): ProviderAccount {
  const config = loadConfig();
  const id = accountId || `suno-${Date.now()}`;

  // If it's a raw cookie value, save it to a file
  let cookiePath: string;
  if (cookieOrPath.includes("/") || cookieOrPath.includes("\\")) {
    cookiePath = cookieOrPath; // It's a file path
  } else {
    const sessionsDir = path.resolve(process.cwd(), "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    cookiePath = path.join(sessionsDir, `${id}-cookie.txt`);
    fs.writeFileSync(cookiePath, cookieOrPath);
  }

  const account: ProviderAccount = {
    id,
    provider: "suno",
    cookiePath,
    totalGenerated: 0,
    dailyGenerated: 0,
    dailyLimit: 50,
  };

  config.providers.suno.accounts.push(account);
  saveConfig(config);
  return account;
}

export function addSunoSessionAccount(
  accountId?: string,
  email?: string
): ProviderAccount {
  const config = loadConfig();
  const id = accountId || `suno-${Date.now()}`;
  const sessionsDir = path.resolve(process.cwd(), "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionPath = path.join(sessionsDir, `${id}-state.json`);

  const account: ProviderAccount = {
    id,
    provider: "suno",
    email,
    authType: "session",
    sessionPath,
    totalGenerated: 0,
    dailyGenerated: 0,
    dailyLimit: 50,
  };

  config.providers.suno.accounts.push(account);
  saveConfig(config);
  return account;
}

export function addUdioAccount(
  cookieOrPath: string,
  accountId?: string
): ProviderAccount {
  const config = loadConfig();
  const id = accountId || `udio-${Date.now()}`;

  let cookiePath: string;
  if (cookieOrPath.includes("/") || cookieOrPath.includes("\\")) {
    cookiePath = cookieOrPath;
  } else {
    const sessionsDir = path.resolve(process.cwd(), "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    cookiePath = path.join(sessionsDir, `${id}-cookie.txt`);
    fs.writeFileSync(cookiePath, cookieOrPath);
  }

  const account: ProviderAccount = {
    id,
    provider: "udio",
    cookiePath,
    totalGenerated: 0,
    dailyGenerated: 0,
    dailyLimit: 10,
  };

  config.providers.udio.accounts.push(account);
  saveConfig(config);
  return account;
}
