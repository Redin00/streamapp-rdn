/**
 * Dev orchestrator: starts the Python streaming API service, waits for it to
 * be healthy, then starts the Vite dev server connected to it.
 *
 * Usage:
 *   npm run dev
 *
 * Environment:
 *   Loads .env from the repository root when present. Shell variables win.
 *   SC_PORT          - local port for the Python service (default: 8000)
 *   SC_DOMAIN        - upstream catalogue domain (default lives in python-service/main.py)
 *   SC_VIXSRC_DOMAIN - playback embed host (default lives in python-service/main.py)
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PY_DIR = path.join(ROOT, "python-service");
const VENV_DIR = path.join(PY_DIR, ".venv");

function loadRootEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const value = rawValue.trim().replace(/^("|')(.*)\1$/, "$2");
    process.env[key] = value;
  }
}

loadRootEnv();

const SC_PORT = parseInt(process.env["SC_PORT"] || "8000", 10);
const STREAMING_API_URL = `http://localhost:${SC_PORT}`;

const COLOR_PY = "\x1b[36m"; // cyan
const COLOR_VITE = "\x1b[35m"; // magenta
const COLOR_ERR = "\x1b[31m"; // red
const COLOR_INFO = "\x1b[34m"; // blue
const COLOR_RESET = "\x1b[0m";

function log(source, color, msg) {
  const prefix = source ? `${color}[${source}]${COLOR_RESET} ` : "";

  console.log(`${prefix}${msg}`);
}

function findSystemPython() {
  const candidates =
    process.platform === "win32" ? ["python.exe", "python"] : ["python3", "python"];
  for (const cmd of candidates) {
    const result = spawnSync(cmd, ["--version"], { shell: true, stdio: "pipe" });
    if (result.status === 0) return cmd;
  }
  throw new Error("Python 3 is required but was not found. Please install Python 3 and try again.");
}

function getVenvPython() {
  return process.platform === "win32"
    ? path.join(VENV_DIR, "Scripts", "python.exe")
    : path.join(VENV_DIR, "bin", "python");
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/health`, () => resolve(true));
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function ensureVenv() {
  const python = findSystemPython();
  if (fs.existsSync(getVenvPython())) {
    log("python", COLOR_PY, "using existing .venv");
    return getVenvPython();
  }
  log("python", COLOR_PY, "creating .venv...");
  const create = spawnSync(python, ["-m", "venv", ".venv"], {
    cwd: PY_DIR,
    stdio: "inherit",
  });
  if (create.status !== 0) {
    throw new Error("Failed to create Python virtual environment.");
  }
  return getVenvPython();
}

function installDeps(python) {
  log("python", COLOR_PY, "installing requirements...");
  const install = spawnSync(python, ["-m", "pip", "install", "-r", "requirements.txt"], {
    cwd: PY_DIR,
    stdio: "inherit",
  });
  if (install.status !== 0) {
    throw new Error("Failed to install Python dependencies.");
  }
}

function waitForHealth(url, timeoutMs = 30000, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      http
        .get(url, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            retry();
          }
        })
        .on("error", retry);

      function retry() {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Python service did not become healthy at ${url}`));
          return;
        }
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}

function createService(python) {
  log("python", COLOR_PY, `starting uvicorn on port ${SC_PORT}...`);
  return spawn(
    python,
    ["-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", String(SC_PORT)],
    {
      cwd: PY_DIR,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function createVite() {
  log("vite", COLOR_VITE, "starting Vite...");
  return spawn("npx", ["vite", "dev"], {
    cwd: ROOT,
    env: { ...process.env, STREAMING_API_URL },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function pipeLines(stream, label, color) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line) log(label, color, line);
    }
  });
  stream.on("end", () => {
    if (buffer) log(label, color, buffer);
  });
}

function killProcess(proc, name) {
  if (!proc || proc.killed) return;
  return new Promise((resolve) => {
    const onExit = () => {
      proc.off("exit", onExit);
      resolve();
    };
    proc.on("exit", onExit);
    proc.kill("SIGTERM");

    const fallback = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 5000);

    proc.on("exit", () => clearTimeout(fallback));
  });
}

async function main() {
  log(
    "dev",
    COLOR_INFO,
    `SC_PORT=${SC_PORT}, SC_DOMAIN=${process.env["SC_DOMAIN"] || "(service default)"}, SC_VIXSRC_DOMAIN=${process.env["SC_VIXSRC_DOMAIN"] || "(service default)"}`,
  );

  const busy = await isPortInUse(SC_PORT);
  if (busy) {
    throw new Error(
      `Port ${SC_PORT} is already in use. Set SC_PORT to a different port and try again.`,
    );
  }

  const python = ensureVenv();
  installDeps(python);

  const service = createService(python);
  pipeLines(service.stdout, "python", COLOR_PY);
  pipeLines(service.stderr, "python", COLOR_PY);

  service.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      log("python", COLOR_ERR, `exited with code ${code}`);
    }
  });

  try {
    await waitForHealth(`${STREAMING_API_URL}/health`);
    log("python", COLOR_PY, `healthy at ${STREAMING_API_URL}`);
  } catch (err) {
    await killProcess(service, "python");
    throw err;
  }

  const vite = createVite();
  pipeLines(vite.stdout, "vite", COLOR_VITE);
  pipeLines(vite.stderr, "vite", COLOR_VITE);

  vite.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      log("vite", COLOR_ERR, `exited with code ${code}`);
    }
  });

  const shutdown = async (signal) => {
    log("dev", COLOR_INFO, `received ${signal}, shutting down...`);
    await Promise.all([killProcess(service, "python"), killProcess(vite, "vite")]);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // If either child exits on its own, tear down the other.
  service.on("exit", () => killProcess(vite, "vite").then(() => process.exit(1)));
  vite.on("exit", () => killProcess(service, "python").then(() => process.exit(1)));
}

main().catch((err) => {
  log("dev", COLOR_ERR, err.message);
  process.exit(1);
});
