#!/usr/bin/env bun
/**
 * Figma Community Stats Tracker
 * Usage:
 *   ft --list                   List files
 *   ft --add <URL>              Add file
 *   ft --remove                 Remove file
 *   ft --run                    Run collection
 *   ft --schedule               List schedule
 *   ft --schedule add HH:MM     Add schedule
 *   ft --schedule remove        Remove schedule
 *   ft --webhook                List webhooks
 *   ft --webhook add <URL>      Add webhook
 *   ft --webhook remove         Remove webhook
 */

import { $ } from "bun";
import { parseArgs } from "util";
import { homedir } from "os";
import { join, dirname } from "path";

// ============ 配置 ============
const FIGMATRACK_DIR = join(homedir(), ".figmatrack");
const DATA_FILE = join(FIGMATRACK_DIR, "data.json");
const CONFIG_FILE = join(FIGMATRACK_DIR, "config.json");
const LOG_FILE = join(FIGMATRACK_DIR, "auto-triggered-tracker.log");
const PLIST_PATH = join(homedir(), "Library/LaunchAgents/com.tracker.figma.plist");

interface Config {
  webhook_urls?: string[];
  webhook_url?: string; // deprecated, for backwards compatibility
}

async function loadConfig(): Promise<Config> {
  const file = Bun.file(CONFIG_FILE);
  if (await file.exists()) {
    const config = await file.json();
    // Migrate old single webhook_url to webhook_urls array
    if (config.webhook_url && !config.webhook_urls) {
      config.webhook_urls = [config.webhook_url];
      delete config.webhook_url;
      await Bun.write(CONFIG_FILE, JSON.stringify(config, null, 2));
    }
    return config;
  }
  return {};
}

async function saveConfig(config: Config): Promise<void> {
  await Bun.write(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function getWebhookUrls(): Promise<string[]> {
  const config = await loadConfig();
  return config.webhook_urls || [];
}

// Ensure config directory exists
import { mkdirSync, existsSync } from "fs";
if (!existsSync(FIGMATRACK_DIR)) {
  mkdirSync(FIGMATRACK_DIR, { recursive: true });
}

// ============ 类型定义 ============
interface Record {
  date: string;
  user_count: number;
  like_count: number;
}

interface FileInfo {
  name: string;
  records: Record[];
}

interface Data {
  [fileId: string]: FileInfo;
}

interface Stats {
  name: string;
  user_count: number;
  like_count: number;
}

interface Diff {
  date: string;
  user_count: number;
  like_count: number;
  diff_user: number | null;
  diff_like: number | null;
  compare_date: string | null;
}

// ============ 核心函数 ============

function extractFileId(url: string): string {
  const match = url.match(/community\/file\/(\d+)/);
  if (!match) {
    throw new Error(`Not a valid figma link: ${url}`);
  }
  return match[1];
}

async function fetchStats(fileId: string): Promise<Stats> {
  const api = `https://www.figma.com/api/resources/hub_files/${fileId}?include_full_category=true`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.figma.com/",
    "Origin": "https://www.figma.com"
  };

  const resp = await fetch(api, { headers });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }
  const json = await resp.json();
  const res = json.meta.resource;

  return {
    name: res.name,
    user_count: res.user_count,
    like_count: res.like_count
  };
}

async function loadData(): Promise<Data> {
  const file = Bun.file(DATA_FILE);
  if (await file.exists()) {
    return await file.json();
  }
  return {};
}

async function saveData(data: Data): Promise<void> {
  await Bun.write(DATA_FILE, JSON.stringify(data, null, 2));
}

function getToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${y}/${m}/${d} ${h}:${min}:${s}`;
}

function calcDiff(records: Record[], todayStats: Stats): Diff {
  const today = getToday();
  const result: Diff = {
    date: today,
    user_count: todayStats.user_count,
    like_count: todayStats.like_count,
    diff_user: null,
    diff_like: null,
    compare_date: null
  };

  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.date !== today) {
      result.diff_user = todayStats.user_count - r.user_count;
      result.diff_like = todayStats.like_count - r.like_count;
      result.compare_date = r.date;
      break;
    }
  }

  return result;
}

async function sendWebhook(payload: object): Promise<void> {
  const webhookUrls = await getWebhookUrls();
  if (webhookUrls.length === 0) return;

  const results = await Promise.allSettled(
    webhookUrls.map(url =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
    )
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.log(`Webhook failed [${webhookUrls[index]}]: ${result.reason}`);
    }
  });
}

function buildMessage(name: string, diff: Diff): string {
  const lines: string[] = [name];
  lines.push(`Users: ${diff.user_count}  Likes: ${diff.like_count}`);

  if (diff.compare_date) {
    const u = diff.diff_user! >= 0 ? `+${diff.diff_user}` : `${diff.diff_user}`;
    const l = diff.diff_like! >= 0 ? `+${diff.diff_like}` : `${diff.diff_like}`;
    lines.push(`vs ${diff.compare_date}: Users ${u}, Likes ${l}`);
  } else {
    lines.push("First record");
  }

  return lines.join("\n");
}

// ============ 命令 ============

async function cmdAdd(url: string): Promise<void> {
  const fileId = extractFileId(url);
  const stats = await fetchStats(fileId);
  const data = await loadData();

  if (fileId in data) {
    console.log(`Already Exists: ${fileId}`);
    return;
  }

  // Check if already tracking more than 5 files
  const currentCount = Object.keys(data).length;
  if (currentCount >= 5) {
    console.log(`\x1b[31mAlready tracking ${currentCount} files. More files may cause Figma request failures.\x1b[0m`);
    const answer = await promptUser("Continue? (y/N): ");
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log("Canceled.");
      return;
    }
  }

  data[fileId] = { name: stats.name, records: [] };
  await saveData(data);
  console.log(`Added: ${stats.name}`);
}

async function cmdRemove(fileId?: string): Promise<void> {
  const data = await loadData();
  const entries = Object.entries(data);

  if (entries.length === 0) {
    console.log("No files to remove");
    return;
  }

  // If fileId provided, remove directly
  if (fileId) {
    if (fileId in data) {
      const name = data[fileId].name;
      delete data[fileId];
      await saveData(data);
      console.log(`Removed: ${name}`);
    } else {
      console.log(`Not found: ${fileId}`);
    }
    return;
  }

  // Interactive selection
  console.log("Current files:");
  entries.forEach(([fid, info], i) => {
    console.log(`  ${i + 1}. [${fid}] ${info.name.slice(0, 40)}`);
  });
  console.log(`  0. Remove all`);
  console.log("");

  const answer = await promptUser("Enter number(s) to remove (comma-separated, or 0 for all): ");

  if (answer === "0") {
    await Bun.write(DATA_FILE, JSON.stringify({}, null, 2));
    console.log("All files removed");
    return;
  }

  const indices = answer.split(",").map(s => parseInt(s.trim(), 10) - 1);
  const validIndices = indices.filter(i => i >= 0 && i < entries.length);

  if (validIndices.length === 0) {
    console.log("No valid selection. Canceled.");
    return;
  }

  const removed: string[] = [];
  for (const i of validIndices) {
    const [fid, info] = entries[i];
    removed.push(info.name);
    delete data[fid];
  }

  await saveData(data);
  console.log(`Removed: ${removed.join(", ")}`);
  if (Object.keys(data).length > 0) {
    console.log(`Remaining: ${Object.keys(data).length} file(s)`);
  }
}

async function cmdList(): Promise<void> {
  const data = await loadData();

  if (Object.keys(data).length === 0) {
    console.log("Not tracking");
    return;
  }

  for (const [fid, info] of Object.entries(data)) {
    console.log(`[${fid}] ${info.name.slice(0, 50)} (${info.records.length}Item(s))`);
  }
}

async function cmdRun(): Promise<void> {
  console.log(`[Triggered: ${getTimestamp()}]`);

  const data = await loadData();

  if (Object.keys(data).length === 0) {
    console.log("Not tracking, run --add");
    return;
  }

  const today = getToday();
  const messages: string[] = [];

  for (const [fileId, info] of Object.entries(data)) {
    try {
      const stats = await fetchStats(fileId);
      const diff = calcDiff(info.records, stats);
      const record: Record = {
        date: today,
        user_count: stats.user_count,
        like_count: stats.like_count
      };

      if (info.records.length > 0 && info.records[info.records.length - 1].date === today) {
        info.records[info.records.length - 1] = record;
      } else {
        info.records.push(record);
      }

      const msg = buildMessage(info.name, diff);
      messages.push(msg);
      console.log(msg);
      console.log("---");
    } catch (e) {
      console.log(`Error ${fileId}: ${e}`);
    }
  }

  await saveData(data);

  if (messages.length > 0) {
    await sendWebhook({
      msg_type: "text",
      content: { text: messages.join("\n\n") }
    });
  }
}

function isValidTime24(timeStr: string): boolean {
  const regex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  return regex.test(timeStr);
}

function parseTimeList(timeStr: string): { hour: number; minute: number }[] | null {
  const times = timeStr.split(",").map(t => t.trim());
  const result: { hour: number; minute: number }[] = [];

  for (const time of times) {
    if (!isValidTime24(time)) {
      return null;
    }
    const [hourStr, minuteStr] = time.split(":");
    result.push({
      hour: parseInt(hourStr, 10),
      minute: parseInt(minuteStr, 10)
    });
  }

  return result;
}

function timeToMinutes(t: { hour: number; minute: number }): number {
  return t.hour * 60 + t.minute;
}

function getMinIntervalMinutes(times: { hour: number; minute: number }[]): number {
  if (times.length < 2) return Infinity;

  const sorted = [...times].sort((a, b) => timeToMinutes(a) - timeToMinutes(b));
  let minInterval = Infinity;

  for (let i = 0; i < sorted.length - 1; i++) {
    const interval = timeToMinutes(sorted[i + 1]) - timeToMinutes(sorted[i]);
    if (interval < minInterval) {
      minInterval = interval;
    }
  }

  // Also check wrap-around interval (last time to first time next day)
  const wrapInterval = 24 * 60 - timeToMinutes(sorted[sorted.length - 1]) + timeToMinutes(sorted[0]);
  if (wrapInterval < minInterval) {
    minInterval = wrapInterval;
  }

  return minInterval;
}

function buildCalendarIntervals(times: { hour: number; minute: number }[]): string {
  if (times.length === 1) {
    return `<dict>
        <key>Hour</key>
        <integer>${times[0].hour}</integer>
        <key>Minute</key>
        <integer>${times[0].minute}</integer>
    </dict>`;
  }

  const intervals = times.map(t => `        <dict>
            <key>Hour</key>
            <integer>${t.hour}</integer>
            <key>Minute</key>
            <integer>${t.minute}</integer>
        </dict>`).join("\n");

  return `<array>
${intervals}
    </array>`;
}

async function cmdSchedule(timeStr: string): Promise<void> {
  const newTimes = parseTimeList(timeStr);

  if (!newTimes || newTimes.length === 0) {
    console.log("Incorrect time format. Use HH:MM (24-hour format)");
    console.log("Multiple times: HH:MM,HH:MM (e.g., 09:00,18:00,21:00)");
    return;
  }

  // Load existing times from plist
  const plistFile = Bun.file(PLIST_PATH);
  let existingTimes: { hour: number; minute: number }[] = [];
  if (await plistFile.exists()) {
    const content = await plistFile.text();
    existingTimes = parseTimesFromPlist(content);
  }

  // Merge and deduplicate times
  const timeKey = (t: { hour: number; minute: number }) => `${t.hour}:${t.minute}`;
  const existingKeys = new Set(existingTimes.map(timeKey));
  const addedTimes: { hour: number; minute: number }[] = [];

  for (const t of newTimes) {
    if (!existingKeys.has(timeKey(t))) {
      existingTimes.push(t);
      addedTimes.push(t);
    }
  }

  if (addedTimes.length === 0) {
    console.log("All times already scheduled");
    return;
  }

  // Sort times
  const times = existingTimes.sort((a, b) => timeToMinutes(a) - timeToMinutes(b));

  // Check if any two times are less than 10 minutes apart
  const minInterval = getMinIntervalMinutes(times);
  if (minInterval < 10) {
    console.log("\x1b[31mInterval < 10min is likely to cause request failures due to Figma Request rate limits.\x1b[0m");
    const answer = await promptUser("Continue? (y/N): ");
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log("Canceled.");
      return;
    }
  }

  const bunPath = Bun.which("bun") || "/usr/local/bin/bun";
  const scriptPath = join(homedir(), ".figmatrack", "dist", "cli.js");
  const logPath = LOG_FILE;

  const calendarIntervals = buildCalendarIntervals(times);

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tracker.figma</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bunPath}</string>
        <string>${scriptPath}</string>
        <string>--run</string>
    </array>
    <key>StartCalendarInterval</key>
    ${calendarIntervals}
    <key>StandardOutPath</key>
    <string>${logPath}</string>
    <key>StandardErrorPath</key>
    <string>${logPath}</string>
</dict>
</plist>`;

  if (await plistFile.exists()) {
    await $`launchctl unload ${PLIST_PATH}`.quiet();
  }

  await Bun.write(PLIST_PATH, plistContent);
  const result = await $`launchctl load ${PLIST_PATH}`.quiet().nothrow();

  if (result.exitCode === 0) {
    const addedList = addedTimes.map(t =>
      `${t.hour.toString().padStart(2, "0")}:${t.minute.toString().padStart(2, "0")}`
    ).join(", ");
    const allList = times.map(t =>
      `${t.hour.toString().padStart(2, "0")}:${t.minute.toString().padStart(2, "0")}`
    ).join(", ");
    console.log(`Added: ${addedList}`);
    console.log(`All: ${allList}`);
  } else {
    console.log(`Set failed: ${result.stderr.toString()}`);
  }
}

function parseTimesFromPlist(content: string): { hour: number; minute: number }[] {
  const hourMatches = [...content.matchAll(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/g)];
  const minuteMatches = [...content.matchAll(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g)];

  if (hourMatches.length === 0 || hourMatches.length !== minuteMatches.length) {
    return [];
  }

  return hourMatches.map((hMatch, i) => ({
    hour: parseInt(hMatch[1], 10),
    minute: parseInt(minuteMatches[i][1], 10)
  }));
}

async function promptUser(message: string): Promise<string> {
  process.stdout.write(message);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

async function cmdUnschedule(timeStr?: string): Promise<void> {
  const plistFile = Bun.file(PLIST_PATH);

  if (!(await plistFile.exists())) {
    console.log("Not set");
    return;
  }

  // 读取当前配置的时间
  const content = await plistFile.text();
  const currentTimes = parseTimesFromPlist(content);

  if (currentTimes.length === 0) {
    console.log("No scheduled times found");
    return;
  }

  // 如果没有指定时间，列出所有时间点让用户选择
  if (!timeStr) {
    console.log("Current scheduled times:");
    currentTimes.forEach((t, i) => {
      const h = t.hour.toString().padStart(2, "0");
      const m = t.minute.toString().padStart(2, "0");
      console.log(`  ${i + 1}. ${h}:${m}`);
    });
    console.log(`  0. Cancel all`);
    console.log("");

    const answer = await promptUser("Enter number(s) to remove (comma-separated, or 0 for all): ");

    if (answer === "0") {
      await $`launchctl unload ${PLIST_PATH}`.quiet().nothrow();
      await $`rm ${PLIST_PATH}`.quiet();
      console.log("All tasks canceled");
      return;
    }

    // 解析用户输入的序号
    const indices = answer.split(",").map(s => parseInt(s.trim(), 10) - 1);
    const validIndices = indices.filter(i => i >= 0 && i < currentTimes.length);

    if (validIndices.length === 0) {
      console.log("No valid selection. Canceled.");
      return;
    }

    // 转换为时间字符串
    timeStr = validIndices.map(i => {
      const t = currentTimes[i];
      return `${t.hour.toString().padStart(2, "0")}:${t.minute.toString().padStart(2, "0")}`;
    }).join(",");
  }

  // 校验要移除的时间格式
  const timesToRemove = parseTimeList(timeStr);
  if (!timesToRemove || timesToRemove.length === 0) {
    console.log("Incorrect time format. Use HH:MM (e.g., 09:00 or 09:00,18:00)");
    return;
  }

  // 过滤掉要移除的时间
  const remainingTimes = currentTimes.filter(ct =>
    !timesToRemove.some(rt => rt.hour === ct.hour && rt.minute === ct.minute)
  );

  const removedCount = currentTimes.length - remainingTimes.length;
  if (removedCount === 0) {
    const timeList = timesToRemove.map(t =>
      `${t.hour.toString().padStart(2, "0")}:${t.minute.toString().padStart(2, "0")}`
    ).join(", ");
    console.log(`Time ${timeList} not found in schedule`);
    return;
  }

  // 如果没有剩余时间，完全取消任务
  if (remainingTimes.length === 0) {
    await $`launchctl unload ${PLIST_PATH}`.quiet().nothrow();
    await $`rm ${PLIST_PATH}`.quiet();
    console.log("All tasks canceled");
    return;
  }

  // 重新生成并加载配置
  const bunPath = Bun.which("bun") || "/usr/local/bin/bun";
  const scriptPath = join(homedir(), ".figmatrack", "dist", "cli.js");
  const logPath = LOG_FILE;
  const calendarIntervals = buildCalendarIntervals(remainingTimes);

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tracker.figma</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bunPath}</string>
        <string>${scriptPath}</string>
        <string>--run</string>
    </array>
    <key>StartCalendarInterval</key>
    ${calendarIntervals}
    <key>StandardOutPath</key>
    <string>${logPath}</string>
    <key>StandardErrorPath</key>
    <string>${logPath}</string>
</dict>
</plist>`;

  await $`launchctl unload ${PLIST_PATH}`.quiet().nothrow();
  await Bun.write(PLIST_PATH, plistContent);
  await $`launchctl load ${PLIST_PATH}`.quiet().nothrow();

  const removedList = timesToRemove
    .filter(rt => currentTimes.some(ct => ct.hour === rt.hour && ct.minute === rt.minute))
    .map(t => `${t.hour.toString().padStart(2, "0")}:${t.minute.toString().padStart(2, "0")}`)
    .join(", ");
  const remainingList = remainingTimes
    .map(t => `${t.hour.toString().padStart(2, "0")}:${t.minute.toString().padStart(2, "0")}`)
    .join(", ");

  console.log(`Removed: ${removedList}`);
  console.log(`Remaining: ${remainingList}`);
}

async function cmdStatus(): Promise<void> {
  const plistFile = Bun.file(PLIST_PATH);

  if (!(await plistFile.exists())) {
    console.log("Tasks not set");
    return;
  }

  const result = await $`launchctl list com.tracker.figma`.quiet().nothrow();

  if (result.exitCode === 0) {
    console.log("Tasks running");
    const content = await plistFile.text();

    const hourMatches = [...content.matchAll(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/g)];
    const minuteMatches = [...content.matchAll(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g)];

    if (hourMatches.length > 0 && hourMatches.length === minuteMatches.length) {
      const times = hourMatches.map((hMatch, i) => {
        const h = parseInt(hMatch[1], 10).toString().padStart(2, "0");
        const m = parseInt(minuteMatches[i][1], 10).toString().padStart(2, "0");
        return `${h}:${m}`;
      });
      console.log(`Daily run at ${times.join(", ")}`);
    }
  } else {
    console.log("Tasks stopped");
  }
}

async function cmdWebhook(action?: string, url?: string): Promise<void> {
  const config = await loadConfig();
  const webhookUrls = config.webhook_urls || [];

  // No action: list all webhooks
  if (!action) {
    if (webhookUrls.length === 0) {
      console.log("No webhooks configured");
    } else {
      console.log(`Webhooks (${webhookUrls.length}):`);
      webhookUrls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
    }
    return;
  }

  // Remove webhook interactively
  if (action === "remove") {
    if (webhookUrls.length === 0) {
      console.log("No webhooks to remove");
      return;
    }

    console.log("Current webhooks:");
    webhookUrls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
    console.log(`  0. Remove all`);
    console.log("");

    const answer = await promptUser("Enter number(s) to remove (comma-separated, or 0 for all): ");

    if (answer === "0") {
      config.webhook_urls = [];
      await saveConfig(config);
      console.log("All webhooks removed");
      return;
    }

    const indices = answer.split(",").map(s => parseInt(s.trim(), 10) - 1);
    const validIndices = indices.filter(i => i >= 0 && i < webhookUrls.length);

    if (validIndices.length === 0) {
      console.log("No valid selection. Canceled.");
      return;
    }

    // Remove in reverse order to keep indices valid
    const removed: string[] = [];
    validIndices.sort((a, b) => b - a).forEach(i => {
      removed.unshift(webhookUrls.splice(i, 1)[0]);
    });

    config.webhook_urls = webhookUrls;
    await saveConfig(config);
    console.log(`Removed: ${removed.join(", ")}`);
    if (webhookUrls.length > 0) {
      console.log(`Remaining: ${webhookUrls.length} webhook(s)`);
    }
    return;
  }

  // Add webhook
  if (action === "add") {
    if (!url) {
      console.log("Usage: ft --webhook add <URL>");
      return;
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      console.log("Invalid URL format");
      return;
    }

    // Check for duplicates
    if (webhookUrls.includes(url)) {
      console.log("Webhook already exists");
      return;
    }

    webhookUrls.push(url);
    config.webhook_urls = webhookUrls;
    await saveConfig(config);
    console.log(`Added: ${url}`);
    return;
  }

  // Unknown action
  console.log(`Unknown webhook command: ${action}`);
  console.log("Usage: ft --webhook [add|remove] [URL]");
}

async function getScheduledTimes(): Promise<string[]> {
  const plistFile = Bun.file(PLIST_PATH);
  if (!(await plistFile.exists())) return [];

  const result = await $`launchctl list com.tracker.figma`.quiet().nothrow();
  if (result.exitCode !== 0) return [];

  const content = await plistFile.text();
  const times = parseTimesFromPlist(content);
  return times.map(t => {
    const h = t.hour.toString().padStart(2, "0");
    const m = t.minute.toString().padStart(2, "0");
    return `${h}:${m}`;
  });
}

// ANSI color codes
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function getDisplayWidth(str: string): number {
  // Remove ANSI codes for width calculation
  const plain = str.replace(/\x1b\[[0-9;]*m/g, "");
  // Count wide characters (CJK) as 2
  let width = 0;
  for (const char of plain) {
    const code = char.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function padEnd(str: string, width: number): string {
  const currentWidth = getDisplayWidth(str);
  const padding = width - currentWidth;
  return str + " ".repeat(Math.max(0, padding));
}

function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

function printSimpleList(cols: { title: string; items: string[]; more?: string }[]): void {
  const MAX_DISPLAY = 5;

  for (const col of cols) {
    const items = col.items.slice(0, MAX_DISPLAY);
    const hasMore = col.items.length > MAX_DISPLAY;

    console.log(`${GREEN}${col.title}${RESET}`);
    if (items.length === 0 || (items.length === 1 && (items[0] === "None" || items[0] === "Not set"))) {
      console.log(`  ${DIM}${items[0] || "None"}${RESET}`);
    } else {
      items.forEach(item => console.log(`  ${item}`));
      if (hasMore && col.more) {
        console.log(`  ${DIM}... ${col.more}${RESET}`);
      }
    }
    console.log("");
  }
}

function truncateStr(str: string, maxWidth: number): string {
  if (getDisplayWidth(str) <= maxWidth) return str;

  let truncated = "";
  let width = 0;
  for (const char of str) {
    const charWidth = char.charCodeAt(0) >= 0x4e00 && char.charCodeAt(0) <= 0x9fff ? 2 : 1;
    if (width + charWidth > maxWidth - 2) break;
    truncated += char;
    width += charWidth;
  }
  return truncated + "..";
}

function printBox(cols: { title: string; items: string[]; more?: string }[]): void {
  const MAX_DISPLAY = 5;
  const MIN_WIDTH = 16;
  const termWidth = getTerminalWidth();

  // Calculate max column width based on terminal (leave room for 3 cols + 4 borders)
  const maxColWidth = Math.floor((termWidth - 4) / 3);

  // If terminal too narrow for table, use simple list
  if (maxColWidth < MIN_WIDTH) {
    printSimpleList(cols);
    return;
  }

  // Prepare display items for each column (with truncation)
  const displayCols = cols.map(col => {
    const items = col.items.slice(0, MAX_DISPLAY).map(item => truncateStr(item, maxColWidth - 2));
    if (col.items.length > MAX_DISPLAY && col.more) {
      items.push(`${DIM}${col.more}${RESET}`);
    }
    return { title: col.title, items };
  });

  // Calculate column widths based on content (capped at maxColWidth)
  const colWidths = displayCols.map(col => {
    const titleWidth = getDisplayWidth(col.title) + 2;
    const maxItemWidth = Math.max(...col.items.map(item => getDisplayWidth(item) + 2));
    return Math.min(maxColWidth, Math.max(MIN_WIDTH, titleWidth, maxItemWidth));
  });

  // Calculate max rows
  const maxRows = Math.max(...displayCols.map(c => c.items.length), 1);

  // Box drawing
  const h = "─";
  const v = "│";
  const tl = "┌"; const tr = "┐";
  const bl = "└"; const br = "┘";
  const tm = "┬"; const bm = "┴";
  const lm = "├"; const rm = "┤";
  const cross = "┼";

  const colLines = colWidths.map(w => h.repeat(w));

  // Top border
  console.log(`${GREEN}${tl}${colLines[0]}${tm}${colLines[1]}${tm}${colLines[2]}${tr}${RESET}`);

  // Header row
  const headers = displayCols.map((c, i) => ` ${BOLD}${c.title}${RESET}`);
  console.log(`${GREEN}${v}${RESET}${padEnd(headers[0], colWidths[0])}${GREEN}${v}${RESET}${padEnd(headers[1], colWidths[1])}${GREEN}${v}${RESET}${padEnd(headers[2], colWidths[2])}${GREEN}${v}${RESET}`);

  // Header separator
  console.log(`${GREEN}${lm}${colLines[0]}${cross}${colLines[1]}${cross}${colLines[2]}${rm}${RESET}`);

  // Content rows
  for (let i = 0; i < maxRows; i++) {
    const row = displayCols.map((c, colIdx) => {
      const item = c.items[i] || "";
      return ` ${item}`;
    });
    console.log(`${GREEN}${v}${RESET}${padEnd(row[0], colWidths[0])}${GREEN}${v}${RESET}${padEnd(row[1], colWidths[1])}${GREEN}${v}${RESET}${padEnd(row[2], colWidths[2])}${GREEN}${v}${RESET}`);
  }

  // Bottom border
  console.log(`${GREEN}${bl}${colLines[0]}${bm}${colLines[1]}${bm}${colLines[2]}${br}${RESET}`);
}

async function printHelp(): Promise<void> {
  console.log(`${BOLD}Figma Community Stats Tracker${RESET}\n`);

  // Load current config summary
  const data = await loadData();
  const webhookUrls = await getWebhookUrls();
  const scheduledTimes = await getScheduledTimes();

  const fileCount = Object.keys(data).length;
  const webhookCount = webhookUrls.length;
  const timeCount = scheduledTimes.length;

  // Prepare columns
  const filesCol = {
    title: `Files (${fileCount})`,
    items: fileCount > 0 ? Object.values(data).map(f => f.name) : ["None"],
    more: "ft --list"
  };

  const webhooksCol = {
    title: `Webhooks (${webhookCount})`,
    items: webhookCount > 0 ? webhookUrls : ["None"],
    more: "ft --webhook"
  };

  const scheduleCol = {
    title: `Schedule (${timeCount})`,
    items: timeCount > 0 ? scheduledTimes : ["Not set"],
    more: "ft --schedule"
  };

  printBox([filesCol, webhooksCol, scheduleCol]);

  console.log(`
${GREEN}Files${RESET}
  ft --add <URL>       Add file
  ft --remove          Remove file
  ft --list            List files
  
  ${GREEN}Schedule${RESET}
  ft --run                 Run immediately
  ft --schedule add <HH:MM>       Add schedule (e.g. 09:00 or 09:00,18:00)
  ft --schedule remove     Remove schedule
  ft --schedule            List schedule

${GREEN}Webhook${RESET}
  ft --webhook add <URL>    Add webhook
  ft --webhook remove  Remove webhook
  ft --webhook         List webhooks
  `);
}

// ============ 入口 ============

// 解析可选值参数的辅助函数
function parseOptionalArg(args: string[], flag: string): { has: boolean; value?: string; indices: number[] } {
  const index = args.indexOf(flag);
  if (index === -1) return { has: false, indices: [] };

  let value: string | undefined;
  const indices = [index];

  if (index + 1 < args.length) {
    const nextArg = args[index + 1];
    if (!nextArg.startsWith("--")) {
      value = nextArg;
      indices.push(index + 1);
    }
  }

  return { has: true, value, indices };
}

// 解析支持两个可选值的参数 (用于 --webhook [action] [url])
function parseMultiValueArg(args: string[], flag: string, maxValues: number = 2): { has: boolean; values: string[]; indices: number[] } {
  const index = args.indexOf(flag);
  if (index === -1) return { has: false, values: [], indices: [] };

  const values: string[] = [];
  const indices = [index];

  for (let i = 1; i <= maxValues && index + i < args.length; i++) {
    const nextArg = args[index + i];
    if (nextArg.startsWith("--")) break;
    values.push(nextArg);
    indices.push(index + i);
  }

  return { has: true, values, indices };
}

const args = Bun.argv.slice(2);

// 处理可选值参数
const removeArg = parseOptionalArg(args, "--remove");
const scheduleArg = parseMultiValueArg(args, "--schedule", 2);
const webhookArg = parseMultiValueArg(args, "--webhook", 2);

// 过滤掉已处理的参数
const indicesToFilter = new Set([...removeArg.indices, ...scheduleArg.indices, ...webhookArg.indices]);
const filteredArgs = args.filter((_, i) => !indicesToFilter.has(i));

const { values, positionals } = parseArgs({
  args: filteredArgs,
  options: {
    add: { type: "string" },
    list: { type: "boolean" },
    run: { type: "boolean" },
    help: { type: "boolean" }
  },
  allowPositionals: true
});

if (values.list) {
  await cmdList();
} else if (values.add) {
  await cmdAdd(values.add);
} else if (removeArg.has) {
  await cmdRemove(removeArg.value);
} else if (values.run) {
  await cmdRun();
} else if (scheduleArg.has) {
  const action = scheduleArg.values[0];
  if (action === "add") {
    await cmdSchedule(scheduleArg.values[1]);
  } else if (action === "remove") {
    await cmdUnschedule(scheduleArg.values[1]);
  } else if (action === "status" || !action) {
    await cmdStatus();
  } else {
    // Treat as time string for backward compatibility
    await cmdSchedule(action);
  }
} else if (webhookArg.has) {
  await cmdWebhook(webhookArg.values[0], webhookArg.values[1]);
} else {
  await printHelp();
}
