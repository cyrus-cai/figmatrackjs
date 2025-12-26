#!/usr/bin/env bun
/**
 * Figma Community Stats Tracker
 * Usage:
 *   # Files
 *   ft --add <URL|ID>           Add file (figma community file URL or numeric ID)
 *   ft --remove                 Remove file
 *   ft --list                   List tracked files
 *
 *   # Schedule
 *   ft --run                    Run immediately
 *   ft --schedule add <HH:MM>   Add schedule (e.g. 09:00 18:00 or 09:00,18:00)
 *   ft --schedule remove        Remove schedule
 *   ft --schedule list          List schedule
 *
 *   # Webhook
 *   ft --webhook add <URL>      Add webhook (e.g. URL1 URL2 or URL1,URL2)
 *   ft --webhook remove         Remove webhook
 *   ft --webhook list           List webhooks
 *
 *   # Help
 *   ft --docs                   Open documentation
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
  timestamp?: string;
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

function extractFileId(input: string): string {
  // Support pure numeric ID
  if (/^\d+$/.test(input)) {
    return input;
  }
  // Support full URL
  const match = input.match(/community\/file\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid input: ${input}`);
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

  if (records.length > 0) {
    const lastRecord = records[records.length - 1];
    result.diff_user = todayStats.user_count - lastRecord.user_count;
    result.diff_like = todayStats.like_count - lastRecord.like_count;
    result.compare_date = lastRecord.timestamp || lastRecord.date;
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

function formatCompareDate(dateStr: string): string {
  // Input: "YYYY/MM/DD HH:MM:SS" or "YYYY-MM-DD"
  // Output: "MM/DD HH:MM" or "MM/DD"
  if (dateStr.includes("/")) {
    // Format: YYYY/MM/DD HH:MM:SS
    const match = dateStr.match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/);
    if (match) {
      return `${match[2]}/${match[3]} ${match[4]}:${match[5]}`;
    }
  } else if (dateStr.includes("-")) {
    // Format: YYYY-MM-DD
    const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      return `${match[2]}/${match[3]}`;
    }
  }
  return dateStr;
}

function buildMessage(name: string, diff: Diff): string {
  const indent = "     ";
  const lines: string[] = [`[${name}]`];

  const u = diff.diff_user !== null ? (diff.diff_user >= 0 ? `(+${diff.diff_user})` : `(${diff.diff_user})`) : "";
  const l = diff.diff_like !== null ? (diff.diff_like >= 0 ? `(+${diff.diff_like})` : `(${diff.diff_like})`) : "";

  lines.push(`${indent}users:${diff.user_count} ${u}`);
  lines.push(`${indent}likes:${diff.like_count} ${l}`);

  if (diff.compare_date) {
    lines.push(`${indent}vs ${formatCompareDate(diff.compare_date)}`);
  } else {
    lines.push(`${indent}First record`);
  }

  return lines.join("\n");
}

// ============ 命令 ============

function parseUrlList(urlStr: string): string[] {
  // Support both comma and space as separators
  return urlStr.split(/[,\s]+/).map(u => u.trim()).filter(u => u.length > 0);
}

async function cmdAdd(urlStr: string): Promise<void> {
  const urls = parseUrlList(urlStr);

  if (urls.length === 0) {
    console.log("Usage: ft --add <URL|ID> [URL|ID...]");
    console.log("Example: ft --add figma.com/community/file/xxxxx or ft --add xxxxx");
    return;
  }

  const data = await loadData();
  const currentCount = Object.keys(data).length;

  // Extract all file IDs first to validate
  const fileIds: { url: string; fileId: string }[] = [];
  for (const url of urls) {
    try {
      const fileId = extractFileId(url);
      fileIds.push({ url, fileId });
    } catch (e) {
      console.log(`Invalid URL: ${url}`);
    }
  }

  if (fileIds.length === 0) {
    return;
  }

  // Filter out already existing files
  const newFiles = fileIds.filter(f => !(f.fileId in data));
  const existingFiles = fileIds.filter(f => f.fileId in data);

  if (existingFiles.length > 0) {
    console.log(`Already exists: ${existingFiles.map(f => f.fileId).join(", ")}`);
  }

  if (newFiles.length === 0) {
    return;
  }

  // Check if adding would exceed 5 files
  const totalAfterAdd = currentCount + newFiles.length;
  if (totalAfterAdd > 5) {
    console.log(`\x1b[31mAdding ${newFiles.length} file(s) will result in ${totalAfterAdd} total files. More files may cause Figma request failures.\x1b[0m`);
    const answer = await promptUser("Continue? (y/N): ");
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log("Canceled.");
      return;
    }
  }

  // Fetch and add each file
  const added: string[] = [];
  for (const { fileId } of newFiles) {
    try {
      const stats = await fetchStats(fileId);
      data[fileId] = { name: stats.name, records: [] };
      added.push(stats.name);
    } catch (e) {
      console.log(`Error fetching ${fileId}: ${e}`);
    }
  }

  if (added.length > 0) {
    await saveData(data);
    console.log(`Added: ${added.join(", ")}`);
  }
}

async function cmdRemove(fileId?: string): Promise<void> {
  const data = await loadData();
  const entries = Object.entries(data);

  if (entries.length === 0) {
    console.log("Not configured");
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
    console.log("Not configured");
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
    console.log("Not configured, run --add");
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
        timestamp: getTimestamp(),
        user_count: stats.user_count,
        like_count: stats.like_count
      };

      info.records.push(record);

      const msg = buildMessage(info.name, diff);
      messages.push(msg);
      console.log(msg);
      console.log("");
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
  // Support both comma and space as separators
  const times = timeStr.split(/[,\s]+/).map(t => t.trim()).filter(t => t.length > 0);
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
    console.log("Multiple times: HH:MM HH:MM or HH:MM,HH:MM (e.g., 09:00 18:00 or 09:00,18:00)");
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
    console.log("Not configured");
    return;
  }

  // 读取当前配置的时间
  const content = await plistFile.text();
  const currentTimes = parseTimesFromPlist(content);

  if (currentTimes.length === 0) {
    console.log("Not configured");
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
    console.log("Not configured");
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

  // List all webhooks
  if (action === "list") {
    if (webhookUrls.length === 0) {
      console.log("Not configured");
    } else {
      console.log(`Webhooks (${webhookUrls.length}):`);
      webhookUrls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
    }
    return;
  }

  // Remove webhook interactively
  if (action === "remove") {
    if (webhookUrls.length === 0) {
      console.log("Not configured");
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

  // Add webhook (supports multiple URLs)
  if (action === "add") {
    if (!url) {
      console.log("Usage: ft --webhook add <URL> [URL...]");
      console.log("Multiple URLs: URL1 URL2 or URL1,URL2");
      return;
    }

    // Parse URL list (url may contain multiple URLs from parseMultiValueArg)
    const urlList = parseUrlList(url);

    if (urlList.length === 0) {
      console.log("Usage: ft --webhook add <URL> [URL...]");
      return;
    }

    // Validate and filter URLs
    const validUrls: string[] = [];
    const invalidUrls: string[] = [];
    const duplicateUrls: string[] = [];

    for (const u of urlList) {
      try {
        new URL(u);
        if (webhookUrls.includes(u)) {
          duplicateUrls.push(u);
        } else if (!validUrls.includes(u)) {
          validUrls.push(u);
        }
      } catch {
        invalidUrls.push(u);
      }
    }

    if (invalidUrls.length > 0) {
      console.log(`Invalid URL: ${invalidUrls.join(", ")}`);
    }
    if (duplicateUrls.length > 0) {
      console.log(`Already exists: ${duplicateUrls.join(", ")}`);
    }

    if (validUrls.length === 0) {
      return;
    }

    webhookUrls.push(...validUrls);
    config.webhook_urls = webhookUrls;
    await saveConfig(config);
    console.log(`Added: ${validUrls.join(", ")}`);
    return;
  }

  // Unknown action
  console.log("Unknown command. Use: add, remove, list");
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
    if (items.length === 0 || (items.length === 1 && items[0] === "Not configured")) {
      console.log(`  ${DIM}${items[0] || "Not configured"}${RESET}`);
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
    items: fileCount > 0 ? Object.values(data).map(f => f.name) : ["Not configured"],
    more: "ft --list"
  };

  const webhooksCol = {
    title: `Webhooks (${webhookCount})`,
    items: webhookCount > 0 ? webhookUrls : ["Not configured"],
    more: "ft --webhook"
  };

  const scheduleCol = {
    title: `Schedule (${timeCount})`,
    items: timeCount > 0 ? scheduledTimes : ["Not configured"],
    more: "ft --schedule"
  };

  printBox([filesCol, webhooksCol, scheduleCol]);

  console.log(`
${GREEN}Files${RESET}
  ft --add <URL|ID>           Add file (URL or numeric ID)
  ft --remove                 Remove file
  ft --list                   List tracked files

${GREEN}Schedule${RESET}
  ft --run                    Run immediately
  ft --schedule add <HH:MM>   Add schedule (e.g. 09:00 18:00 or 09:00,18:00)
  ft --schedule remove        Remove schedule
  ft --schedule list          List schedule

${GREEN}Webhook${RESET}
  ft --webhook add <URL>      Add webhook (e.g. URL1 URL2 or URL1,URL2)
  ft --webhook remove         Remove webhook
  ft --webhook list           List webhooks

${GREEN}Help${RESET}
  ft --docs                   Open documentation
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
const addArg = parseMultiValueArg(args, "--add", 20);
const scheduleArg = parseMultiValueArg(args, "--schedule", 20);
const webhookArg = parseMultiValueArg(args, "--webhook", 21); // action + up to 20 URLs

// 过滤掉已处理的参数
const indicesToFilter = new Set([...removeArg.indices, ...addArg.indices, ...scheduleArg.indices, ...webhookArg.indices]);
const filteredArgs = args.filter((_, i) => !indicesToFilter.has(i));

const { values, positionals } = parseArgs({
  args: filteredArgs,
  options: {
    list: { type: "boolean" },
    run: { type: "boolean" },
    help: { type: "boolean" },
    docs: { type: "boolean" }
  },
  allowPositionals: true
});

if (values.list) {
  await cmdList();
} else if (addArg.has) {
  const urlStr = addArg.values.join(" ");
  await cmdAdd(urlStr);
} else if (removeArg.has) {
  await cmdRemove(removeArg.value);
} else if (values.run) {
  await cmdRun();
} else if (scheduleArg.has) {
  const action = scheduleArg.values[0];
  if (action === "add") {
    // Join all time arguments with space (supports both space and comma separated)
    const timeArgs = scheduleArg.values.slice(1).join(" ");
    await cmdSchedule(timeArgs);
  } else if (action === "remove") {
    await cmdUnschedule(scheduleArg.values[1]);
  } else if (action === "list") {
    await cmdStatus();
  } else {
    console.log("Unknown command. Use: add, remove, list");
  }
} else if (webhookArg.has) {
  const action = webhookArg.values[0];
  // Join all URL arguments with space (supports both space and comma separated)
  const urlArgs = webhookArg.values.slice(1).join(" ");
  await cmdWebhook(action, urlArgs || undefined);
} else if (values.docs) {
  const readmePath = join(FIGMATRACK_DIR, "README.md");
  const file = Bun.file(readmePath);
  if (await file.exists()) {
    Bun.spawn(["open", readmePath]);
  } else {
    console.log("Documentation not found. Visit: https://github.com/cyrus-cai/figmatrackjs/blob/main/README.md");
  }
} else {
  await printHelp();
}
