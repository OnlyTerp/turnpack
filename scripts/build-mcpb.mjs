#!/usr/bin/env node
// Builds turnpack.mcpb, the one-click bundle for Claude Desktop.
//
// An .mcpb file is a zip archive holding a manifest.json and the server's files. Opening one in
// Claude Desktop shows an install dialog, asks for the project folder with a folder picker, and
// runs the server on the Node that ships inside the app. Nothing else needs to be installed.
//
// Turnpack has no dependencies, so the bundle is the build output plus a manifest generated
// from package.json. The zip is written here with Node's own zlib rather than a zip library,
// for the same reason: nothing to install, nothing to audit.
//
//   npm run bundle            -> release/turnpack.mcpb
//   node scripts/build-mcpb.mjs --out <dir>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(data);
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// One fixed timestamp (1 January 2026), so the same source always produces the same bytes.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** Writes a zip archive of `entries` ({ name, data }), deflated, with UTF-8 names. */
export function zipArchive(entries) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, nameBytes);

    offset += local.length + nameBytes.length + packed.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** The manifest, generated from package.json and the server's own tool list so neither can drift. */
export async function buildManifest() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  const { TOOLS } = await import(pathToFileURL(path.join(REPO, "dist", "index.js")).href);
  return {
    manifest_version: "0.3",
    name: pkg.name,
    display_name: "Turnpack",
    version: pkg.version,
    description: "Read and search a project in one call, and make multi-file edits that are tested before they stay.",
    long_description:
      "Turnpack gives Claude three tools for working in a folder of code. `pack` gathers a search, several files and git status in one call. `ship` applies edits across files and runs your test command: if the tests fail, every file is restored exactly as it was. `batch` answers questions about many files with one short read-only script.\n\nIt runs entirely on this computer: no account, no API key, no network calls. It can only touch the project folder you choose here, and it redacts `.env` files and keys.",
    author: { name: "OnlyTerp", url: "https://github.com/OnlyTerp" },
    repository: { type: "git", url: "https://github.com/OnlyTerp/turnpack.git" },
    homepage: "https://github.com/OnlyTerp/turnpack",
    documentation: "https://github.com/OnlyTerp/turnpack#readme",
    support: "https://github.com/OnlyTerp/turnpack/issues",
    license: pkg.license,
    keywords: ["code", "files", "search", "edit", "tests", "rollback"],
    server: {
      type: "node",
      entry_point: "dist/cli.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/dist/cli.js", "serve"],
        env: { TURNPACK_ROOT: "${user_config.project_folder}" },
      },
    },
    tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description.split(". ")[0].replace(/\.$/, "") + "." })),
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: pkg.engines.node },
    },
    user_config: {
      project_folder: {
        type: "directory",
        title: "Project folder",
        description:
          "The folder Turnpack may read, search and edit. Nothing outside it can be touched. Change it here whenever you switch projects.",
        required: true,
      },
    },
  };
}

export async function buildBundle(outDir) {
  const distDir = path.join(REPO, "dist");
  if (!fs.existsSync(path.join(distDir, "cli.js"))) {
    throw new Error("dist/cli.js is missing: run npm run build first");
  }
  const manifest = await buildManifest();
  const entries = [{ name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) }];
  for (const rel of ["package.json", "LICENSE", "NOTICE", "README.md", "SECURITY.md"]) {
    entries.push({ name: rel, data: fs.readFileSync(path.join(REPO, rel)) });
  }
  // Type declarations and source maps are for people importing the library, not for running it.
  for (const rel of listFiles(distDir).filter((file) => file.endsWith(".js"))) {
    entries.push({ name: `dist/${rel}`, data: fs.readFileSync(path.join(distDir, rel)) });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "turnpack.mcpb");
  fs.writeFileSync(outFile, zipArchive(entries));
  return { outFile, files: entries.length, bytes: fs.statSync(outFile).size, version: manifest.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf("--out");
  const outDir = path.resolve(at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : path.join(REPO, "release"));
  const built = await buildBundle(outDir);
  console.log(`${built.outFile}  (turnpack ${built.version}, ${built.files} files, ${built.bytes} bytes)`);
}
