import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const VERSION = "v0.3.0";
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
  "darwin-arm64": ["aarch64-apple-darwin", "a789e3ec9343ddabac63fe581a79b822b8ca8ed46432351684e03eac17a0667f"],
  "darwin-x64": ["x86_64-apple-darwin", "f058828268928b52340e23e4b8794d90d07cdb3c1a8baadd6bc3116fdfe836f3"],
  "linux-arm64": ["aarch64-unknown-linux-gnu", "d03dfb60f6cc07d3780f15de308cef8c4f235cd59dcbaecbfee477611e4fb961"],
  "linux-x64": ["x86_64-unknown-linux-gnu", "ee711247b0153e6bb09294cab6aa36db32fe33547d2c56346c57130cc164d9fd"],
  "linux-x64-musl": ["x86_64-unknown-linux-musl", "6debafdc8aa951248561ef0fe0e4b92ef5b0b821eee15a3b5d9672bd8ac22f9a"],
  "win32-x64": ["x86_64-pc-windows-msvc", "5fcdbba152ee88ea6db08449e88f63b8e2c37758534baf0e7c3bcde4a634d448"],
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
