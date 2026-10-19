import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { cases } from "./postman/auth.mjs";
import { cases as profileCases } from "./postman/profile.mjs";
import { cases as staffCases } from "./postman/admin-auth.mjs";
import { generate } from "otplib";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { runInNewContext } from "node:vm";

// All data, credentials, mail and processes belong to this temporary test run.
const root = fileURLToPath(new URL("../", import.meta.url));
const staffOnly = process.argv.includes("--staff-only");
const option = process.argv.indexOf("--mongod");
const mongodBinary = option >= 0 ? process.argv[option + 1] : "mongod";
const children = [];
const messages = [];
let smtp;
let temporary;

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function child(command, args, env, inherit = false) {
  const process = spawn(command, args, {
    cwd: root,
    env,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  process.on("error", () => undefined);
  children.push(process);
  return process;
}
async function run(command, args, env) {
  const process = child(command, args, env, true);
  const [code] = await once(process, "exit");
  assert.equal(code, 0, `${args.join(" ")} failed`);
}
async function waitForPort(port, process) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (process.exitCode !== null || !process.pid)
      throw new Error("A local test process exited before starting.");
    const connected = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await delay(100);
  }
  throw new Error("A local test process did not start in time.");
}
async function stop(process) {
  if (!process.pid || process.exitCode !== null || process.signalCode !== null)
    return;
  const exited = once(process, "exit");
  process.kill("SIGTERM");
  await exited;
}
async function startSmtp() {
  smtp = net.createServer((socket) => {
    socket.write("220 localhost HIP test SMTP\r\n");
    let buffered = "";
    let inData = false;
    let data = [];
    socket.on("data", (chunk) => {
      buffered += chunk.toString();
      let end;
      while ((end = buffered.indexOf("\r\n")) !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
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
                String.fromCharCode(Number.parseInt(hex, 16)),
              ),
          );
          data = [];
          inData = false;
          socket.write("250 Accepted\r\n");
        } else if (/^(EHLO|HELO)\b/i.test(line))
          socket.write("250 localhost\r\n");
        else if (/^DATA$/i.test(line)) {
          inData = true;
          socket.write("354 End with a dot\r\n");
        } else if (/^QUIT$/i.test(line)) socket.end("221 Bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
    socket.on("error", () => undefined);
  });
  smtp.listen(0, "127.0.0.1");
  await once(smtp, "listening");
  return smtp.address().port;
}

async function main() {
  temporary = await mkdtemp(path.join(tmpdir(), "hip-auth-"));
  const mongoPort = await freePort();
  const mongo = child(
    mongodBinary,
    [
      "--dbpath",
      temporary,
      "--port",
      String(mongoPort),
      "--bind_ip",
      "127.0.0.1",
      "--quiet",
      "--logpath",
      path.join(temporary, "mongo.log"),
    ],
    process.env,
  );
  await waitForPort(mongoPort, mongo);
  const smtpPort = await startSmtp();
  const apiPort = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(apiPort),
    MONGODB_URI: `mongodb://127.0.0.1:${mongoPort}/hip_auth_test_${randomBytes(6).toString("hex")}`,
    CLIENT_URL: "http://localhost:5173",
    JWT_SECRET: randomBytes(48).toString("hex"),
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SUPER_ADMIN_EMAIL: `super-${randomBytes(6).toString("hex")}@example.com`,
    SUPER_ADMIN_NAME: "HIP Test Super Admin",
    SUPER_ADMIN_PASSWORD: `${randomBytes(18).toString("base64url")}1!`,
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtpPort),
    SMTP_USER: "",
    SMTP_PASS: "",
    MAIL_FROM: "hip@example.com",
    DEV_FIXED_CODE: "123456",
  };
  console.log("Using temporary MongoDB and SMTP for verification.");
  if (!process.argv.includes("--skip-tests"))
    await run(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        ...(staffOnly ? ["src/__tests__/admin-auth.test.ts"] : []),
        "--maxWorkers=1",
        "--minWorkers=1",
      ],
      env,
    );
  if (process.argv.includes("--tests-only")) return;
  let api = child(process.execPath, ["dist/index.js"], env);
  await waitForPort(apiPort, api);
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  assert.equal(
    (await fetch(`${baseUrl}/api/health`)).status,
    200,
    "The built server must start.",
  );
  console.log(
    `Built server started. Running ${staffOnly ? staffCases.length : cases.length + profileCases.length + staffCases.length} HTTP scenarios and generated Postman assertions.`,
  );
  const unique = randomBytes(6).toString("hex");
  const variables = {
    email: `ada-${unique}@example.com`,
    otherEmail: `unknown-${unique}@example.com`,
    phone: `+234803${randomInt(1000000, 10000000)}`,
    otherPhone: `+234804${randomInt(1000000, 10000000)}`,
    password: `${randomBytes(18).toString("base64url")}1!`,
    wrongPassword: `${randomBytes(18).toString("base64url")}2!`,
    newPassword: `${randomBytes(18).toString("base64url")}3!`,
    code: env.DEV_FIXED_CODE,
    profileEmail: `profile-${unique}@example.com`,
    otherProfileEmail: `other-profile-${unique}@example.com`,
    newProfileEmail: `new-profile-${unique}@example.com`,
    cancelProfileEmail: `cancel-profile-${unique}@example.com`,
    profilePhone: `+234805${randomInt(1000000, 10000000)}`,
    otherProfilePhone: `+234806${randomInt(1000000, 10000000)}`,
    newProfilePhone: `+234807${randomInt(1000000, 10000000)}`,
    profilePassword: `${randomBytes(18).toString("base64url")}4!`,
    staffEmail: env.SUPER_ADMIN_EMAIL,
    staffName: env.SUPER_ADMIN_NAME,
    staffPassword: env.SUPER_ADMIN_PASSWORD,
    deactivatedStaffEmail: `deactivated-${unique}@example.com`,
    deactivatedStaffPassword: `${randomBytes(18).toString("base64url")}5!`,
    unknownStaffEmail: `unknown-staff-${unique}@example.com`,
  };
  await mongoose.connect(env.MONGODB_URI);
  await mongoose.connection.collection("admins").insertOne({
    fullName: "Deactivated Staff",
    email: variables.deactivatedStaffEmail,
    passwordHash: await bcrypt.hash(variables.deactivatedStaffPassword, 12),
    role: "admin",
    status: "deactivated",
    twoStepEnabled: false,
    sessionVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  if (staffOnly)
    await mongoose.connection.collection("users").insertOne({
      fullName: "Profile Hiker",
      email: variables.newProfileEmail,
      phone: variables.profilePhone,
      passwordHash: await bcrypt.hash(variables.profilePassword, 12),
      roles: ["hiker"],
      status: "active",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  await mongoose.disconnect();
  const replace = (value) =>
    JSON.parse(
      JSON.stringify(value).replace(/\{\{(\w+)\}\}/g, (_, key) => {
        assert.ok(variables[key] !== undefined, `Missing test variable ${key}`);
        return variables[key];
      }),
    );
  const generated = JSON.parse(
    await readFile(
      new URL(
        "../postman/HIP-users-auth.postman_collection.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const generatedItems = new Map(
    generated.item
      .flatMap((folder) => folder.item)
      .map((item) => [item.name, item]),
  );
  const cookies = new Map();
  for (const test of staffOnly
    ? staffCases
    : [...cases, ...profileCases, ...staffCases]) {
    if (!staffOnly && test === staffCases[0]) {
      // Each controller folder gets a fresh process-wide IP rate-limit window.
      await stop(api);
      api = child(process.execPath, ["dist/index.js"], env);
      await waitForPort(apiPort, api);
    }
    if (test.prepareTotp)
      variables.staffAuthenticatorCode = await generate({
        secret: variables.staffSetupKey,
      });
    if (test.prepareWrongTotp) {
      const epoch = Math.floor(Date.now() / 1000);
      const codes = await Promise.all(
        [-30, 0, 30].map((offset) =>
          generate({ secret: variables.staffSetupKey, epoch: epoch + offset }),
        ),
      );
      let incorrect = 0;
      while (codes.includes(String(incorrect).padStart(6, "0"))) incorrect++;
      variables.staffWrongCode = String(incorrect).padStart(6, "0");
    }
    if (
      test.waitForResend ||
      test.waitForContactResend ||
      test.waitForStaffResend
    ) {
      console.log("Waiting for the real 60-second resend cooldown.");
      while (
        Date.now() <=
        new Date(
          test.waitForStaffResend
            ? variables.staffResendAt
            : test.waitForContactResend
              ? variables.emailResendAt
              : variables.resendAvailableAt,
        ).getTime() +
          50
      )
        await delay(250);
    }
    const response = await fetch(
      `${baseUrl}${test.path.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key])}`,
      {
        method: test.method,
        headers: {
          "Content-Type": "application/json",
          ...(cookies.size ? { Cookie: [...cookies.values()].join("; ") } : {}),
        },
        ...(test.body ? { body: JSON.stringify(replace(test.body)) } : {}),
      },
    );
    assert.equal(
      response.status,
      test.expected.status,
      `${test.name}: HTTP status`,
    );
    for (const header of response.headers.getSetCookie()) {
      const value = header.split(";")[0];
      const name = value.slice(0, value.indexOf("="));
      if (value === `${name}=`) cookies.delete(name);
      else cookies.set(name, value);
    }
    let body;
    if (response.status === 204) {
      assert.equal(await response.text(), "", `${test.name}: empty body`);
    } else {
      body = await response.json();
    }

    const item = generatedItems.get(test.name);
    assert.ok(item, "Generated Postman request must exist.");
    const eql = (value) => (expected) => assert.deepEqual(value, expected);
    const pm = {
      visualizer: { set: () => undefined },
      response: {
        code: response.status,
        json: () => body,
        text: () => (response.status === 204 ? "" : JSON.stringify(body)),
      },
      expect: (value) => ({
        to: { eql: eql(value), deep: { eql: eql(value) } },
      }),
      test: (_name, assertion) => assertion(),
      collectionVariables: {
        get: (key) => variables[key],
        set: (key, value) => {
          variables[key] = value;
        },
      },
      variables: {
        replaceIn: (value) =>
          value.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key]),
      },
    };
    for (const event of item.event.filter((event) => event.listen === "test"))
      runInNewContext(
        event.script.exec.join("\n"),
        { pm, JSON },
        { timeout: 1000 },
      );
    if (test.captureReset) {
      variables.resetToken = messages
        .at(-1)
        ?.match(/token=([a-f0-9]{64})/)?.[1];
      assert.ok(
        Boolean(variables.resetToken),
        "Reset link must arrive by SMTP.",
      );
    }
    console.log(`PASS ${test.name}`);
  }
  await stop(api);
  const forbidden = child(process.execPath, ["dist/index.js"], {
    ...env,
    NODE_ENV: "production",
  });
  const [exitCode] = await once(forbidden, "exit");
  assert.equal(exitCode, 1, "Production must refuse DEV_FIXED_CODE.");
  const productionEnv = { ...env, NODE_ENV: "production" };
  delete productionEnv.DEV_FIXED_CODE;
  const production = child(process.execPath, ["dist/index.js"], productionEnv);
  await waitForPort(apiPort, production);
  if (!staffOnly) {
    const response = await fetch(`${baseUrl}/api/auth/user-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: variables.email,
        password: variables.newPassword,
        remember: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(
      response.headers.get("set-cookie").includes("Secure"),
      "Production session cookie must be Secure.",
    );
  }
  await mongoose.connect(env.MONGODB_URI);
  await mongoose.connection.collection("loginattempts").deleteMany({});
  await mongoose.disconnect();
  const staffLogin = await fetch(`${baseUrl}/api/auth/staff/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: variables.staffEmail,
      password: variables.staffPassword,
    }),
  });
  assert.equal(
    staffLogin.status,
    200,
    "Seeded staff must survive a server restart.",
  );
  const staffChallenge = await staffLogin.json();
  assert.equal(
    staffChallenge.method,
    "authenticator",
    "Seeding must never overwrite enrollment.",
  );
  const staffVerified = await fetch(`${baseUrl}/api/auth/staff/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challengeId: staffChallenge.challengeId,
      code: await generate({ secret: variables.staffSetupKey }),
    }),
  });
  assert.equal(staffVerified.status, 200);
  assert.ok(
    staffVerified.headers.get("set-cookie").includes("Secure"),
    "Production staff cookie must be Secure.",
  );
  console.log(
    "PASS production startup guard and Secure cookie. All verification passed.",
  );
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
  for (const process of children.reverse()) await stop(process);
  if (smtp) await new Promise((resolve) => smtp.close(resolve));
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
