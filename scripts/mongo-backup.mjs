import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const getArg = (name, fallback = "") => {
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

let mongoUri = String(process.env.MONGODB_URI || "").trim();
const dbName = getArg("--db", String(process.env.MONGODB_DB || "lovechatty").trim());
const backupDir = path.resolve(getArg("--out", process.env.BACKUP_DIR || "./backups"));
const label = getArg("--label", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
const archivePath = path.join(backupDir, `${dbName}-${label}.gz.archive`);

if (!mongoUri) {
  if (dryRun) {
    mongoUri = "mongodb://example.invalid:27017";
  } else {
    console.error("MONGODB_URI is required");
    process.exit(1);
  }
}

fs.mkdirSync(backupDir, { recursive: true });

const cmdArgs = [
  `--uri=${mongoUri}`,
  `--db=${dbName}`,
  `--archive=${archivePath}`,
  "--gzip",
];

console.log(JSON.stringify({ action: "backup", archivePath, cmd: "mongodump", args: cmdArgs, dryRun }, null, 2));

if (dryRun) {
  process.exit(0);
}

const child = spawn("mongodump", cmdArgs, { stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code || 0));
