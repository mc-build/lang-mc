const path = require("path");
const SRC_DIR = path.resolve(process.cwd(), 'src');
const LIB_JSON = path.resolve(process.cwd(), 'lib.json');
const LIB_CONF = require(LIB_JSON);
const UID = LIB_CONF.name + "-" + new Date().getTime().toString(36);

module.exports = (context) => {
    let files = {};
    for (const source in context.vfs) {
        const children = context.vfs[source];
        for (const file in children) {
            const content = children[file];
            files[file.replace(/\\/g, "/")] = content;
        }
    }
    const lib_name = LIB_CONF.name;
    const json_files = Object.keys(files).filter((name) => name.endsWith(".json")).map(name => ({
        name,
        content: files[name].replace(new RegExp("lib:", "g"), `lib:${lib_name}/`)
    }));
    const file_from_func = {};
    let transforms = {};
    let functions = [];
    keys = Object.keys(files);
    for (let func of keys) {
        if (func.endsWith(".mcfunction")) {
            const [, name, , ...rest] = func.split("/");
            const new_name = `data/lib/functions/${lib_name}/${rest.join("/")}`;
            file_from_func[`lib:${lib_name}/${rest.join("/").replace(".mcfunction", "")}`] = new_name
            files[new_name] = files[func];
            delete files[func];
            functions.push(`lib:${lib_name}/${rest.join("/").replace(".mcfunction", "")}`);
        }
    }
    const target = new RegExp("lib:", "g");
    for (const name in files) {
        files[name] = files[name].replace(target, `lib:${lib_name}/`);
    }
    const dependencies = {};
    function getDeps(content) {
        return functions.filter(
            (func) => content.indexOf(func) != -1
        );
    }
    const func_from_file = Object.fromEntries(Array.from(Object.entries(file_from_func)).map(([key, value]) => [value, key]))
    for (let file in files) {
        dependencies[file] = getDeps(files[file]);
        if (dependencies[file].includes(func_from_file[file])) {
            dependencies[file].splice(dependencies[file].indexOf(func_from_file[file]), 1);
        }
    }
    function flatten(entries) {
        const res = new Set();
        const unseen = new Set(entries);
        while (unseen.size > 0) {
            const item = unseen.keys().next().value;

            if (!res.has(item)) {
                const children = dependencies[
                    file_from_func[item]
                ]
                for (let i = 0; i < children.length; i++) {
                    if (!res.has(file_from_func[children[i]])) {
                        unseen.add(children[i]);
                    }
                }
            }
            unseen.delete(item);
            res.add(item);
        }
        return Array.from(res.keys());
    }
    for (let i = 0; i < json_files.length; i++) {
        json_files[i].dependencies = flatten(getDeps(json_files[i].content)).map(_ => file_from_func[_]);
    }
    if (context.ext === ".mcm") {
        const entry = '__MACRO_METADATA__' + path.resolve(SRC_DIR, context.file);
        const data = JSON.parse(files[entry]);
        const output = {};
        const load_json = Object.keys(files).find(file => file.endsWith("load.json"));
        const tick_json = Object.keys(files).find(file => file.endsWith("tick.json"));
        for (const name in data) {
            output[name] = {
                tokens: data[name].map((item) => {
                    item.line = "lib/" + LIB_CONF.name;
                    item.file = "lib/" + LIB_CONF.name;
                    return item;
                }),
                dependencies: [
                    ...flatten(getDeps(data[name].map(({ token }) => token).join("\n"))).map(_ => file_from_func[_]),
                    load_json,
                    tick_json
                ].filter(Boolean)
            }
        }
        return { macros: output, json: json_files };
    } else {
        const current = context.vfs[path.join("src", context.file)];
        const output = {};
        for (const func in files) {
            if (func.endsWith(".mcfunction")) {
                output[func] = {
                    content: files[func],
                    dependencies: flatten(getDeps(files[func])).map(_ => file_from_func[_])
                }
            }
        }
        return { functions: output, json: json_files };
    }

}