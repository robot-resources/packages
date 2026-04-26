import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.robot-resources');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export function getConfigPath() {
  return CONFIG_FILE;
}

export function getConfigDir() {
  return CONFIG_DIR;
}

export function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeConfig(data) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const existing = readConfig();
  const merged = { ...existing, ...data };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  return merged;
}

export function readProviderKeys() {
  const config = readConfig();
  return config.provider_keys || {};
}

export function writeProviderKeys(keys) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const existing = readConfig();
  const existingProviderKeys = existing.provider_keys || {};
  const merged = {
    ...existing,
    provider_keys: { ...existingProviderKeys, ...keys },
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  return merged;
}

export function clearConfig() {
  try {
    writeFileSync(CONFIG_FILE, '{}\n', { mode: 0o600 });
  } catch {
    // config file doesn't exist, that's fine
  }
}
