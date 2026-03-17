#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Helpers ---

function timestamp() {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).replace(",", "");
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

function loadEnv() {
  const envPath = resolve(__dirname, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// --- RPC ---

async function getEpochInfo(rpcUrl) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getEpochInfo",
  });
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${res.statusText}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

// --- State ---

const STATE_PATH = resolve(__dirname, "epoch-state.json");

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveState(epoch) {
  writeFileSync(STATE_PATH, JSON.stringify({ epoch, updatedAt: new Date().toISOString() }, null, 2) + "\n");
}

// --- Config ---

function loadConfig() {
  const configPath = resolve(__dirname, "epoch-watcher.config.json");
  if (!existsSync(configPath)) {
    log("Warning: epoch-watcher.config.json not found. No tasks will run.");
    return { tasks: [] };
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

// --- Task Runner ---

function parseRun(run) {
  const args = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (const ch of run) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; } else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) { args.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return { command: args[0], args: args.slice(1) };
}

function resolveTask(task) {
  if (task.run) {
    const parsed = parseRun(task.run);
    return { ...task, command: parsed.command, args: parsed.args };
  }
  return task;
}

function runTask(task) {
  return new Promise((resolve) => {
    const resolved = resolveTask(task);
    const start = Date.now();
    log(`Running: ${resolved.name} ...`);

    const opts = {};
    if (resolved.cwd) opts.cwd = resolved.cwd;

    let proc;
    try {
      proc = spawn(resolved.command, resolved.args || [], opts);
    } catch (err) {
      log(`\u2717 ${resolved.name} failed to spawn: ${err.message}`);
      resolve(false);
      return;
    }

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("error", (err) => {
      log(`\u2717 ${resolved.name} error: ${err.message}`);
      resolve(false);
    });

    proc.on("close", (code) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      if (code === 0) {
        log(`\u2713 ${resolved.name} completed (${elapsed}s)`);
      } else {
        log(`\u2717 ${resolved.name} exited with code ${code} (${elapsed}s)`);
        if (stderr) log(`  stderr: ${stderr.trim()}`);
      }
      resolve(code === 0);
    });
  });
}

async function runAllTasks(tasks) {
  for (const task of tasks) {
    await runTask(task);
  }
}

// --- Main Loop ---

async function poll(rpcUrl, config) {
  let epochInfo;
  try {
    epochInfo = await getEpochInfo(rpcUrl);
  } catch (err) {
    log(`RPC error: ${err.message}. Will retry next poll.`);
    return;
  }

  const currentEpoch = epochInfo.epoch;
  const state = loadState();

  if (!state) {
    log(`Initial state recorded. Current epoch: ${currentEpoch}`);
    saveState(currentEpoch);
    return;
  }

  if (currentEpoch === state.epoch) {
    log(`Epoch ${currentEpoch} (no change)`);
    return;
  }

  log(`*** Epoch changed: ${state.epoch} \u2192 ${currentEpoch} ***`);
  await runAllTasks(config.tasks);
  saveState(currentEpoch);

  const interval = parseInt(process.env.EPOCH_POLL_INTERVAL || "300", 10);
  log(`All tasks completed. Next poll in ${interval}s.`);
}

async function main() {
  loadEnv();

  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error("Error: SOLANA_RPC_URL is not set. Create a .env file or set the environment variable.");
    process.exit(1);
  }

  const interval = parseInt(process.env.EPOCH_POLL_INTERVAL || "300", 10);
  const config = loadConfig();

  // Initial poll to show current epoch
  let epochInfo;
  try {
    epochInfo = await getEpochInfo(rpcUrl);
  } catch (err) {
    console.error(`Failed to connect to RPC: ${err.message}`);
    process.exit(1);
  }

  log(`Started. Polling every ${interval}s. Current epoch: ${epochInfo.epoch}`);
  log(`Configured tasks: ${config.tasks.length}`);

  // First poll (handles initial state creation or epoch change)
  await poll(rpcUrl, config);

  // Subsequent polls
  setInterval(() => poll(rpcUrl, config), interval * 1000);
}

main();
