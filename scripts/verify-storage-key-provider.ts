import assert from "node:assert/strict";
import { STORAGE_DB_KEY_ACCOUNT, STORAGE_DB_KEY_SERVICE } from "../src/security/storageKeyProvider.js";
assert.equal(STORAGE_DB_KEY_SERVICE, "fan.fde.owl.runtime.storage-metadata");
assert.equal(STORAGE_DB_KEY_ACCOUNT, "default");
const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/security/storageKeyProvider.ts", import.meta.url), "utf8"));
assert.match(source, /randomBytes\(32\)/);
assert.match(source, /\/usr\/bin\/security/);
assert.doesNotMatch(source, /process\.env.*KEY/i);
console.log(JSON.stringify({ok:true, provider:"macos-keychain", keyBits:256, envKeyFallback:false}, null, 2));
