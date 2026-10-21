import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { cases, variables as defaults } from "./postman/checkout.mjs";

// The application database and developer keys never enter fixtures, files or output.
// Real mode lets ONLY the backend process read PAYSTACK_SECRET_KEY from its existing .env.
const real = process.argv.includes("--real-paystack");
const unsplit = process.argv.includes("--without-settlement");
const manual = process.argv.includes("--manual-payment");
const root = fileURLToPath(new URL("../", import.meta.url));
const children = [],
  messages = [];
let temporary, smtp, uri, api, browser, backendEnv;
function child(args, env) {
  const process = spawn(args[0], args.slice(1), {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.on("data", () => undefined);
  process.stderr.on("data", () => undefined);
  children.push(process);
  return process;
}
async function freePort() {
  const socket = net.createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
async function ready(port, process) {
  for (let i = 0; i < 300; i++) {
    if (process.exitCode !== null)
      throw new Error("An isolated verification process failed to start.");
    if (
      await new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => {
          socket.destroy();
          resolve(false);
        });
      })
    )
      return;
    await delay(100);
  }
  throw new Error("The isolated verification server did not start in time.");
}
async function stop(process) {
  if (!process?.pid || process.exitCode !== null || process.signalCode !== null)
    return;
  const done = once(process, "exit");
  process.kill("SIGTERM");
  await done;
}
async function smtpServer() {
  smtp = net
    .createServer((socket) => {
      socket.write("220 HIP isolated SMTP\r\n");
      let buffer = "",
        inData = false,
        data = [];
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf("\r\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (inData) {
            if (line !== ".") {
              data.push(line.replace(/^\.\./, "."));
              continue;
            }
            messages.push(
              data
                .join("\n")
                .replace(/=\n/g, "")
                .replace(/=([A-F0-9]{2})/gi, (_, hex) =>
                  String.fromCharCode(parseInt(hex, 16)),
                ),
            );
            data = [];
            inData = false;
            socket.write("250 Accepted\r\n");
          } else if (/^(EHLO|HELO)\b/i.test(line))
            socket.write("250 localhost\r\n");
          else if (line === "DATA") {
            inData = true;
            socket.write("354 End with a dot\r\n");
          } else if (line === "QUIT") socket.end("221 Bye\r\n");
          else socket.write("250 OK\r\n");
        }
      });
      socket.on("error", () => undefined);
    })
    .listen(0, "127.0.0.1");
  await once(smtp, "listening");
  return smtp.address().port;
}
async function completeHostedPayment(accessCode) {
  const frontendRequire = createRequire(
    new URL("../../hip-frontend/package.json", import.meta.url),
  );
  const { chromium } = frontendRequire("@playwright/test");
  browser = await chromium.launch({ channel: "chrome", headless: !manual });
  const page = await browser.newPage();
  // No trace, screenshots, videos, network logs, URLs or access codes are printed.
  try {
    await page.goto(
      `https://checkout.paystack.com/${encodeURIComponent(accessCode)}`,
      { waitUntil: "domcontentloaded", timeout: 30000 },
    );
    if (manual) {
      console.log(
        "LIVE_CHECKOUT_PAYMENT_READY: complete the visible Paystack test checkout. The backend will verify it before issuing tickets.",
      );
      return;
    }
    const card = page.getByRole("textbox", { name: /card number/i });
    // Hosted checkout may use an embedded frame; inspect both supported layouts.
    let payment = page;
    if (!(await card.isVisible().catch(() => false))) {
      for (const frame of page.frames())
        if (
          await frame
            .getByRole("textbox", { name: /card number/i })
            .isVisible()
            .catch(() => false)
        ) {
          payment = frame;
          break;
        }
    }
    const number = payment.getByRole("textbox", { name: /card number/i });
    await number.waitFor({ state: "visible", timeout: 30000 });
    await number.fill("4084084084084081");
    await payment
      .getByRole("textbox", { name: /expiry|expiration/i })
      .fill("12/30");
    await payment.getByRole("textbox", { name: /cvv|cvc/i }).fill("408");
    await payment.getByRole("button", { name: /pay/i }).click();
    await delay(2000);
    console.log(
      "Submitted the official Paystack test card through hosted checkout (payment data omitted). Awaiting backend verification.",
    );
  } catch (error) {
    console.error(
      `Hosted checkout browser stage: ${/ERR_CERT/.test(error.message) ? "certificate error" : /ERR_NAME|ERR_CONNECTION|ERR_NETWORK/.test(error.message) ? "network error" : /Timeout/.test(error.name) ? "form timeout" : "form unavailable"}.`,
    );
    for (const frame of page.frames()) {
      const fields = await frame
        .locator("input")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            type: node.getAttribute("type"),
            name: node.getAttribute("name"),
            label: node.getAttribute("aria-label"),
            placeholder: node.getAttribute("placeholder"),
          })),
        )
        .catch(() => []);
      if (fields.length)
        console.error(JSON.stringify({ hostedInputLabelsOnly: fields }));
    }
    throw new Error("Hosted test checkout could not be completed.");
  }
}
async function main() {
  temporary = await mkdtemp(path.join(tmpdir(), "hip-checkout-"));
  const mongoPort = await freePort(),
    apiPort = await freePort(),
    smtpPort = await smtpServer();
  const option = process.argv.indexOf("--mongod");
  const mongo = child(
    [
      option >= 0 ? process.argv[option + 1] : "mongod",
      "--dbpath",
      temporary,
      "--port",
      String(mongoPort),
      "--bind_ip",
      "127.0.0.1",
      "--replSet",
      "hip-checkout-rs",
      "--quiet",
      "--logpath",
      path.join(temporary, "mongo.log"),
    ],
    process.env,
  );
  await ready(mongoPort, mongo);
  await mongoose.connect(
    `mongodb://127.0.0.1:${mongoPort}/?directConnection=true`,
  );
  await mongoose.connection.db.admin().command({
    replSetInitiate: {
      _id: "hip-checkout-rs",
      members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }],
    },
  });
  await mongoose.disconnect();
  uri = `mongodb://127.0.0.1:${mongoPort}/hip_auth_test_${randomBytes(6).toString("hex")}?replicaSet=hip-checkout-rs`;
  const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(apiPort),
    MONGODB_URI: uri,
    CLIENT_URL: "http://localhost:5173",
    JWT_SECRET: randomBytes(48).toString("hex"),
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SUPER_ADMIN_EMAIL: "",
    SUPER_ADMIN_NAME: "",
    SUPER_ADMIN_PASSWORD: "",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtpPort),
    SMTP_USER: "",
    SMTP_PASS: "",
    MAIL_FROM: "hip@example.com",
    DEV_FIXED_CODE: "123456",
    PLATFORM_FEE_PERCENT: "5",
    PLATFORM_FEE_MODE: "added_to_buyer",
    PLATFORM_FEE_ON_REFUND: "refund",
    PAYSTACK_FEE_BEARER: "hiker",
  };
  backendEnv = env;
  const fixturePath = path.join(temporary, "payment-state.json"),
    hook = path.join(temporary, "provider.cjs");
  await writeFile(fixturePath, "[]", { mode: 0o600 });
  // This test preload is external to the server and is never used by npm start/dev.
  if (real) {
    delete env.PAYSTACK_SECRET_KEY;
    await writeFile(
      hook,
      `const {ENV}=require(${JSON.stringify(path.join(root, "dist/config/env.js"))}); if(!ENV.PAYSTACK_SECRET_KEY?.startsWith('sk_test_')) throw new Error('Real verification requires a configured test key.');`,
    );
  } else {
    env.PAYSTACK_SECRET_KEY = `sk_test_${randomBytes(24).toString("hex")}`;
    await writeFile(
      hook,
      `const fs=require('fs');const provider=require(${JSON.stringify(path.join(root, "dist/services/paystack.service.js"))});const {OrderModel}=require(${JSON.stringify(path.join(root, "dist/database/models/orders.schema.js"))});provider.resolveSettlementAccount=async (bankCode,accountNumber)=>({accountName:'Settlement test account',accountNumber});provider.createSettlementSubaccount=async()=>({code:'ACCT_fixture',domain:'test'});provider.initializePayment=async i=>'fixture-'+i.reference;provider.verifyPayment=async reference=>{const order=await OrderModel.findOne({reference});return {reference,amount:order.amountKobo,currency:'NGN',status:JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)},'utf8')).includes(reference)?'success':'pending',id:'fixture-'+reference,paid_at:new Date().toISOString(),domain:'test',fees:order.feeKobo,subaccount:{subaccount_code:order.subaccountCode},fees_split:order.settlementMode==='test_unsplit'?null:{paystack:order.feeKobo,integration:order.amountKobo-order.groupNetKobo-order.feeKobo,subaccount:order.groupNetKobo,params:{bearer:order.settlementBearer,transaction_charge:order.transactionChargeKobo}}};};`,
    );
    console.log(
      "Payment provider STUBBED for generated Postman checks; no real provider call is claimed.",
    );
  }
  await mongoose.connect(uri);
  const vars = {
    ...defaults,
    checkoutEmail: `checkout-${randomBytes(6).toString("hex")}@example.com`,
    checkoutPhone: "+2348030000000",
    checkoutEmergencyPhone: "+2348020000000",
    settlementBankCode: "057",
    settlementAccountNumber: "0000000000",
    settlementAccountName: "Settlement test account",
  };
  if (real && !unsplit) {
    const file = process.env.HIP_SETTLEMENT_ACCOUNT_FILE;
    if (!file)
      throw new Error("Real verification needs HIP_SETTLEMENT_ACCOUNT_FILE.");
    const bank = JSON.parse(await readFile(file, "utf8"));
    vars.settlementBankCode = bank.bankCode;
    vars.settlementAccountNumber = bank.accountNumber;
    vars.settlementAccountName = bank.accountName;
  }
  const testStaffIds = [];
  for (const [role, cookieVar] of [
    ["super_admin", "checkoutManagerCookie"],
    ["admin", "checkoutAdminCookie"],
  ]) {
    const staff = await mongoose.connection.collection("admins").insertOne({
      fullName: "Settlement verification staff",
      email: `${randomBytes(8).toString("hex")}@example.com`,
      passwordHash: "not-a-login-credential",
      role,
      status: "active",
      twoStepEnabled: true,
      sessionVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    testStaffIds.push(staff.insertedId);
    vars[cookieVar] =
      `hip_staff_session=${jwt.sign({ version: 0, scope: "full" }, env.JWT_SECRET, { algorithm: "HS256", subject: String(staff.insertedId), expiresIn: 3600, issuer: "hip", audience: "hip-staff" })}`;
  }
  for (const [prefix, price, capacity] of [
    ["Free", 0, 1],
    ["Paid", 250000, 3],
  ]) {
    const result = await mongoose.connection.collection("events").insertOne({
      title: `Checkout ${prefix} verification hike`,
      slug: `checkout-${prefix.toLowerCase()}`,
      startsAt: new Date(Date.now() + 7 * 86400000),
      registrationDeadline: new Date(Date.now() + 6 * 86400000),
      description: "Isolated checkout fixture.",
      scheduleSet: true,
      durationLabel: "About 3 hrs",
      meetingPoint: "Park gate",
      location: "Abuja",
      difficulty: "moderate",
      capacity,
      ticketsSold: 0,
      seatsHeld: 0,
      fromPriceKobo: price,
      requiredEquipment: [],
      emergencyInfo: "Guide and first aid.",
      requirements: "",
      status: "published",
      __v: 0,
    });
    const type = await mongoose.connection.collection("tickettypes").insertOne({
      eventId: result.insertedId,
      name: price ? "Standard" : "Community",
      description: "",
      priceKobo: price,
      currency: "NGN",
      quantityLimit: capacity,
      quantitySold: 0,
      quantityHeld: 0,
      salesStart: new Date(Date.now() - 86400000),
      salesEnd: new Date(Date.now() + 6 * 86400000),
      status: "active",
      position: 0,
    });
    vars[`checkout${prefix}EventId`] = String(result.insertedId);
    vars[`checkout${prefix}TypeId`] = String(type.insertedId);
  }
  api = child([process.execPath, "--require", hook, "dist/index.js"], env);
  await ready(apiPort, api);
  const base = `http://127.0.0.1:${apiPort}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  const collection = JSON.parse(
    await readFile(
      path.join(root, "postman/HIP-users-auth.postman_collection.json"),
      "utf8",
    ),
  );
  const items = new Map(
    collection.item
      .find((folder) => folder.name === "Controller 6 — Checkout & tickets")
      .item.map((item) => [item.name, item]),
  );
  const replace = (value) =>
    typeof value === "string"
      ? value.replace(/\{\{(\w+)\}\}/g, (_, key) => {
          if (!(key in vars))
            throw new Error("A private fixture variable is missing.");
          return vars[key];
        })
      : Array.isArray(value)
        ? value.map(replace)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, item]) => [key, replace(item)]),
            )
          : value;
  let passed = 0;
  for (const scenario of cases) {
    if (real && unsplit && scenario.name.startsWith("F31")) {
      console.log(
        "SKIP provider subaccount registration: testing without bank settlement.",
      );
      continue;
    }
    if (scenario.name.startsWith("F07")) {
      vars.guestTicketToken = messages
        .at(-1)
        ?.match(/token=([a-f0-9]{64})/)?.[1];
      assert.ok(
        Boolean(vars.guestTicketToken),
        "SMTP catcher must receive the guest link (token omitted).",
      );
    }
    if (scenario.completePaymentBefore) {
      if (real) await completeHostedPayment(vars.paystackAccessCode);
      else
        await writeFile(
          fixturePath,
          JSON.stringify([
            ...JSON.parse(await readFile(fixturePath, "utf8")),
            vars[scenario.confirmationReferenceVar ?? "paidReference"],
          ]),
          {
            mode: 0o600,
          },
        );
    }
    if (scenario.expireHoldBefore)
      await mongoose.connection
        .collection("seatholds")
        .updateOne(
          { _id: new mongoose.Types.ObjectId(vars[scenario.expireHoldBefore]) },
          { $set: { expiresAt: new Date(Date.now() - 1000) } },
        );
    const headers = {
      "Content-Type": "application/json",
      ...(scenario.cookieVar && vars[scenario.cookieVar]
        ? { Cookie: vars[scenario.cookieVar] }
        : {}),
      ...(scenario.badWebhook
        ? { "x-paystack-signature": "0".repeat(128) }
        : {}),
    };
    let response, body;
    for (
      let attempt = 0;
      attempt <
      (real && scenario.completePaymentBefore ? (manual ? 50 : 20) : 1);
      attempt++
    ) {
      response = await fetch(`${base}${replace(scenario.path)}`, {
        method: scenario.method,
        headers,
        ...(scenario.body
          ? { body: JSON.stringify(replace(scenario.body)) }
          : {}),
      });
      body = response.status === 204 ? undefined : await response.json();
      if (
        !(real && scenario.completePaymentBefore && body?.status === "pending")
      )
        break;
      await delay(manual ? 10000 : 1000);
    }
    assert.equal(
      response.status,
      scenario.expected.status,
      `${scenario.name}: HTTP status`,
    );
    const eql = (value) => (expected) => assert.deepEqual(value, expected);
    const pm = {
      response: {
        code: response.status,
        json: () => body,
        text: () => (response.status === 204 ? "" : JSON.stringify(body)),
        headers: {
          all: () =>
            response.headers
              .getSetCookie()
              .map((value) => ({ key: "set-cookie", value })),
        },
      },
      expect: (value) => ({
        to: { eql: eql(value), deep: { eql: eql(value) } },
      }),
      test: (_name, run) => run(),
      environment: {
        get: (key) => vars[key],
        set: (key, value) => {
          vars[key] = value;
        },
      },
      variables: { get: (key) => vars[key], replaceIn: replace },
      visualizer: { set: () => undefined },
    };
    for (const script of items
      .get(scenario.name)
      .event.filter((item) => item.listen === "test"))
      runInNewContext(
        script.script.exec.join("\n"),
        { pm, JSON, Date },
        { timeout: 1000 },
      );
    passed++;
    console.log(`PASS ${scenario.name}`);
  }
  assert.equal(
    await mongoose.connection.collection("tickets").countDocuments(),
    3,
  );
  assert.equal(
    await mongoose.connection
      .collection("auditlogs")
      .countDocuments({ action: "order.paid" }),
    3,
  );
  assert.ok(
    (await mongoose.connection
      .collection("auditlogs")
      .countDocuments({ action: "payment.verification_failed" })) >= 2,
  );
  await mongoose.connection
    .collection("admins")
    .updateMany(
      { _id: { $in: testStaffIds } },
      { $set: { status: "deactivated" }, $inc: { sessionVersion: 1 } },
    );
  assert.equal(
    await mongoose.connection
      .collection("admins")
      .countDocuments({ status: "active" }),
    0,
  );
  const paidOrder = await mongoose.connection
    .collection("orders")
    .findOne({ reference: vars.paidReference });
  const localOrder = await mongoose.connection
    .collection("orders")
    .findOne({ reference: vars.localReference });
  assert.equal(localOrder.settlementMode, "test_unsplit");
  assert.equal(localOrder.actualGroupNetKobo, 0);
  assert.equal(localOrder.splitVerifiedAt, undefined);
  if (unsplit) {
    assert.equal(paidOrder.settlementMode, "test_unsplit");
    assert.equal(paidOrder.actualGroupNetKobo, 0);
    assert.equal(paidOrder.splitVerifiedAt, undefined);
    console.log(
      "PASS verified test payments without bank settlement; no split or payout claimed.",
    );
  } else {
    assert.equal(paidOrder.actualGroupNetKobo, 250000);
    assert.ok(paidOrder.splitVerifiedAt);
    console.log("PASS verified split allocation (no bank payout claimed).");
  }
  await stop(api);
  delete env.DEV_FIXED_CODE;
  env.NODE_ENV = "production";
  api = child([process.execPath, "--require", hook, "dist/index.js"], env);
  await ready(apiPort, api);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  console.log(
    `PASS ${passed} generated Controller 6 cases, audits and development/production startup; ${real ? "real Paystack test payment" : "stubbed payment transport"}. Isolated test staff deactivated before cleanup.`,
  );
}
try {
  await main();
} catch {
  console.error(
    "Checkout verification failed. No provider responses, keys or browser payment data were printed.",
  );
  process.exitCode = 1;
} finally {
  if (real && mongoose.connection.readyState === 1 && backendEnv) {
    const configured = await mongoose.connection
      .collection("checkoutsettings")
      .findOne({ _id: "checkout" });
    if (configured?.subaccountCode && configured.providerDomain === "test") {
      const cleanupCode = `const {ENV}=require('./dist/config/env');(async()=>{if(!ENV.PAYSTACK_SECRET_KEY?.startsWith('sk_test_'))process.exit(1);const r=await fetch('https://api.paystack.co/subaccount/'+encodeURIComponent(process.env.HIP_TEST_SUBACCOUNT),{method:'PUT',headers:{Authorization:'Bearer '+ENV.PAYSTACK_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify({active:false}),signal:AbortSignal.timeout(10000)});const v=await r.json();process.exit(r.ok&&v.status?0:1)})().catch(()=>process.exit(1));`;
      const cleanup = child([process.execPath, "-e", cleanupCode], {
        ...backendEnv,
        HIP_TEST_SUBACCOUNT: configured.subaccountCode,
      });
      const [code] = await once(cleanup, "exit");
      if (code !== 0) {
        console.error(
          "Test subaccount cleanup failed; deactivate this test-only subaccount in the Paystack dashboard.",
        );
        process.exitCode = 1;
      } else console.log("PASS test subaccount deactivated.");
    }
  }
  if (mongoose.connection.readyState === 1)
    await mongoose.connection
      .collection("admins")
      .updateMany(
        { email: /@example\.com$/ },
        { $set: { status: "deactivated" } },
      );
  if (browser) await browser.close();
  for (const process of children.slice().reverse()) await stop(process);
  await mongoose.disconnect();
  if (smtp) {
    smtp.closeAllConnections?.();
    await new Promise((resolve) => smtp.close(resolve));
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
