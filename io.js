const path = require("path");

const CompilerError = require("!errors/CompilerError");
const CONFIG = require("!config/mc");
const File = require("!io/File");
const { evaluateCodeWithEnv } = require("./code-runner");
const crypto = require("crypto");

let env;
let _fakefs = new Set();

function evaluate(line) {
  if (line.indexOf("<%") > -1 && line.indexOf("%>")) {
    const template = line
      .replace(/\${/g, '${"${"}')
      .replace(/\\/g, "\\\\")
      .replace(/<%/g, "${")
      .replace(/%>/g, "}")
      .replace(/\`/g, "\\`");
    try {
      return evaluateCodeWithEnv("return `" + template + "`", env);
    } catch (e) {
      throw new CompilerError(`invalid template literal '${template}'`);
    }
  }
  return line;
}

class MultiFile {
  constructor(file) {
    this.segments = {};
  }
  set(id, func) {
    this.segments[id] = this.segments[id] || [];
    this.segments[id].push(func);
  }
  values() {
    return Object.values(this.segments).flat();
  }
  valuesFor(key) {
    return Object.values(this.segments[key] || {}).flat(Infinity);
  }
  reset(file) {
    delete this.segments[file];
  }
}

class MultiFileTag {
  constructor(path) {
    this.segments = {};
    this.file = new File();
    this.file.setPath(path);
    this.current = false;
  }
  set(id, func) {
    if (!this.current) {
      this.file.confirm();
      this.current = true;
    }
    this.segments[id] = this.segments[id] || [];
    this.segments[id].push(func);
    this.file.setContents(
      JSON.stringify({
        replace: false,
        values: Object.values(this.segments).flat(Infinity),
      })
    );
  }
  reset(file) {
    this.current = false;
    delete this.segments[file];
    if (!this.current) {
      this.file.confirm();
      this.current = true;
    }
    this.file.setContents(
      JSON.stringify({
        replace: false,
        values: Object.values(this.segments).flat(Infinity),
      })
    );
  }
}
const tickFile = new File();
tickFile.setPath(
  path.resolve(
    process.cwd(),
    "./data/minecraft/functions/__generated__/events/tick.mcfunction"
  )
);
const tickFunction = new MultiFile(tickFile);
const loadFile = new File();
loadFile.setPath(
  path.resolve(
    process.cwd(),
    "./data/minecraft/functions/__generated__/events/load.mcfunction"
  )
);
const loadFunction = new MultiFile(loadFile);

class MCFunction extends File {
  constructor(parent, top, intent) {
    super();
    this.parent = parent;
    this.top = top || this;
    this.functions = [];
    this.namespace = "lang_error";
    this._path = Math.random().toString(36).substr(2);
    this.target = this;
    this.intent = intent;
  }
  getHash() {
    const c = crypto.createHash("md5").update(this.functions.join("\n"));
    return c.digest("hex");
  }
  addCommand(command) {
    this.functions.push(evaluate(command));
  }
  setPath(p) {
    this._path = p;
  }
  getReference() {
    return this.namespace + ":" + this._path;
  }
  getContents() {
    return (
      (CONFIG.header ? CONFIG.header + "\n\n" : "") +
      this.functions
        .map((command) =>
          command
            .replace(/\$block/g, this.namespace + ":" + this.getFunctionPath())
            .replace(/\$top/g, this.top.getReference())
            .replace(/\$parent/g, () => {
              if (this.parent) {
                return this.parent.getReference();
              } else {
                throw new CompilerError(
                  "$parent used where there is no valid parent."
                );
              }
            })
        )
        .join("\n")
    );
  }
  getPath() {
    return path.resolve(
      process.cwd(),
      "./data/",
      this.namespace,
      "./functions/",
      this._path + ".mcfunction"
    );
  }
  getFunctionPath() {
    return this._path;
  }

  confirm(file) {
    if (!_fakefs.has(this._path)) {
      _fakefs.add(this._path);
      if (this.intent === "load") {
        loadFunction.set(file, this.getReference());
      } else if (this.intent === "tick") {
        tickFunction.set(file, this.getReference());
      }
      super.confirm();
    }
  }
  toString() {
    return "function " + this.namespace + ":" + this.getFunctionPath();
  }

  static setEnv(_env) {
    _fakefs = new Set();
    env = _env;
  }
}

module.exports = {
  MCFunction,
  tickFunction,
  loadFunction,
  loadFile,
  tickFile,
  evaluate_str: evaluate,
  MultiFileTag,
};
