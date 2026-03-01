import path from "path";
import { spawnSync } from "child_process";

const dbName = String(process.env.MONGODB_DB || "lovechatty").trim() || "lovechatty";
const tmpDb = `${dbName}_restore_test`;
const backupScript = path.resolve("backend/scripts/mongo-backup.mjs");
const restoreScript = path.resolve("backend/scripts/mongo-restore.mjs");
const dryRun = !process.argv.includes("--execute");

const backup = spawnSync(process.execPath, [backupScript, "--dry-run", `--db=${dbName}`], {
  stdio: "pipe",
  encoding: "utf8",
});
if (backup.status !== 0) {
  console.error("Backup dry-run failed");
  console.error(backup.stdout || "");
  console.error(backup.stderr || "");
  process.exit(1);
}

const backupInfo = JSON.parse((backup.stdout || "{}").trim() || "{}");
const archivePath = backupInfo.archivePath || path.resolve(`./backups/${dbName}-dry-run.gz.archive`);

const restoreArgs = [restoreScript, "--dry-run", `--db=${tmpDb}`, `--archive=${archivePath}`, "--drop"];
const restore = spawnSync(process.execPath, restoreArgs, {
  stdio: "pipe",
  encoding: "utf8",
});
if (restore.status !== 0) {
  console.error("Restore dry-run failed");
  console.error(restore.stdout || "");
  console.error(restore.stderr || "");
  process.exit(1);
}

const restoreInfo = JSON.parse((restore.stdout || "{}").trim() || "{}");
console.log(JSON.stringify({
  success: true,
  mode: dryRun ? "dry-run" : "execute-not-implemented",
  backup: backupInfo,
  restore: restoreInfo,
  note: "Dry-run validates backup/restore command generation and target restore DB naming.",
}, null, 2));
