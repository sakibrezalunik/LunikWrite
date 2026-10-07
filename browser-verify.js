const { chromium } = require("playwright");

const URL = "http://localhost:3301";
let browser;
const results = {
  viewport: {},
  consoleErrors: [],
  uncaughtExceptions: [],
  pageErrors: [],
  failedRequests: [],
  requests: [],
};

async function goto(page, url) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
}

async function checkViewport(name, width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  const uncaught = [];
  const pageErrors = [];
  const failed = [];
  const requests = [];

  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors.push(text);
    }
  });
  page.on("pageerror", (err) => uncaught.push(String(err)));
  page.on("requestfailed", (req) => failed.push(`${req.url()} ${req.failure()?.errorText}`));
  page.on("request", (req) => requests.push(req.method() + " " + req.url()));

  try {
    await goto(page, URL);
  } catch (e) {
    pageErrors.push("goto failed: " + e.message);
  }

  results.viewport[name] = {
    width,
    height,
    consoleErrors,
    uncaughtExceptions: uncaught,
    pageErrors,
    failedRequests: failed,
    requests,
    title: await page.title(),
    url: page.url(),
  };

  await page.close();
}

async function run() {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

  console.log("=== VIEWPORTS ===");
  await checkViewport("1920x1080", 1920, 1080);
  await checkViewport("1366x768", 1366, 768);
  await checkViewport("768x1024", 768, 1024);
  await checkViewport("390x844", 390, 844);

  browser.close();

  console.log("\n=== CONSOLE SUMMARY ===");
  let totalConsoleErrors = 0;
  let totalUncaught = 0;
  let totalPageErrors = 0;
  for (const [name, v] of Object.entries(results.viewport)) {
    const ce = v.consoleErrors.length;
    const ue = v.uncaughtExceptions.length;
    const pe = v.pageErrors.length;
    totalConsoleErrors += ce;
    totalUncaught += ue;
    totalPageErrors += pe;
    console.log(`\n[${name}]`);
    console.log(`  title: ${v.title}`);
    console.log(`  url: ${v.url}`);
    console.log(`  console errors: ${ce}`, v.consoleErrors.length ? v.consoleErrors : "");
    console.log(`  uncaught exceptions: ${ue}`, v.uncaughtExceptions.length ? v.uncaughtExceptions : "");
    console.log(`  page errors: ${pe}`, v.pageErrors.length ? v.pageErrors : "");
    console.log(`  failed requests: ${v.failedRequests.length}`, v.failedRequests.length ? v.failedRequests : "");
  }

  console.log("\n=== TOTALS ===");
  console.log(`Actual console errors: ${totalConsoleErrors}`);
  console.log(`Uncaught exceptions: ${totalUncaught}`);
  console.log(`Page errors: ${totalPageErrors}`);

  return {
    totalConsoleErrors,
    totalUncaught,
    totalPageErrors,
  };
}

run().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
