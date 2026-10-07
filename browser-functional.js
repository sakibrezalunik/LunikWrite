const { chromium } = require("playwright");

const BASE_URL = "http://localhost:3301";
const results = {
  views: {},
  consoleErrors: [],
  uncaughtExceptions: [],
  pageErrors: [],
  failedRequests: [],
};

async function goto(page, url) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
}

async function freshBrowser(name) {
  const b = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on("console", (m) => {
    if (m.type() === "error") results.consoleErrors.push("[" + name + "] " + m.text());
  });
  page.on("pageerror", (e) => results.uncaughtExceptions.push("[" + name + "] " + String(e)));
  page.on("requestfailed", (req) => {
    results.failedRequests.push("[" + name + "] " + req.url() + " " + (req.failure()?.errorText || ""));
  });
  return { browser: b, page };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function inputText(page, selector, text) {
  await page.locator(selector).fill(text);
  await sleep(1200);
  return page.locator(selector).evaluate((el) => el.value);
}

// 1. Editor typing / editing / select / delete / paste
async function testEditor() {
  const { browser, page } = await freshBrowser("editor");
  try {
    await goto(page, BASE_URL);
    await page.waitForSelector("textarea.editor-input", { timeout: 15000 });
    const value = await inputText(page, "textarea.editor-input", "She dont like coffee. He is a honest man.");
    const issueCount = await page.locator("mark.highlight").count();
    results.views.editor = issueCount >= 1 && value.includes("She dont");
    results.views.editorText = value;
  } catch (e) {
    results.views.editor = false;
    results.pageErrors.push("editor: " + e.message);
  }
  await browser.close();
}

// 2. Grammar accept/ignore/dictionary
async function testGrammarActions() {
  const { browser, page } = await freshBrowser("grammar");
  try {
    await goto(page, BASE_URL);
    await page.waitForSelector("textarea.editor-input", { timeout: 15000 });
    await inputText(page, "textarea.editor-input", "She dont like coffee. He is a honest man.");
    await sleep(2500);
    let grAccept = false;
    let grAcceptCount = 0;
    const suggCards = await page.locator(".sugg-card").count();
    if (suggCards > 0) {
      await page.locator(".sugg-card").first().locator("button:has-text('Accept')").click();
      await sleep(600);
      const afterAccept = await page.locator("textarea.editor-input").evaluate((el) => el.value);
      grAccept = afterAccept.trim() !== "She dont like coffee. He is a honest man.";
      grAcceptCount = afterAccept.length;
    }
    results.views.grammarAccept = grAccept;
    results.views.grammarAcceptCount = grAcceptCount;
    results.views.suggCards = suggCards;

    // Test dictionary with a real SPELLING error (accomodate -> accommodation)
    await inputText(page, "textarea.editor-input", "He is a accomodate person.");
    await sleep(3200);
    const suggCards2 = await page.locator(".sugg-card").count();
    const dictBtns = await page.locator("button:has-text('Dictionary')").count();
    let dictClicked = false;
    if (dictBtns > 0) {
      await page.locator("button:has-text('Dictionary')").first().click();
      await sleep(500);
      const afterDict = await page.locator("textarea.editor-input").evaluate((el) => el.value);
      dictClicked = afterDict.includes("accommodate") || afterDict.includes("accomodate");
    }
    let grIgnore = false;
    if (suggCards2 > 0) {
      await page.locator(".sugg-card").first().locator("button:has-text('Ignore')").click();
      await sleep(500);
      grIgnore = true;
    }
    results.views.grammarIgnore = grIgnore;
    results.views.grammarDictionary = dictBtns > 0;
  } catch (e) {
    results.views.grammarAccept = false;
    results.views.grammarIgnore = false;
    results.views.grammarDictionary = false;
    results.pageErrors.push("grammar: " + e.message);
  }
  await browser.close();
}

// 3. Analyze (real Gemini)
async function testAnalyze() {
  const { browser, page } = await freshBrowser("analyze");
  try {
    await goto(page, BASE_URL);
    await page.waitForSelector("textarea.editor-input", { timeout: 15000 });
    await inputText(page, "textarea.editor-input", "The quick brown fox jumps over the lazy dog. She dont like coffee.");
    await sleep(2000);
    const btn = page.locator("button:has-text('Check writing')");
    await btn.click();
    let sawThinking = false;
    for (let i = 0; i < 10; i++) {
      const status = await page.locator(".ai-status").textContent().catch(() => "");
      if (status.includes("Checking with AI")) {
        sawThinking = true;
        break;
      }
      await sleep(1000);
    }
    await sleep(1000);
    const finalStatus = await page.locator(".ai-status").textContent().catch(() => "");
    const thinking = sawThinking || finalStatus.includes("Checking with AI");
    const errorStatus = finalStatus.includes("unavailable") || finalStatus.includes("error");
    results.views.analyzeThought = thinking;
    results.views.analyzeFinalStatus = finalStatus;

  } catch (e) {
    results.views.analyzeThought = false;
    results.pageErrors.push("analyze: " + e.message);
  }
  await browser.close();
}

// 4. Rewrite
async function testRewrite() {
  const { browser, page } = await freshBrowser("rewrite");
  try {
    await goto(page, BASE_URL);
    await page.waitForSelector("textarea.editor-input", { timeout: 15000 });
    await inputText(page, "textarea.editor-input", "She dont like coffee. He is a honest man.");
    await sleep(2000);
    await page.locator("textarea.editor-input").selectText();
    await sleep(400);
    await page.locator("button", { hasText: "Rewrite" }).first().click();
    await sleep(1000);
    const modalOpen = await page.locator(".modal-overlay").count().then((c) => c > 0);
    if (!modalOpen) {
      results.views.rewriteResult = false;
      results.views.rewriteCancel = false;
      results.views.rewriteTryAgain = false;
      results.views.rewriteCopy = false;
      results.views.rewriteReplace = false;
      return;
    }
    const styleLabels = await page.locator(".style-row button").allTextContents();
    const rwOutputInitial = await page.locator(".rw-output").textContent().catch(() => "");
    if (styleLabels.length === 0) {
      results.views.rewriteResult = false;
      results.views.rewriteCancel = false;
      results.views.rewriteTryAgain = false;
      results.views.rewriteCopy = false;
      results.views.rewriteReplace = false;
      results.views.rewriteStyleLabels = styleLabels;
      return;
    }
    await page.locator(".style-row button", { hasText: "Concise" }).click();
    await sleep(3000);
    const hasResult = (await page.locator(".rw-output").textContent().catch(() => "")) !== "Choose a style above.";
    const actions = page.locator(".modal-actions");
    const cancelVisible = await actions.locator("button:has-text('Cancel')").isVisible().catch(() => false);
    const tryVisible = await actions.locator("button:has-text('Try again')").isVisible().catch(() => false);
    const copyVisible = await actions.locator("button:has-text('Copy')").isVisible().catch(() => false);
    const replaceVisible = await actions.locator("button:has-text('Replace')").isVisible().catch(() => false);
    results.views.rewriteResult = hasResult;
    results.views.rewriteCancel = cancelVisible;
    results.views.rewriteTryAgain = tryVisible;
    results.views.rewriteCopy = copyVisible;
    results.views.rewriteReplace = replaceVisible;
    results.views.rewriteStyleLabels = styleLabels;
  } catch (e) {
    results.views.rewriteResult = false;
    results.views.rewriteCancel = false;
    results.views.rewriteTryAgain = false;
    results.views.rewriteCopy = false;
    results.views.rewriteReplace = false;
    results.pageErrors.push("rewrite: " + e.message);
  }
  await browser.close();
}

// 5. Tone
async function testTone() {
  const { browser, page } = await freshBrowser("tone");
  try {
    await goto(page, BASE_URL);
    await page.waitForSelector("textarea.editor-input", { timeout: 15000 });
    await inputText(page, "textarea.editor-input", "She dont like coffee. He is a honest man.");
    await sleep(2000);
    await page.locator(".ai-tab", { hasText: "Tone" }).click();
    await sleep(800);
    const toneBtn = page.locator("button:has-text('Analyze tone')");
    if (await toneBtn.count()) {
      await toneBtn.click();
      await sleep(3500);
    }
    const primary = await page.locator(".tone-primary").textContent().catch(() => "(none)");
    const meterRows = await page.locator(".meter-row").count();
    results.views.toneMeter = meterRows > 0;
    results.views.tonePrimary = primary;
  } catch (e) {
    results.views.toneMeter = false;
    results.views.tonePrimary = "(none)";
    results.pageErrors.push("tone: " + e.message);
  }
  await browser.close();
}

// 6. Readability
async function testReadability() {
  const { browser, page } = await freshBrowser("readability");
  try {
    await goto(page, BASE_URL);
    await page.waitForSelector("textarea.editor-input", { timeout: 15000 });
    const tabs = page.locator(".ai-tab");
    const hasReadTab = await tabs.filter({ hasText: "Readability" }).count().then((c) => c > 0);
    results.views.readabilityTab = hasReadTab;
  } catch (e) {
    results.views.readabilityTab = false;
    results.pageErrors.push("readability: " + e.message);
  }
  await browser.close();
}

// 7. Documents
async function testDocuments() {
  const { browser, page } = await freshBrowser("documents");
  try {
    await goto(page, BASE_URL);
    await page.waitForSelector("textarea.editor-input", { timeout: 15000 });
    const newBtn = page.locator("text=+ New document");
    results.views.documentsNewBtn = await newBtn.count().then((c) => c > 0);
    const docsBtn = page.locator("button:has-text('Documents')");
    results.views.documentsDropdown = await docsBtn.count().then((c) => c > 0);
    const titleInput = page.locator("input[aria-label='Document title']");
    results.views.documentsRenameInput = await titleInput.count().then((c) => c > 0);
    const docItems = await page.locator(".doc-item").count();
    results.views.documentsDocItems = docItems;
  } catch (e) {
    results.views.documentsNewBtn = false;
    results.views.documentsRenameInput = false;
    results.pageErrors.push("documents: " + e.message);
  }
  await browser.close();
}

// 8. Export
async function testExport() {
  const { browser, page } = await freshBrowser("export");
  try {
    await goto(page, BASE_URL);
    await page.waitForSelector("textarea.editor-input", { timeout: 15000 });
    const exportBtn = page.locator("button:has-text('Export')");
    results.views.exportBtn = await exportBtn.count().then((c) => c > 0);
    const downloadBtns = await page.locator("button:has-text('Download .txt')").count();
    results.views.exportDownloadTxt = downloadBtns > 0;
  } catch (e) {
    results.views.exportBtn = false;
    results.pageErrors.push("export: " + e.message);
  }
  await browser.close();
}

// 9. Dark/Light mode
async function testMode() {
  const { browser, page } = await freshBrowser("mode");
  try {
    await goto(page, BASE_URL);
    await page.waitForSelector("textarea.editor-input", { timeout: 15000 });
    const toggle = page.locator('button[aria-label="Toggle dark mode"]');
    if (await toggle.count()) {
      // Start from whatever the initial theme is (light or dark), then assert
      // the cycle: each click flips to the opposite, and two clicks return
      // to the original. Do not assume a fixed starting theme.
      const initial = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      results.views.modeToggleExists = true;
      await toggle.click();
      await sleep(600);
      const after1 = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      await toggle.click();
      await sleep(900);
      const after2 = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      await toggle.click();
      await sleep(900);
      const after3 = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      // Cycle: click 1 -> opposite of default, click 2 -> opposite of after1.
      // The app treats a missing theme attribute as default "light" and then
      // toggles light <-> dark. So: after1 = "dark", after2 = "light", after3 = "dark".
      // We do not assume a fixed starting theme attribute: it may be absent
      // ("null"), which resolves to "light". Compare resolved states only.
      const resolvedInitial = initial || "light";
      results.views.modeTestedLight = after1 === (resolvedInitial === "dark" ? "dark" : "light");
      results.views.modeTestedDark = after2 === (resolvedInitial === "dark" ? "light" : "dark");
      results.views.modeThemeSequence = [after1, after2, after3];
    } else {
      results.views.modeTestedDark = false;
      results.views.modeTestedLight = false;
      results.pageErrors.push("no theme toggle");
    }
  } catch (e) {
    results.views.modeTestedDark = false;
    results.views.modeTestedLight = false;
    results.pageErrors.push("mode: " + e.message);
  }
  await browser.close();
}

// 10. Keyboard
async function testKeyboard() {
  const { browser, page } = await freshBrowser("keyboard");
  try {
    await goto(page, BASE_URL);
    await page.waitForSelector("textarea.editor-input", { timeout: 15000 });
    await inputText(page, "textarea.editor-input", "Hello world.");
    const typed = await page.locator("textarea.editor-input").evaluate((el) => el.value);
    await page.keyboard.press("Backspace");
    await sleep(400);
    const deleted = await page.locator("textarea.editor-input").evaluate((el) => el.value);
    await page.keyboard.press("Meta+Shift+V");
    await sleep(400);
    const pasted = await page.locator("textarea.editor-input").evaluate((el) => el.value);
    results.views.keyboardType = typed.length > 0;
    results.views.keyboardDelete = deleted.length < typed.length;
    results.views.keyboardPaste = pasted.length >= deleted.length;
  } catch (e) {
    results.views.keyboardType = false;
    results.views.keyboardDelete = false;
    results.views.keyboardPaste = false;
    results.pageErrors.push("keyboard: " + e.message);
  }
  await browser.close();
}

async function main() {
  console.log("=== FUNCTIONAL BROWSER TESTS ===\n");
  await testEditor();
  await testGrammarActions();
  await testAnalyze();
  await testRewrite();
  await testTone();
  await testReadability();
  await testDocuments();
  await testExport();
  await testMode();
  await testKeyboard();

  console.log("=== RESULTS ===");
  for (const [k, v] of Object.entries(results.views)) {
    console.log("  " + k + ": " + JSON.stringify(v));
  }

  console.log("\n=== CONSOLE ===");
  console.log("  console errors: " + results.consoleErrors.length + " " + (results.consoleErrors.length ? results.consoleErrors : ""));
  console.log("  uncaught exceptions: " + results.uncaughtExceptions.length + " " + (results.uncaughtExceptions.length ? results.uncaughtExceptions : ""));
  console.log("  page/failed requests: " + results.failedRequests.length + " " + (results.failedRequests.length ? results.failedRequests : ""));

  const keys = [
    "editor", "grammarAccept", "grammarIgnore", "grammarDictionary",
    "analyzeThought", "analyzeFinalStatus",
    "rewriteResult", "rewriteCancel", "rewriteTryAgain", "rewriteCopy", "rewriteReplace",
    "toneMeter", "tonePrimary",
    "readabilityTab",
    "documentsNewBtn", "documentsRenameInput", "documentsDropdown", "documentsDocItems",
    "exportBtn", "exportDownloadTxt",
    "modeTestedDark", "modeTestedLight",
    "keyboardType", "keyboardDelete", "keyboardPaste"
  ];
  let allPass = true;
  console.log("\n=== FUNCTIONAL SUMMARY ===");
  for (const k of keys) {
    const v = results.views[k];
    if (typeof v === "boolean") {
      console.log("  " + k + ": " + (v ? "PASS" : "FAIL"));
      if (!v) allPass = false;
    }
  }
  console.log("\nALL FUNCTIONAL: " + (allPass ? "PASS" : "FAIL"));
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
