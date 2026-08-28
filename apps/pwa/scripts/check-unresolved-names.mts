import path from "node:path";
import process from "node:process";
import ts from "typescript";

const projectDirectory = process.cwd();
const configPath = ts.findConfigFile(projectDirectory, ts.sys.fileExists, "tsconfig.json");
if (!configPath) throw new Error("apps/pwa/tsconfig.json was not found.");

const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) {
  throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
}

const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  path.dirname(configPath),
);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const applicationRoot = `${path.resolve(projectDirectory, "app")}${path.sep}`;
const unresolved = ts.getPreEmitDiagnostics(program).filter((diagnostic) =>
  (diagnostic.code === 2304 || diagnostic.code === 2552) &&
  diagnostic.file?.fileName.startsWith(applicationRoot)
);

if (unresolved.length > 0) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(unresolved, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => projectDirectory,
    getNewLine: () => "\n",
  }));
  process.exitCode = 1;
}
