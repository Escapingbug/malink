import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../../../clients/android/app/src/main/java/id/my/anciety/malink/web/MainActivity.kt", import.meta.url), "utf8");
test("pause invalidates bootstrap timers and outstanding probe generations", () => {
  const pause = source.slice(source.indexOf("override fun onPause()"), source.indexOf("override fun onStop()"));
  assert.match(pause, /webBootstrapGeneration \+= 1/);
  assert.match(pause, /webBootstrapTimeout\?\.cancel\(\)/);
  const timer = source.slice(source.indexOf("private fun scheduleWebBootstrapTimeout"), source.indexOf("private fun acknowledgeWebBootstrap"));
  assert.match(timer, /!webViewResumed\) return/);
  assert.match(timer, /&& webViewResumed/);
  const resume = source.slice(source.indexOf("override fun onResume()"), source.indexOf("override fun onPause()"));
  assert.match(resume, /scheduleWebBootstrapTimeout\(this\)/);
});
test("late readiness replaces the stale recovery page", () => {
  const ready = source.slice(source.indexOf("private fun acknowledgeWebBootstrap"), source.indexOf("private fun stopWebBootstrap"));
  assert.match(ready, /if \(webBootstrapRecoveryVisible\)/);
  assert.match(ready, /showContent\(current\)/);
});
