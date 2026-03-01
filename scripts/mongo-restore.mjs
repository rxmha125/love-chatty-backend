import { spawn } from "child_process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const shouldDrop = args.includes("--drop");

const getArg = (name, fallback = "") => {
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

let mongoUri = getArg("--uri", String(process.env.MONGODB_URI || "").trim());
const dbName = getArg("--db", String(process.env.MONGODB_DB || "lovechatty").trim());
const archivePath = getArg("--archive", "");

if (!dbName || !archivePath) {
  console.error("Usage: node mongo-restore.mjs --archive=<file> [--uri=<mongoUri>] [--db=<db>] [--drop] [--dry-run]");
  process.exit(1);
}

if (!mongoUri) {
  if (dryRun) {
    mongoUri = "mongodb://example.invalid:27017";
  } else {
    console.error("Usage: node mongo-restore.mjs --archive=<file> [--uri=<mongoUri>] [--db=<db>] [--drop] [--dry-run]");
    process.exit(1);
  }
}

const cmdArgs = [
  `--uri=${mongoUri}`,
  `--db=${dbName}`,
  `--archive=${archivePath}`,
  "--gzip",
];
if (shouldDrop) {
  cmdArgs.push("--drop");
}

console.log(JSON.stringify({ action: "restore", archivePath, dbName, cmd: "mongorestore", args: cmdArgs, dryRun }, null, 2));

if (dryRun) {
  process.exit(0);
}

const child = spawn("mongorestore", cmdArgs, { stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code || 0));
