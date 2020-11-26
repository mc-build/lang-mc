const fs = require("fs");
const path = require("path");
const CONFIG = require("!config/mc");
const logger = require("!logger");
const CompilerError = require("!errors/CompilerError");
const UserError = require("!errors/UserError");
const File = require("!io/File");
const {
  MCFunction,
  loadFunction,
  tickFunction,
  loadFile,
  evaluate_str,
} = require("./io");
const { evaluateCodeWithEnv, bindCodeToEnv } = require("./code-runner");
const { EventEmitter } = require("events");
const io = require("./io");
const consumer = {};
const SRC_DIR = path.resolve(process.cwd() + "/src");
const MC_LANG_EVENTS = new EventEmitter();

const F_LIB = process.argv.find((arg) => arg.startsWith("-lib="));
const PROJECT_JSON = require(path.resolve(
  process.cwd(),
  ".mcproject",
  "PROJECT.json"
));

let hashes = new Map();

function getNameFromHash(hash, prefix) {
  if (hashes.has(hash)) {
    return hashes.get(hash);
  } else {
    hashes.set(hash, prefix + hashes.size);
    return hashes.get(hash);
  }
}

let id = 0;
let env = {};
let namespaceStack = [];
let MacroCache = {};
let Macros = {};
let LoadFunction = null;
let TickFunction = null;
let MacroStorage = {};

function getMacro(filepath, dependent) {
  if (!filepath.endsWith(".mcm")) {
    filepath += ".mcm";
  }
  if (fs.existsSync(filepath)) {
    if (!MacroCache[filepath]) {
      MacroCache[filepath] = {
        macros: {},
        dependents: [],
        filepath,
        importedMacros: {},
      };
      const tokens = tokenize(fs.readFileSync(filepath, "utf-8")).map(
        (token) => {
          token.line = filepath + "@" + (token.line + 1);
          token.file = filepath;
          return token;
        }
      );
      while (tokens.length) {
        const token = tokens.shift();
        if (token.token.startsWith("macro")) {
          const [, name] = token.token.split(" ");
          validate_next_destructive(tokens, "{");
          let match = 1;
          let macrotokens = [];
          let _token;
          do {
            _token = tokens.shift();
            if (_token.token === "{") {
              match++;
            } else if (_token.token === "}") {
              match--;
            }
            if (match) macrotokens.push(_token);
          } while (match && tokens.length);
          MacroCache[filepath].macros[name] = macrotokens;
        } else if (token.token.startsWith("import")) {
          const target = token.token.substr(7).trim();
          MacroCache[filepath].importedMacros = Object.assign(
            MacroCache[filepath].importedMacros,
            getMacro(path.resolve(path.parse(filepath).dir, target), filepath)
          );
        } else {
          throw new CompilerError(
            `unexpected value '${token.token}'`,
            token.line
          );
        }
      }
    }
    if (dependent && !MacroCache[filepath].dependents.includes(dependent))
      MacroCache[filepath].dependents.push(dependent);
    if (F_LIB) {
      const f = new File();
      f.setPath("__MACRO_METADATA__/" + filepath);
      f.setContents(JSON.stringify(MacroCache[filepath].macros));
      f.confirm();
    }
    return MacroCache[filepath].macros;
  } else {
    throw new CompilerError(`macro file not found '${filepath}'`);
  }
}
const evaluate = (line, token) => {
  try {
    return evaluateCodeWithEnv(`return ${line}`, {
      ...env,
      type: (index) => token.args[index].type,
    });
    // return new Function("type", "return " + line).bind(env)((index, type) => token.args[index].type === type);
  } catch (e) {
    return true;
  }
};

class Token {
  constructor(line, token) {
    this.line = line;
    this.token = token;
  }
  [Symbol.toStringTag]() {
    return this.token;
  }
}
let included_file_list = [];
let lib_function_lookup = {};
function includeFileList(list, file) {
  while (list.length) {
    const item = list.shift();
    try {
      if (!included_file_list.includes(item)) {
        included_file_list.push(item);
        if (!item.endsWith(".json")) {
          const f = new File();
          f.setPath(path.resolve(process.cwd(), item));
          f.setContents(lib_function_lookup[item].content);
          f.confirm();
        } else {
          list.push(...lib_function_lookup[item].dependencies);
        }
        function toFunction(str) {
          const [, name, , ...rest] = str
            .replace(".mcfunction", "")
            .split(/\/|\\/);
          return `${name}:${rest.join("/")}`;
        }
        if (item.endsWith("tick.mcfunction")) {
          tickFunction.set(file, toFunction(item));
        }
        if (item.endsWith("load.mcfunction")) {
          loadFunction.set(file, toFunction(item));
        }
      }
    } catch (e) {
      console.log(item);
    }
  }
}
function loadLib(json) {
  const { remote } = json;
  let location = remote._loc;
  const lib = require(path.resolve(location, "build.json"));
  const target_name = json.name.split("/")[0];
  const macros = {};
  const libRes = {
    macros,
  };
  function loadLibMacro(macro) {
    return macro.tokens.map((raw) => {
      let token = new Token(raw.line, raw.token);
      token.file = raw.file;
      token.dependencies = macro.dependencies;
      return token;
    });
  }
  for (let file in lib) {
    const name = (target_name + file.substr(3).replace(/\..+$/, "")).replace(
      /\\/g,
      "/"
    );
    let current = lib[file];
    if (current.functions) {
      for (let func in current.functions) {
        lib_function_lookup[func] = current.functions[func];
      }
    }
    if (current.macros) {
      macros[name] = {};
      for (let macro in current.macros) {
        macros[name][macro] = loadLibMacro(current.macros[macro]);
      }
    }
    if (current.json) {
      for (let json of current.json) {
        lib_function_lookup[json.name] = json;
      }
    }
  }
  return {
    [target_name]: libRes.macros,
  };
}
const libraries = Object.assign({}, ...(PROJECT_JSON.libs.map(loadLib) || []));

const tokenize = (str) => {
  let inML = false;
  return str.split("\n").reduce((p, n, index) => {
    n = n.trim();
    if (n.startsWith("###")) inML = !inML;
    if (inML || n[0] === "#" || !n) return p;
    if (n[0] === "}") {
      p.push(new Token(index, "}"));
      n = n.slice(1);
    }
    if (n[n.length - 1] === "{") {
      const v = n.slice(0, n.length - 1).trim();
      if (v) p.push(new Token(index, v));
      p.push(new Token(index, "{"));
    } else if (n) {
      p.push(new Token(index, n));
    }
    return p;
  }, []);
};

function validate_next_destructive(tokens, expect) {
  const token = tokens.shift();
  if (token && token.token != expect) {
    throw new CompilerError(
      `unexpected token '${token.token}' expected '${expect}'`,
      token.line
    );
  }
}
function list({ getToken, actions, def }) {
  const invoker = (file, tokens, ...args) => {
    const token = invoker.getToken(tokens);
    const action = invoker.actions.find((action) => action.match(token));
    if (!action) {
      return invoker.def(file, tokens, ...args);
    } else {
      return action.exec(file, tokens, ...args);
    }
  };
  invoker.actions = actions.map((action, index) => {
    action.priority = index;
    return action;
  });
  invoker.def = def;
  invoker.getToken = getToken;
  invoker.addAction = (action, priority = invoker.actions.length) => {
    action.priority = priority;
    invoker.actions = [action, ...invoker.actions].sort(
      (a, b) => a.priority - b.priority
    );
  };
  return invoker;
}
consumer.Namespace = (file, token, tokens) => {
  const name = evaluate_str(token.substr("dir ".length));
  namespaceStack.push(name.trim());
  validate_next_destructive(tokens, "{");
  while (tokens[0].token != "}") {
    consumer.Entry(file, tokens, true);
  }
  validate_next_destructive(tokens, "}");
  namespaceStack.pop();
};
consumer.EntryOp = list({
  getToken: (tokenlist) => tokenlist[0],
  actions: [
    {
      match: (token) => token.token.startsWith("import"),
      exec(file, tokens) {
        const _token = tokens[0];
        const { token } = _token;
        const target = token.substr(7).trim();
        if (token.endsWith(".mcm")) {
          Macros = Object.assign(
            Macros,
            getMacro(path.resolve(path.parse(file).dir, target), file)
          );
        } else {
          const [lib] = target.split("/");
          if (lib) {
            const library = libraries[lib];
            if (!library[target]) {
              throw new CompilerError(
                `did not find component for ${target} for library ${lib}`,
                _token.line
              );
            }
            Macros = Object.assign(Macros, library[target]);
          } else {
            throw new CompilerError(`did not find library ${lib}`, _token.line);
          }
        }
        tokens.shift();
      },
    },
    {
      match: ({ token }) => /dir .+/.test(token),
      exec(file, tokens) {
        consumer.Namespace(file, tokens.shift().token, tokens);
      },
    },
    {
      match: ({ token }) => /function .+/.test(token),
      exec(file, tokens) {
        consumer.Function(file, tokens);
      },
    },
    {
      match: ({ token }) => /clock .+/.test(token),
      exec(file, tokens) {
        const { token } = tokens[0];
        const time = token.substr(6);
        tokens.shift();
        const func = consumer.Block(file, tokens, "clock", {
          prepend: ["schedule function $block " + time],
        });
        loadFunction.set(file, func.substr(9));
      },
    },
    {
      match: ({ token }) => /^LOOP/.test(token),
      exec(file, tokens) {
        const _token = tokens.shift();
        consumer.Loop(file, _token.token, tokens, true, consumer.Entry);
      },
    },
    {
      match: ({ token }) => /^!IF\(/.test(token),
      exec(file, tokens) {
        const _token = tokens.shift();
        const { token } = _token;
        const condition = token.substr(4, token.length - 5);
        validate_next_destructive(tokens, "{");
        if (evaluate(condition, _token)) {
          while (tokens[0].token != "}") {
            consumer.Entry(file, tokens, true);
          }
          validate_next_destructive(tokens, "}");
        } else {
          let count = 1;
          while (count && tokens.length) {
            let item = tokens.shift().token;
            if (item === "{") count++;
            if (item === "}") count--;
          }
        }
      },
    },
    {
      match: ({ token }) => /^!.+/.test(token),
      exec(file, tokens) {
        const { token } = tokens[0];
        const condition = token.substr(1);
        tokens.shift();
        validate_next_destructive(tokens, "{");
        if (evaluate(condition)) {
          while (tokens[0].token != "}") {
            consumer.Entry(file, tokens, true);
          }
          validate_next_destructive(tokens, "}");
        } else {
          let count = 1;
          while (count && tokens.length) {
            let item = tokens.shift().token;
            if (item === "{") count++;
            if (item === "}") count--;
          }
        }
      },
    },
  ],
  def: (file, tokens) => {
    const token = tokens.shift();
    throw new CompilerError(
      `unexpected token '${token.token}' before ${
        tokens[0]
          ? tokens[0].token.length > 10
            ? tokens[0].token.substr(0, 10) + "..."
            : tokens[0].token
          : "EOF"
      }`,
      token.line
    );
  },
});
consumer.Entry = (file, tokens, once) => {
  if (once) {
    consumer.EntryOp(file, tokens);
  } else {
    while (tokens[0]) {
      consumer.EntryOp(file, tokens);
    }
  }
};

consumer.Function = (file, tokens, opts = {}) => {
  const definition = tokens.shift();
  let [, name] = definition.token.split(" ");
  name = evaluate_str(name);
  if (/[^a-z0-9_\.]/.test(name)) {
    throw new CompilerError(
      "invalid function name '" + name + "'",
      definition.line
    );
  }
  const func = new MCFunction(undefined, undefined, name);
  func.namespace = namespaceStack[0];
  func.setPath(namespaceStack.slice(1).concat(name).join("/"));
  validate_next_destructive(tokens, "{");
  while (tokens[0].token != "}" && tokens[0]) {
    consumer.Generic(file, tokens, func, func, func);
  }
  validate_next_destructive(tokens, "}");
  if (opts.append) {
    for (let command of opts.append) {
      func.addCommand(command);
    }
  }
  func.confirm(file);
  return func;
};
consumer.Generic = list({
  getToken: (list) => list[0],
  actions: [
    {
      match: ({ token }) => token === "load",
      exec(file, tokens) {
        tokens.shift();
        const contents = consumer.Block(
          file,
          tokens,
          "load",
          { dummy: true },
          null,
          null
        );
        for (let i = 0; i < contents.functions.length; i++) {
          LoadFunction.addCommand(contents.functions[i]);
        }
      },
    },
    {
      match: ({ token }) => token === "tick",
      exec(file, tokens) {
        tokens.shift();
        const contents = consumer.Block(
          file,
          tokens,
          "tick",
          { dummy: true },
          null,
          null
        );
        for (let i = 0; i < contents.functions.length; i++) {
          TickFunction.addCommand(contents.functions[i]);
        }
      },
    },
    {
      match: ({ token }) => token === "<%%",
      exec(file, tokens, func) {
        const _token = tokens.shift();
        const { token } = _token;
        let code = "";
        let next = null;
        do {
          next = tokens.shift().token;
          if (next != "%%>") code += "\n" + next;
        } while (next && next != "%%>");
        try {
          MacroStorage[_token.file || "mc"] =
            MacroStorage[_token.file || "mc"] || new Map();
          evaluateCodeWithEnv(code, {
            ...env,
            emit: (command, isLoad = false) => {
              if (isLoad) {
                LoadFunction.addCommand(String(command));
              } else {
                func.addCommand(String(command));
              }
            },
            args: _token.args,
            storage: MacroStorage[_token.file || "mc"],
            type: (index) => _token.args[index].type,
          });
        } catch (e) {
          throw new CompilerError("JS: " + e.message, token.line);
        }
      },
    },
    {
      match: ({ token }) => token.startsWith("warn "),
      exec(file, tokens) {
        const { token } = tokens.shift();
        logger.warn(evaluate_str(token.substr(5).trim()));
      },
    },
    {
      match: ({ token }) => token.startsWith("error "),
      exec(file, tokens) {
        const _token = tokens.shift();
        const { token } = _token;
        throw new UserError(token.substr(5).trim(), _token.line);
      },
    },
    {
      match: ({ token }) => token.startsWith("macro"),
      exec(file, tokens) {
        const _token = tokens.shift();
        const { token } = _token;
        const [, name, ...args] = token.split(" ");
        handlemacro(file, _token, name, args, tokens);
      },
    },
    {
      match: ({ token }) => /^execute\s*\(/.test(token),
      exec(file, tokens, func, parent, functionalparent) {
        let { token } = tokens.shift();
        let condition = token.substring(
          token.indexOf("(") + 1,
          token.length - 1
        );
        func.addCommand(
          `scoreboard players set #execute ${CONFIG.internalScoreboard} 0`
        );
        func.addCommand(
          `execute ${condition} run ${consumer.Block(
            file,
            tokens,
            "conditional",
            {
              append: [
                `scoreboard players set #execute ${CONFIG.internalScoreboard} 1`,
              ],
            },
            parent,
            functionalparent
          )}`
        );
        while (/^else execute\s*\(/.test(tokens[0].token)) {
          token = tokens.shift().token;
          condition = token.substring(token.indexOf("(") + 1, token.length - 1);
          func.addCommand(
            `execute if score #execute ${
              CONFIG.internalScoreboard
            } matches 0 ${condition} run ${consumer.Block(
              file,
              tokens,
              "conditional",
              {
                append: [
                  `scoreboard players set #execute ${CONFIG.internalScoreboard} 1`,
                ],
              },
              parent,
              functionalparent
            )}`
          );
        }
        if (/^else/.test(tokens[0].token)) {
          tokens.shift();
          func.addCommand(
            `execute if score #execute ${
              CONFIG.internalScoreboard
            } matches 0 run ${consumer.Block(
              file,
              tokens,
              "conditional",
              {},
              parent,
              functionalparent
            )}`
          );
        }
      },
    },
    {
      match: ({ token }) => /^!IF\(/.test(token),
      exec(file, tokens, func) {
        const _token = tokens.shift();
        const { token } = _token;
        const condition = token.substr(4, token.length - 5);
        validate_next_destructive(tokens, "{");
        if (evaluate(condition, _token)) {
          while (tokens[0].token != "}") {
            consumer.Generic(file, tokens, func);
          }
          validate_next_destructive(tokens, "}");
        } else {
          let count = 1;
          while (count && tokens.length) {
            let item = tokens.shift().token;
            if (item === "{") count++;
            if (item === "}") count--;
          }
        }
      },
    },
    {
      match: ({ token }) => /^!.+/.test(token),
      exec(file, tokens, func) {
        const _token = tokens.shift();
        const { token } = _token;
        const condition = token.substr(1);
        validate_next_destructive(tokens, "{");
        if (evaluate(condition, _token)) {
          while (tokens[0].token != "}") {
            consumer.Generic(file, tokens, func);
          }
          validate_next_destructive(tokens, "}");
        } else {
          let count = 1;
          while (count && tokens.length) {
            let item = tokens.shift().token;
            if (item === "{") count++;
            if (item === "}") count--;
          }
        }
      },
    },
    {
      match: ({ token }) => /^block|^{/.test(token),
      exec(file, tokens, func, parent) {
        if (tokens[0].token === "block") tokens.shift();
        func.addCommand(
          consumer.Block(file, tokens, "block", {}, parent, null)
        );
      },
    },
    {
      match: ({ token }) => token.startsWith("execute") && token.indexOf("run") != -1,
      exec(file, tokens, func, parent, functionalparent) {
        const _token = tokens.shift();
        const { token } = _token;
        const command = token.substr(token.lastIndexOf("run") + 3).trim();
        const execute = token.substr(0, token.lastIndexOf("run") + 3).trim();
        if (command) {
          const lastInLine = tokens.filter((t) => t.line === _token.line).pop();
          const temp = [];
          let count = 1;
          if (lastInLine && lastInLine.token === "{") {
            temp.push(tokens.shift());
            while (tokens.length && count) {
              if (tokens[0].token === "{") count++;
              if (tokens[0].token === "}") count--;
              temp.push(tokens.shift());
            }
          }
          let copy = copy_token(_token, _token.args);
          tokens.unshift(...temp, copy);
          copy.token = "}";
          copy = copy_token(_token, _token.args);
          tokens.unshift(copy);
          copy.token = command;
          copy = copy_token(_token, _token.args);
          tokens.unshift(copy);
          copy.token = "{";
        }
        const innerFunc = consumer.Block(
          file,
          tokens,
          "execute",
          {
            dummy: true,
          },
          parent,
          functionalparent
        );
        if (
          innerFunc.functions.length > 1 &&
          innerFunc.functions[0].indexOf("$block") == -1
        ) {
          innerFunc.confirm(file);
          func.addCommand(execute + " function " + innerFunc.getReference());
        } else {
          func.addCommand(execute + " " + innerFunc.functions[0]);
        }
        // func.addCommand(
        //   token +
        //     " " +
        //     consumer.Block(file, tokens, "execute", {}, parent, null)
        // );
      },
    },
    {
      match: ({ token }) => /^LOOP/.test(token),
      exec(file, tokens, func) {
        const { token } = tokens.shift();
        consumer.Loop(file, token, tokens, func, consumer.Generic, null, null);
      },
    },
    {
      match: ({ token }) => /until\s*\(/.test(token),
      exec(file, tokens, func, parent, functionalparent) {
        const { token } = tokens.shift();
        const args = token.substr(6, token.length - 7);
        const cond = args.substr(0, args.lastIndexOf(",")).trim();
        const time = args.substr(args.lastIndexOf(",") + 1).trim();
        const _id = id.until;
        const call = consumer.Block(
          file,
          tokens,
          "until",
          {
            prepend: [
              `scoreboard players set #until_${_id} ${CONFIG.internalScoreboard} 1`,
            ],
          },
          parent,
          null
        );
        const untilFunc = new MCFunction();
        const name =
          "__generated__/until/" +
          (id.until = (id.until == undefined ? -1 : id.until) + 1);
        untilFunc.namespace = namespaceStack[0];
        untilFunc.setPath(namespaceStack.slice(1).concat(name).join("/"));
        untilFunc.addCommand(
          `scoreboard players set #until_${_id} ${CONFIG.internalScoreboard} 0`
        );
        untilFunc.addCommand(`execute ${cond} run ${call}`);
        untilFunc.addCommand(
          `execute if score #until_${_id} ${CONFIG.internalScoreboard} matches 0 run schedule function $block ${time}`
        );
        untilFunc.confirm(file);
        func.addCommand(`function ${untilFunc.getReference()}`);
      },
    },
    {
      match: ({ token }) => /^async while/.test(token),
      exec(file, tokens, func, parent) {
        let { token } = tokens.shift();
        const args = token.substr(12, token.length - 13);
        const cond = args.substr(0, args.lastIndexOf(",")).trim();
        const time = args.substr(args.lastIndexOf(",") + 1).trim();
        const whileFunc = new MCFunction();
        const name =
          "__generated__/while/" +
          (id.while = (id.while == undefined ? -1 : id.while) + 1);

        whileFunc.namespace = namespaceStack[0];
        whileFunc.setPath(namespaceStack.slice(1).concat(name).join("/"));
        const whileAction = consumer.Block(
          file,
          tokens,
          "while",
          {
            append: [
              `scoreboard players set #WHILE ${CONFIG.internalScoreboard} 1`,
              `schedule function ${whileFunc.getReference()} ${time}`,
            ],
          },
          parent,
          func
        );
        whileFunc.addCommand(
          `scoreboard players set #WHILE ${CONFIG.internalScoreboard} 0`
        );
        whileFunc.addCommand(`execute ${cond} run ${whileAction}`);

        if (/^finally$/.test(tokens[0].token)) {
          token = tokens.shift().token;
          const whileFinally = consumer.Block(
            file,
            tokens,
            "while",
            {},
            whileFunc,
            func
          );
          whileFunc.addCommand(
            `execute if score #WHILE ${CONFIG.internalScoreboard} matches 0 run ${whileFinally}`
          );
        }

        whileFunc.confirm(file);
        func.addCommand(`function ${whileFunc.getReference()}`);
      },
    },
    {
      match: ({ token }) => /^while/.test(token),
      exec(file, tokens, func, parent) {
        let { token } = tokens.shift();
        const args = token.substr(6, token.length - 7);
        const cond = args.trim();
        const whileFunc = new MCFunction();
        const name =
          "__generated__/while/" +
          (id.while = (id.while == undefined ? -1 : id.while) + 1);

        whileFunc.namespace = namespaceStack[0];
        whileFunc.setPath(namespaceStack.slice(1).concat(name).join("/"));
        const whileAction = consumer.Block(
          file,
          tokens,
          "while",
          {
            append: [
              `scoreboard players set #WHILE ${CONFIG.internalScoreboard} 1`,
              `function ${whileFunc.getReference()}`,
            ],
          },
          parent,
          func
        );
        whileFunc.addCommand(
          `scoreboard players set #WHILE ${CONFIG.internalScoreboard} 0`
        );
        whileFunc.addCommand(`execute ${cond} run ${whileAction}`);

        if (/^finally$/.test(tokens[0].token)) {
          token = tokens.shift().token;
          const whileFinally = consumer.Block(
            file,
            tokens,
            "while",
            {},
            whileFunc,
            func
          );
          whileFunc.addCommand(
            `execute if score #WHILE ${CONFIG.internalScoreboard} matches 0 run ${whileFinally}`
          );
        }

        whileFunc.confirm(file);
        func.addCommand(`function ${whileFunc.getReference()}`);
      },
    },
    {
      match: ({ token }) =>
        /^schedule\s?((\d|\.)+(d|t|s)|<%.+)\s?(append|replace){0,1}$/.test(
          token
        ),
      exec(file, tokens, func, parent, functionalparent) {
        const { token } = tokens.shift();
        const inner_func = consumer.Block(
          file,
          tokens,
          "schedule",
          {},
          parent,
          functionalparent
        );
        const [, time, type] = evaluate_str(token).split(/\s+/);
        func.addCommand(`schedule ${inner_func} ${time} ${type}`.trim());
      },
    },
    {
      match: ({ token }) => token === "sequence",
      exec(file, tokens, func) {
        tokens.shift();
        const contents = consumer.Block(
          file,
          tokens,
          "sequence",
          { dummy: true },
          null,
          null
        );
        const timeToTicks = (time) => {
          let val = +time.substr(0, time.length - 1);
          let type = time[time.length - 1];
          switch (type) {
            case "s":
              val *= 20;
              break;
            case "d":
              val *= 24000;
              break;
          }
          return val;
        };

        const commands = {};
        let time = 0;
        for (let command of contents.functions) {
          if (command.startsWith("delay")) {
            let delay = timeToTicks(command.substr(6).trim());
            time += delay;
          } else if (command.startsWith("setdelay")) {
            let delay = timeToTicks(command.substr(9).trim());
            time = delay;
          } else {
            commands[time] = commands[time] || [];
            commands[time].push(command);
          }
        }
        for (let time in commands) {
          if (time == 0) {
            for (const command of commands[time]) func.addCommand(command);
          } else {
            const subfunc = new MCFunction();
            const name =
              "__generated__/sequence/" +
              (id.sequence = (id.sequence == undefined ? -1 : id.sequence) + 1);
            subfunc.namespace = namespaceStack[0];
            subfunc.setPath(namespaceStack.slice(1).concat(name).join("/"));
            for (const command of commands[time]) subfunc.addCommand(command);
            func.addCommand(`schedule ${subfunc.toString()} ${time}t replace`);
            subfunc.confirm();
          }
        }
      },
    },
    {
      match: ({ token }) => token === "(",
      exec(file, tokens, func) {
        tokens.shift();
        let items = "";
        let next = tokens.shift();
        while (next.token != ")") {
          items += next.token + " ";
          next = tokens.shift();
        }
        func.addCommand(items.trim());
      },
    },
  ],
  def(file, tokens, func, parent, functionalparent) {
    const _token = tokens.shift();
    const { token } = _token;
    const [name, ...args] = token.split(" ");
    let _Macros = Macros;
    if (MacroCache[_token.file])
      _Macros = MacroCache[_token.file].importedMacros;
    if (!_Macros[name] && MacroCache[_token.file])
      _Macros = MacroCache[_token.file].macros;
    if (_Macros[name] && !_token.args) {
      handlemacro(file, _token, name, args, tokens);
    } else if (token.startsWith("execute")) {
      const local_token = token.replace(/ run execute/g, ""); //nope.
      const startOfCommand = local_token.indexOf(" run");
      const command = local_token.substr(startOfCommand + 5);
      const [name] = command.split(" ");
      if ((_Macros[name] || name === "macro") && !_token.args) {
        let item = copy_token(_token, _token.args);
        item.token = "}";
        tokens.unshift(item);
        item = copy_token(_token, _token.args);
        item.token = command;
        tokens.unshift(item);
        item = copy_token(_token, _token.args);
        item.token = "{";
        tokens.unshift(item);
        item = copy_token(_token, _token.args);
        item.token = local_token.substr(0, startOfCommand + 4);
        tokens.unshift(item);
      } else {
        func.addCommand(token);
      }
    } else {
      func.addCommand(token);
    }
  },
});

consumer.Block = (
  file,
  tokens,
  reason,
  opts = {},
  parent,
  functionalparent
) => {
  validate_next_destructive(tokens, "{");
  if (!reason) reason = "none";
  // just a clever way to only allocate a number if the namespace is used, allows me to define more namespaces as time goes on
  let name = null;
  if (tokens[0].token.startsWith("name ")) {
    const special_thing = tokens.shift().token;
    name = evaluate_str(special_thing.substr(5)).trim();
  } else {
    name =
      "__generated__/" +
      reason +
      "/" +
      (id[reason] = (id[reason] == undefined ? -1 : id[reason]) + 1);
  }
  const func = new MCFunction(parent, functionalparent);
  if (functionalparent === null) {
    functionalparent = func;
  }
  // func.namespace = path.parse(file).name;
  // func.setPath(name);
  func.namespace = namespaceStack[0];
  func.setPath(namespaceStack.slice(1).concat(name).join("/"));
  if (opts.prepend) {
    for (let command of opts.prepend) {
      func.addCommand(command);
    }
  }
  while (tokens[0].token != "}" && tokens[0]) {
    consumer.Generic(
      file,
      tokens,
      func,
      func,
      reason == "conditional" ? functionalparent : func
    );
  }
  if (opts.append) {
    for (let command of opts.append) {
      func.addCommand(command);
    }
  }
  validate_next_destructive(tokens, "}");
  if (!opts.dummy) {
    func.confirm(file);
    return func.toString();
  } else {
    return func;
  }
};

consumer.Loop = (
  file,
  token,
  tokens,
  func,
  type = consumer.Generic,
  parent,
  functionalparent
) => {
  let [count, name] = token
    .substring(token.indexOf("(") + 1, token.length - 1)
    .split(",")
    .map((_) => _.trim());
  if (token.indexOf("[") != -1) {
    const parts = token
      .substring(token.indexOf("(") + 1, token.length - 1)
      .split(",");
    name = parts.pop();
    count = parts.join(",");
  }
  count = evaluate(count, token);
  validate_next_destructive(tokens, "{");
  if (Array.isArray(count)) {
    for (let i = 0; i < count.length - 1; i++) {
      const copy = [...tokens];
      env[name] = count[i];
      while (copy[0].token != "}" && copy.length) {
        type(file, copy, func, parent, functionalparent);
      }
    }
    env[name] = count[count.length - 1];
  } else {
    for (let i = 0; i < count - 1; i++) {
      const copy = [...tokens];
      env[name] = i;
      while (copy[0].token != "}" && copy.length) {
        type(file, copy, func, parent, functionalparent);
      }
    }
    env[name] = count - 1;
  }
  while (tokens[0].token != "}" && tokens.length) {
    type(file, tokens, func, parent, functionalparent);
  }
  validate_next_destructive(tokens, "}");
  delete env[name];
};

function handlemacro(file, _token, name, args, tokens) {
  while (tokens[0].token === "{") {
    let level = 1;
    let index = 0;
    while (level != 0 && tokens[index]) {
      index++;
      if (tokens[index].token === "{") level++;
      if (tokens[index].token === "}") level--;
    }
    let last = tokens[index].line;
    let call = consumer.Block(file, tokens, "inline_macro_argument", {
      ref: true,
      dummy: true,
    });
    call.confirm(file);
    args.push(call.getReference());
    while (tokens[0].token != "{" && tokens[0].line === last) {
      args.push(tokens.shift().token);
    }
  }
  if (!_token.file) {
    const segments = args;
    args = [];
    let inblock = false;
    let block = "";
    while (segments.length > 0) {
      let segment = segments.shift();
      if (segment.startsWith("<")) {
        if (segment.indexOf(":") != -1) {
          block = {
            content: segment.substr(segment.indexOf(":") + 1),
            type: segment.substr(1, segment.indexOf(":") - 1),
          };
        } else {
          block = {
            content: segment.substr(1) + " ",
            type: "unkown",
          };
        }
        inblock = true;
      } else if (segment.endsWith(">")) {
        inblock = false;
        block.content += segment.substr(0, segment.length - 1);
        block.content = block.content.trim();
        args.push(block);
      } else if (inblock) {
        block.content += segment + " ";
      } else {
        args.push({ content: segment, type: "unkown" });
      }
    }
    args = args.filter((arg) => Boolean(arg.content));
    if (Macros[name]) {
      const _tokens = [
        ...Macros[name].map((_) => {
          return copy_token(_, args);
        }),
      ];
      for (let i = 0; i < _tokens.length; i++) {
        const t = _tokens[i];
        for (let j = args.length - 1; j >= 0; j--) {
          t.token = t.token.replace(
            new RegExp("\\$\\$" + j, "g"),
            args[j].content
          );
        }
      }
      if (_tokens[0].dependencies) {
        includeFileList([..._tokens[0].dependencies], file);
      }
      tokens.unshift(..._tokens);
    } else {
      throw new CompilerError("macro not found '" + name + "'", _token.line);
    }
  } else {
    let _Macros = MacroCache[_token.file].importedMacros;
    if (!_Macros[name]) _Macros = MacroCache[_token.file].macros;
    if (_Macros[name]) {
      const _tokens = [
        ..._Macros[name].map((_) => {
          let t = new Token(_.line, _.token);
          t.file = _.file;
          t.args = args;
          return t;
        }),
      ];
      for (let i = 0; i < _tokens.length; i++) {
        const t = _tokens[i];
        for (let j = 0; j < args.length; j++) {
          t.token = t.token.replace(new RegExp("\\$\\$" + j, "g"), args[j]);
        }
      }
      tokens.unshift(..._tokens);
    } else {
      throw new CompilerError("macro not found", _token.line);
    }
  }
}

function copy_token(_, args) {
  let t = new Token(_.line, _.token);
  t.file = _.file;
  t.args = args;
  t.dependencies = _.dependencies;
  return t;
}
const TickTag = new io.MultiFileTag(
  path.resolve(process.cwd(), "./data/minecraft/tags/functions/tick.json")
);
const LoadTag = new io.MultiFileTag(
  path.resolve(process.cwd(), "./data/minecraft/tags/functions/load.json")
);
function MC_LANG_HANDLER(file) {
  MC_LANG_EVENTS.emit("start", {
    file,
  });
  hashes = new Map();
  Macros = {};
  included_file_list = [];
  const location = path.relative(SRC_DIR, file);
  namespaceStack = [
    ...location
      .substr(0, location.length - 3)
      .replace(/\\/g, "/")
      .split("/"),
  ];
  if (CONFIG.defaultNamespace) {
    namespaceStack.unshift(CONFIG.defaultNamespace);
  }
  LoadFunction = new MCFunction(null, null, "load");
  LoadFunction.namespace = namespaceStack[0];
  LoadFunction.setPath(
    namespaceStack.slice(1).concat("__generated__/load").join("/")
  );
  TickFunction = new MCFunction(null, null, "tick");
  TickFunction.namespace = namespaceStack[0];
  TickFunction.setPath(
    namespaceStack.slice(1).concat("__generated__/tick").join("/")
  );
  loadFunction.reset(file);
  tickFunction.reset(file);
  LoadTag.reset(file);
  TickTag.reset(file);
  MacroStorage = {};
  if (fs.existsSync(file)) {
    env = { config: CONFIG };
    MCFunction.setEnv(env);
    ifId = 0;
    id = {};
    try {
      consumer.Entry(file, tokenize(fs.readFileSync(file, "utf8")));
      if (LoadFunction.functions.length > 0) {
        LoadFunction.functions = Array.from(
          new Set(LoadFunction.functions).keys()
        );
        LoadFunction.confirm(file);
      }
      if (TickFunction.functions.length > 0) {
        TickFunction.confirm(file);
      }
      const loadContent = loadFunction.valuesFor(file);
      if (loadContent.length > 0) {
        LoadTag.set(file, loadContent);
      }
      const tickValues = tickFunction.valuesFor(file);
      if (tickValues.length > 0) {
        TickTag.set(file, tickValues);
      }
      MC_LANG_EVENTS.emit("end", {
        file,
      });
    } catch (e) {
      MC_LANG_EVENTS.emit("fail", {
        error: e,
        file,
      });
      console.log(e.stack);
      if (e.message === "Cannot read property 'token' of undefined") {
        throw new CompilerError("expected more tokens", "EOF");
      } else {
        throw e;
      }
    }
  }
}

function MCM_LANG_HANDLER(file) {
  const toUpdate = (MacroCache[file] && MacroCache[file].dependents) || [];
  MacroCache[file] = null;
  if (fs.existsSync(file)) {
    try {
      MC_LANG_EVENTS.emit("start", {
        file,
      });
      getMacro(file);
      for (let i of toUpdate) {
        if (i.endsWith(".mc")) {
          MC_LANG_HANDLER(i);
        } else {
          MCM_LANG_HANDLER(i);
        }
      }
      MC_LANG_EVENTS.emit("end", {
        file,
      });
    } catch (e) {
      MC_LANG_EVENTS.emit("fail", {
        error: e,
        file,
      });
      console.log(e.stack);
      if (e.message === "Cannot read property 'token' of undefined") {
        throw new CompilerError("expected more tokens", "EOF");
      } else {
        throw e;
      }
    }
  }
}

module.exports = function MC(registry) {
  if (registry.has(".mc")) {
    return logger.error("handler registry already has extension '.mc'");
  }
  registry.set(".mc", MC_LANG_HANDLER);
  logger.info("registered handler or extension for '.mc'");
  if (registry.has(".mcm")) {
    return logger.error("handler registry already has extension '.mcm'");
  }
  registry.set(".mcm", MCM_LANG_HANDLER);
  logger.info("registered handler or extension for '.mcm'");

  return {
    exported: {
      on(event, handler) {
        MC_LANG_EVENTS.on(event, handler);
      },
      io: {
        loadFunction,
        tickFunction,
        TickTag,
        LoadTag,
        MCFunction,
      },
      getEnv() {
        return env;
      },
      getNamespace(type) {
        const end = namespaceStack.slice(1).join("/");
        return {
          namespace: namespaceStack[0],
          path: end + (end.length === 0 ? "" : "/"),
        };
      },
      transpiler: {
        tokenize,
        evaluate_str,
        consumer,
        validate_next_destructive,
        list,
        evaluators: {
          code: {
            evaluateCodeWithEnv: evaluateCodeWithEnv,
            getFunctionWithEnv: bindCodeToEnv,
          },
        },
      },
    },
  };
};
