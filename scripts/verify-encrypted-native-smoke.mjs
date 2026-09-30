import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mode = process.argv[2];
console.error(`[encrypted-native-smoke] mode=${mode} start`);

const imported = await import("better-sqlite3-multiple-ciphers");
const Database = imported.default;
console.error("[encrypted-native-smoke] import=ok");

if (mode === "import") {
  console.log(JSON.stringify({ ok: true, mode }));
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "owl-native-smoke-"));
const file = path.join(root, "smoke.db");
let db;
try {
  db = new Database(file);
  console.error("[encrypted-native-smoke] open=ok");

  if (mode === "open") {
    console.log(JSON.stringify({ ok: true, mode }));
    process.exitCode = 0;
  } else {
    db.pragma("cipher='sqlcipher'");
    db.pragma("legacy=4");
    console.error("[encrypted-native-smoke] cipher-pragmas=ok");

    if (mode === "cipher") {
      console.log(JSON.stringify({ ok: true, mode }));
    } else {
      const status = db.key(Buffer.from("31".repeat(32), "hex"));
      console.error(`[encrypted-native-smoke] key=ok status=${status}`);

      if (mode === "key") {
        console.log(JSON.stringify({ ok: true, mode, status }));
      } else if (mode === "sql") {
        db.prepare("SELECT count(*) AS count FROM sqlite_master").get();
        console.error("[encrypted-native-smoke] first-sql=ok");
        db.exec("CREATE TABLE smoke(id INTEGER PRIMARY KEY, value TEXT) STRICT;");
        db.prepare("INSERT INTO smoke(value) VALUES (?)").run("ok");
        console.log(JSON.stringify({ ok: true, mode, status }));
      } else {
        throw new Error(`unknown mode: ${mode}`);
      }
    }
  }
} finally {
  if (db?.open) db.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.error(`[encrypted-native-smoke] mode=${mode} cleanup=ok`);
}
