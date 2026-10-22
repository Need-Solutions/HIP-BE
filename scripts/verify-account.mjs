import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

// No .env access. Own MongoDB replica set, generated app configuration, mocked external providers.
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "hip-account-check-"));
const children = [];
let connection;
async function freePort() {
  const socket = net.createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
function start(args, env, cwd = root, stdio = "ignore") {
  const child = spawn(args[0], args.slice(1), { cwd, env, stdio });
  child.on("error", () => undefined);
  children.push(child);
  return child;
}
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}
try {
  const port = await freePort();
  const binaryFlag = process.argv.indexOf("--mongod");
  const mongod =
    binaryFlag >= 0
      ? process.argv[binaryFlag + 1]
      : process.env.MONGOMS_SYSTEM_BINARY || "mongod";
  const database = path.join(temporary, "database");
  await mkdir(database);
  const baseEnv = { PATH: process.env.PATH };
  const mongo = start(
    [
      mongod,
      "--dbpath",
      database,
      "--port",
      String(port),
      "--bind_ip",
      "127.0.0.1",
      "--replSet",
      "hip-account-rs",
      "--logpath",
      path.join(temporary, "mongodb.log"),
      "--quiet",
    ],
    baseEnv,
  );
  connection = new mongoose.mongo.MongoClient(
    `mongodb://127.0.0.1:${port}/?directConnection=true`,
    { serverSelectionTimeoutMS: 1000 },
  );
  let connected = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (mongo.exitCode !== null) break;
    try {
      await connection.connect();
      connected = true;
      break;
    } catch {
      await delay(250);
    }
  }
  if (!connected)
    throw new Error(
      "Temporary MongoDB could not start; provide --mongod /absolute/path/to/mongod.",
    );
  await connection
    .db("admin")
    .command({
      replSetInitiate: {
        _id: "hip-account-rs",
        members: [{ _id: 0, host: `127.0.0.1:${port}` }],
      },
    });
  let primary = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (
      (await connection.db("admin").command({ hello: 1 })).isWritablePrimary
    ) {
      primary = true;
      break;
    }
    await delay(250);
  }
  if (!primary)
    throw new Error("Temporary replica set did not become writable.");
  const dbName = `hip_auth_test_${randomBytes(6).toString("hex")}`;
  const uri = `mongodb://127.0.0.1:${port}/${dbName}?replicaSet=hip-account-rs`;
  const tests = start(
    [
      process.execPath,
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--maxWorkers=1",
      "--minWorkers=1",
    ],
    { ...baseEnv, MONGODB_URI: uri },
    root,
    "inherit",
  );
  const [code] = await once(tests, "exit");
  if (code !== 0) throw new Error("Backend tests failed.");
  // All disposable users/staff/records are removed before testing startup with a new encryption key.
  await connection.db(dbName).dropDatabase();
  const serverPort = await freePort();
  const appDir = path.join(temporary, "app");
  await mkdir(appDir);
  const server = start(
    [process.execPath, path.join(root, "dist/index.js")],
    {
      ...baseEnv,
      NODE_ENV: "test",
      PORT: String(serverPort),
      MONGODB_URI: uri,
      CLIENT_URL: "http://localhost:5173",
      JWT_SECRET: randomBytes(48).toString("hex"),
      ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1025",
      SMTP_USER: "",
      SMTP_PASS: "",
      MAIL_FROM: "hip@example.test",
      SUPER_ADMIN_EMAIL: "",
      SUPER_ADMIN_NAME: "",
      SUPER_ADMIN_PASSWORD: "",
    },
    appDir,
  );
  let healthy = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) break;
    healthy = await fetch(`http://127.0.0.1:${serverPort}/api/health`)
      .then((r) => r.status === 200)
      .catch(() => false);
    if (healthy) break;
    await delay(250);
  }
  if (!healthy) throw new Error("Built server startup failed.");
  console.log(
    "PASS: built server starts and health returns 200, without loading the project .env.",
  );
  await stop(server);
  await connection.db(dbName).dropDatabase();
} catch (error) {
  // Only static orchestration errors, never database/provider messages or configuration values.
  console.error(
    error instanceof Error &&
      [
        "Backend tests failed.",
        "Built server startup failed.",
        "Temporary replica set did not become writable.",
        "Temporary MongoDB could not start; provide --mongod /absolute/path/to/mongod.",
      ].includes(error.message)
      ? error.message
      : "Isolated account verification failed (configuration omitted).",
  );
  process.exitCode = 1;
} finally {
  await connection?.close().catch(() => undefined);
  for (const child of children.reverse()) await stop(child);
  await rm(temporary, { recursive: true, force: true });
}
