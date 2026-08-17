// Build the dsh-memory plugin.
//
// Host half (src/index.ts → lib/index.js): a plain ESM node module the dsh
// host loader imports. Every @deepseek-ai/* dependency stays external: it is
// resolved from the profile's node_modules at boot, so the plugin always sees
// the SAME service instances the deployment composed.
//
// Testing surface (src/testing.ts → lib/testing.js): the internal API for the
// node:test suite; never imported by the composition.
//
// Browser half (src/client/index.ts → lib/client.js): the dsh client module
// system loads each plugin bundle as a classic script that registers a
// lazy-CJS factory (window.__ModuleLoader__.load). Every runtime dependency
// is external: the seed words are provided by the shell's static module
// table, and other dsh client packages are graph rows materialized by the
// loader's require on demand.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const id = pkg.name;

/** Every host specifier the bundle must resolve at runtime (external). */
const HOST_EXTERNALS = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/schemastery",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-llm/message",
  "@deepseek-ai/dsh-llm/types",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-atomic-write",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-timeout",
];

/** Every client specifier the factory's require() must resolve at runtime. */
const CLIENT_EXTERNALS = [
  // platform seed words (shell static module table)
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  // graph-row packages (resolved through the module loader)
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-runtime/client",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-connection/client",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-locale/client",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings/client",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-ui-settings-plugins/client",
];

function hostOptionsFor(entry, outFile) {
  return {
    entryPoints: [join(root, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    external: HOST_EXTERNALS,
    sourcemap: false,
    write: false,
    logLevel: "silent",
    charset: "utf8",
    outdir: join(root, "lib"),
    outbase: join(root, "src"),
  };
}

const clientOptions = {
  entryPoints: [join(root, "src/client/index.ts")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  external: CLIENT_EXTERNALS,
  jsx: "automatic",
  sourcemap: true,
  write: false,
  logLevel: "silent",
  charset: "utf8",
};

async function writeEntry(result, outFile) {
  mkdirSync(join(root, "lib"), { recursive: true });
  const file = result.outputFiles.find((f) => f.path.endsWith(outFile));
  if (!file) throw new Error(`no output for ${outFile}`);
  writeFileSync(join(root, "lib", outFile), file.text);
  return readFileSync(join(root, "lib", outFile), "utf8").length;
}

/** Wrap esbuild's CJS output in the module-loader registration envelope. */
function wrap(body) {
  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
\t\treturn module.exports;
\t}
});
`;
}

async function writeClient(result) {
  mkdirSync(join(root, "lib"), { recursive: true });
  const mapFile = result.outputFiles.find((f) => f.path.endsWith(".map"));
  const file = result.outputFiles.find((f) => !f.path.endsWith(".map"));
  if (!file) throw new Error("no client output");
  let body = file.text;
  const mapComment = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/.exec(body);
  if (mapComment) {
    writeFileSync(join(root, "lib/client.js.map"), Buffer.from(mapComment[1], "base64").toString("utf8"));
    body = body.slice(0, mapComment.index) + "//# sourceMappingURL=client.js.map";
  }
  writeFileSync(join(root, "lib/client.js"), wrap(body));
  if (mapFile === undefined) writeFileSync(join(root, "lib/client.js.map"), "{}\n");
  return readFileSync(join(root, "lib/client.js"), "utf8").length;
}

async function main() {
  const [hostResult, testResult, clientResult] = await Promise.all([
    build(hostOptionsFor("src/index.ts", "index.js")),
    build(hostOptionsFor("src/testing.ts", "testing.js")),
    build(clientOptions),
  ]);
  const hostBytes = await writeEntry(hostResult, "index.js");
  console.log(`built lib/index.js (${hostBytes} bytes) for ${id}`);
  const testBytes = await writeEntry(testResult, "testing.js");
  console.log(`built lib/testing.js (${testBytes} bytes) for ${id}`);
  const clientBytes = await writeClient(clientResult);
  console.log(`built lib/client.js (${clientBytes} bytes) for ${id}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
