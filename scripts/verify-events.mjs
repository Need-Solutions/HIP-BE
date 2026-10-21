import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { generate, generateSecret } from "otplib";
import { v2 as cloudinary } from "cloudinary";
import QRCode from "qrcode";
import { cases, variables as defaults } from "./postman/events.mjs";

// Real compiled HTTP server and MongoDB transactions; never use the application database.
// Only Cloudinary's three configured upload settings are read from .env. No secrets are printed.
const root = fileURLToPath(new URL("../", import.meta.url));
const children = [];
let temporary, env, uploadedPublicId;
const staffIds = [];
const mockCloudinary = process.argv.includes("--mock-cloudinary");
async function freePort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function child(args, settings) {
  const process = spawn(args[0], args.slice(1), {
    cwd: root,
    env: settings,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain output without logging connection/transport details or authentication material.
  process.stdout.on("data", () => undefined);
  process.stderr.on("data", () => undefined);
  children.push(process);
  return process;
}
async function ready(port, process) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (process.exitCode !== null)
      throw new Error("The isolated server exited before startup.");
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
  throw new Error("The isolated server did not start.");
}
async function stop(process) {
  if (!process.pid || process.exitCode !== null || process.signalCode !== null)
    return;
  const exited = once(process, "exit");
  process.kill("SIGTERM");
  await exited;
}
function encrypt(secret, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from("hip:staff:authenticator:v1"));
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}
async function main() {
  temporary = await mkdtemp(path.join(tmpdir(), "hip-events-"));
  const mongoPort = await freePort(),
    apiPort = await freePort();
  const binaryIndex = process.argv.indexOf("--mongod");
  const mongo = child(
    [
      binaryIndex < 0 ? "mongod" : process.argv[binaryIndex + 1],
      "--dbpath",
      temporary,
      "--port",
      String(mongoPort),
      "--bind_ip",
      "127.0.0.1",
      "--replSet",
      "hip-events-rs",
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
      _id: "hip-events-rs",
      members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }],
    },
  });
  await mongoose.disconnect();
  const privateEnv = await readFile(path.join(root, ".env")).then(buffer => dotenv.parse(buffer)).catch(() => ({}));
  const cloud = Object.fromEntries(
    [
      "CLOUDINARY_CLOUD_NAME",
      "CLOUDINARY_API_KEY",
      "CLOUDINARY_API_SECRET",
    ].map((key) => [key, process.env[key] || privateEnv[key] || ""]),
  );
  if (mockCloudinary) Object.assign(cloud, { CLOUDINARY_CLOUD_NAME: "test-cloud", CLOUDINARY_API_KEY: "123456", CLOUDINARY_API_SECRET: randomBytes(32).toString("hex") });
  if (!Object.values(cloud).every(Boolean))
    throw new Error(
      "Set the three Cloudinary settings privately to verify a real cover upload.",
    );
  env = {
    ...process.env,
    ...cloud,
    NODE_ENV: "development",
    PORT: String(apiPort),
    MONGODB_URI: `mongodb://127.0.0.1:${mongoPort}/hip_auth_test_${randomBytes(6).toString("hex")}?replicaSet=hip-events-rs`,
    CLIENT_URL: "http://localhost:5173",
    JWT_SECRET: randomBytes(48).toString("hex"),
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SUPER_ADMIN_EMAIL: `events-${randomBytes(6).toString("hex")}@example.com`,
    SUPER_ADMIN_NAME: "Event test manager",
    SUPER_ADMIN_PASSWORD: `${randomBytes(18).toString("base64url")}1!`,
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "1025",
    SMTP_USER: "",
    SMTP_PASS: "",
    MAIL_FROM: "hip@example.com",
  };
  delete env.DEV_FIXED_CODE;
  await mongoose.connect(env.MONGODB_URI);
  if (process.argv.includes("--with-tests")) {
    await mongoose.disconnect();
    const tests = spawn(
      "npm",
      ["test", "--", "--maxWorkers=1", "--minWorkers=1"],
      { cwd: root, env, stdio: "inherit" },
    );
    children.push(tests);
    const [code] = await once(tests, "exit");
    assert.equal(code, 0, "Backend tests must pass before HTTP verification.");
    await mongoose.connect(env.MONGODB_URI);
    // This database was created above on this run's private mongod, never loaded from .env.
    await mongoose.connection.dropDatabase();
  }
  const secret = generateSecret();
  const inserted = await mongoose.connection.collection("admins").insertOne({
    fullName: env.SUPER_ADMIN_NAME,
    email: env.SUPER_ADMIN_EMAIL,
    passwordHash: await bcrypt.hash(env.SUPER_ADMIN_PASSWORD, 12),
    role: "super_admin",
    status: "active",
    twoStepEnabled: true,
    authenticatorSecret: encrypt(secret, env.ENCRYPTION_KEY),
    twoStepEnabledAt: new Date(),
    sessionVersion: 0,
    staffChanges: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  staffIds.push(inserted.insertedId);
  const other = await mongoose.connection.collection("admins").insertOne({
    fullName: "Event test check-in staff",
    email: `checkin-${randomBytes(6).toString("hex")}@example.com`,
    passwordHash: await bcrypt.hash(randomBytes(24).toString("hex"), 12),
    role: "checkin_staff",
    status: "active",
    twoStepEnabled: true,
    sessionVersion: 0,
    staffChanges: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  staffIds.push(other.insertedId);
  await mongoose.disconnect();
  const vars = {
    ...defaults,
    staffEmail: env.SUPER_ADMIN_EMAIL,
    staffName: env.SUPER_ADMIN_NAME,
    staffPassword: env.SUPER_ADMIN_PASSWORD,
    eventTitle: `Gurara ridge ${randomBytes(4).toString("hex")}`,
    eventDay: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    eventSalesDay: new Date().toISOString().slice(0, 10),
    eventNonAdminCookie: `hip_staff_session=${jwt.sign({ version: 0, scope: "full" }, env.JWT_SECRET, { algorithm: "HS256", subject: other.insertedId.toString(), issuer: "hip", audience: "hip-staff", expiresIn: "1h" })}`,
  };
  const generated = JSON.parse(
    await readFile(
      path.join(root, "postman/HIP-users-auth.postman_collection.json"),
      "utf8",
    ),
  );
  const items = new Map(
    generated.item
      .find((folder) => folder.name === "Controller 5 — Events")
      .item.map((item) => [item.name, item]),
  );
  const nodeArgs = [];
  if (mockCloudinary) {
    const mockPath = path.join(temporary, "cloudinary-test.cjs");
    await writeFile(mockPath, `const {v2}=require(${JSON.stringify(path.join(root, "node_modules/cloudinary"))});
const {Writable}=require('node:stream');
v2.uploader.upload_stream=(options, callback)=>new Writable({write(chunk,encoding,done){done();},final(done){callback(null,{secure_url:'https://example.test/event-cover.png'});done();}});
`);
    nodeArgs.push("--require", mockPath);
    console.log("Cloudinary is stubbed only in this isolated test server; real provider verification is separate.");
  }
  const api = child([process.execPath, ...nodeArgs, "dist/index.js"], env);
  await ready(apiPort, api);
  const base = `http://127.0.0.1:${apiPort}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  console.log(
    "Development server started on an isolated database. Checking generated Controller 5 requests.",
  );
  const replace = (value) =>
    typeof value === "string"
      ? value.replace(/\{\{(\w+)\}\}/g, (_, key) => {
          assert.ok(
            vars[key] !== undefined,
            `Missing private test variable ${key}`,
          );
          return vars[key];
        })
      : Array.isArray(value)
        ? value.map(replace)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, val]) => [key, replace(val)]),
            )
          : value;
  for (const scenario of cases) {
    if (scenario.prepareEventTotp)
      vars.staffAuthenticatorCode = await generate({ secret });
    const headers = scenario.cookieVar
      ? { Cookie: vars[scenario.cookieVar] }
      : {};
    let data;
    if (scenario.multipart) {
      data = new FormData();
      const png = await QRCode.toBuffer("HIP event cover verification", {
        width: 64,
      });
      const wrong = scenario.multipart === "coverWrongFile",
        large = scenario.multipart === "coverLargeFile";
      const image = wrong
        ? Buffer.from("Not an image")
        : large
          ? Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)])
          : png;
      data.append(
        "image",
        new Blob([image], { type: wrong ? "text/plain" : "image/png" }),
        wrong ? "cover.txt" : "cover.png",
      );
    } else if (scenario.body) {
      headers["Content-Type"] = "application/json";
      data = JSON.stringify(replace(scenario.body));
    }
    const response = await fetch(`${base}${replace(scenario.path)}`, {
      method: scenario.method,
      headers,
      ...(data ? { body: data } : {}),
    });
    assert.equal(
      response.status,
      scenario.expected.status,
      `${scenario.name}: HTTP status`,
    );
    const body = response.status === 204 ? undefined : await response.json();
    if (scenario.multipart === "coverFile") {
      const match = new URL(body.url).pathname.match(
        /\/image\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/i,
      );
      if (match) uploadedPublicId = match[1];
    }
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
      test: (_name, callback) => callback(),
      environment: {
        get: (key) => vars[key],
        set: (key, value) => {
          vars[key] = value;
        },
      },
      collectionVariables: {
        get: (key) => vars[key],
        set: (key, value) => {
          vars[key] = value;
        },
      },
      variables: { get: (key) => vars[key], replaceIn: replace },
    };
    const item = items.get(scenario.name);
    assert.ok(item);
    for (const script of item.event.filter((item) => item.listen === "test"))
      runInNewContext(
        script.script.exec.join("\n"),
        { pm, JSON },
        { timeout: 1000 },
      );
    console.log(`PASS ${scenario.name}`);
  }
  await mongoose.connect(env.MONGODB_URI);
  const audit = await mongoose.connection
    .collection("auditlogs")
    .find({ "target.id": vars.eventId })
    .toArray();
  assert.deepEqual(
    audit.map((entry) => entry.action),
    [
      "event.created",
      "event.updated",
      "event.published",
      "event.updated",
      "event.sales_closed",
      "event.cancelled",
    ],
  );
  assert.equal(audit.at(-1).reason, "Unsafe weather on the ridge");
  await mongoose.disconnect();
  await stop(api);
  const production = child([process.execPath, ...nodeArgs, "dist/index.js"], {
    ...env,
    NODE_ENV: "production",
  });
  await ready(apiPort, production);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal(
    (await fetch(`${base}/api/events/${vars.eventSlug}`)).status,
    200,
  );
  console.log(
    `PASS ${cases.length} generated Postman cases, transaction audits, ${mockCloudinary ? "stubbed Cloudinary" : "real Cloudinary upload"}, development and production startup.`,
  );
}
try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Event verification failed.",
  );
  process.exitCode = 1;
} finally {
  if (env) {
    try {
      if (mongoose.connection.readyState !== 1)
        await mongoose.connect(env.MONGODB_URI);
      await mongoose.connection
        .collection("admins")
        .updateMany(
          { _id: { $in: staffIds } },
          { $set: { status: "deactivated" }, $inc: { sessionVersion: 1 } },
        );
      assert.equal(
        await mongoose.connection
          .collection("admins")
          .countDocuments({ _id: { $in: staffIds }, status: "active" }),
        0,
      );
      console.log("Temporary test staff deactivated.");
    } catch {
      console.error("Could not verify temporary staff cleanup.");
      process.exitCode = 1;
    }
  }
  await mongoose.disconnect();
  if (uploadedPublicId && env) {
    try {
      const result = await cloudinary.uploader.destroy(uploadedPublicId, {
        cloud_name: env.CLOUDINARY_CLOUD_NAME,
        api_key: env.CLOUDINARY_API_KEY,
        api_secret: env.CLOUDINARY_API_SECRET,
        resource_type: "image",
        invalidate: true,
      });
      assert.ok(["ok", "not found"].includes(result.result));
      console.log("Temporary Cloudinary cover removed.");
    } catch {
      console.error("Could not remove the temporary Cloudinary cover.");
      process.exitCode = 1;
    }
  }
  for (const process of children.reverse()) await stop(process);
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
