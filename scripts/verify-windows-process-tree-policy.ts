import assert from "node:assert/strict";
import {authorizedWindowsPidTime} from "../src/runtime/windowsProcessTree.js";
const t="2026-11-09T13:00:06.000Z";
assert.equal(authorizedWindowsPidTime("2026-11-09T13:00:00.000Z",t,Date.parse(t)+5000),true);
assert.equal(authorizedWindowsPidTime("2026-11-09T12:40:00.000Z",t,Date.parse(t)+5000),false);
assert.equal(authorizedWindowsPidTime(undefined,t),false);
assert.equal(authorizedWindowsPidTime("bad",t),false);
console.log("PASS: PID birth identity fails closed for stale/recycled records");
