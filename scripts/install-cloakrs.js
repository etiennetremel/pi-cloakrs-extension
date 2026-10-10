import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const VERSION = "v0.4.0";
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (process.env.PI_CLOAKRS_SKIP_DOWNLOAD === "1") {
  console.log("Skipping cloakrs download (PI_CLOAKRS_SKIP_DOWNLOAD=1)");
  process.exit(0);
}

const isMusl = process.platform === "linux" && !process.report?.getReport().header.glibcVersionRuntime;
const key = `${process.platform}-${process.arch}${isMusl ? "-musl" : ""}`;
const targets = {
  "darwin-arm64": ["aarch64-apple-darwin", "0f0ba154ea426f845b513b25b8b916c5460ac7961ed53582f11bee4aadd24f08"],
  "darwin-x64": ["x86_64-apple-darwin", "1aa36f838b4246104c421423c595083f8d66ab9c4df21f72b0011221ea74eec8"],
  "linux-arm64": ["aarch64-unknown-linux-gnu", "0e12e0a547becabef582bfbb1460a72191b187cd64d6ce8c5972c7422ff83eea"],
  "linux-x64": ["x86_64-unknown-linux-gnu", "922dbdfa301d91e6461653d83b34b82c70c8ef95a607a51ebb2dc0450c65ad48"],
  "linux-x64-musl": ["x86_64-unknown-linux-musl", "da9f9b95e15b3a4577a58962f80132c89618b821ee764c5df032dd7b3cb173da"],
  "win32-x64": ["x86_64-pc-windows-msvc", "11159a5859f3a62b3ce863c5e90f4a31f839617572b835b4cd130aa588577ca0"],
};
if (!targets[key]) throw new Error(`cloakrs has no release binary for ${key}`);
const [target, expected] = targets[key];
const extension = process.platform === "win32" ? "zip" : "tar.gz";
const asset = `cloakrs-${VERSION}-${target}.${extension}`;
const release = `https://github.com/kadir/cloakrs/releases/download/${VERSION}`;
const temporary = await mkdtemp(join(tmpdir(), "pi-cloakrs-"));

try {
  const response = await fetch(`${release}/${asset}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`download failed: ${response.status} ${asset}`);
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_ARCHIVE_BYTES) {
    throw new Error(`download exceeds ${MAX_ARCHIVE_BYTES} bytes: ${asset}`);
  }
  if (!response.body) throw new Error(`download returned no body: ${asset}`);

  const chunks = [];
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_ARCHIVE_BYTES) throw new Error(`download exceeds ${MAX_ARCHIVE_BYTES} bytes: ${asset}`);
    const buffer = Buffer.from(chunk);
    chunks.push(buffer);
    hash.update(buffer);
  }
  const actual = hash.digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}`);
  const archive = Buffer.concat(chunks, bytes);

  const archivePath = join(temporary, asset);
  await writeFile(archivePath, archive);
  const extracted = spawnSync("tar", ["-xf", archivePath, "-C", temporary], { stdio: "inherit" });
  if (extracted.status !== 0) throw new Error(`failed to extract ${asset}`);

  const filename = process.platform === "win32" ? "cloakrs.exe" : "cloakrs";
  const destination = join(root, "bin", filename);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(temporary, filename), destination);
  if (process.platform !== "win32") await chmod(destination, 0o755);
  console.log(`Installed cloakrs ${VERSION} to ${destination}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
