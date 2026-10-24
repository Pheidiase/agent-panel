// Compile client modules in memory, including their relative TypeScript imports.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "@typescript/typescript6";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../../src");
export function clientModules(dependencies = {}, development = false, transform = source => source) {
  const cache = new Map();
  function load(file) {
    const filename = path.resolve(root, file);
    if (cache.has(filename)) return cache.get(filename);
    const source = fs.readFileSync(filename, "utf8").replaceAll("import.meta.env?.DEV", String(development));
    const js = ts.transpileModule(transform(source, filename), { fileName: filename, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const exports = {};
    cache.set(filename, exports);
    // Vite'ın import.meta.glob'u: yalnız "./klasör/*-ek.ts" biçimli kalıplar; eager ise modül, değilse yükleyici döner.
    const glob = (pattern, options = {}) => {
      const dir = path.resolve(path.dirname(filename), path.dirname(pattern)), name = path.basename(pattern);
      const match = new RegExp("^" + name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*") + "$");
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => match.test(file)).sort() : [];
      return Object.fromEntries(files.map(file => [`${path.posix.dirname(pattern)}/${file}`,
        options.eager ? load(path.join(dir, file)) : () => Promise.resolve(load(path.join(dir, file)))]));
    };
    new Function("exports", "require", "__glob", js.replaceAll("import.meta.glob(", "__glob("))(exports, name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name.endsWith(".css")) return {};
      if (!name.startsWith(".")) return require(name);
      const base = path.resolve(path.dirname(filename), name);
      const target = [base, base + ".ts", base + ".tsx"].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!target) throw new Error(`Missing client module: ${name}`);
      return load(target);
    }, glob);
    return exports;
  }
  return load;
}
