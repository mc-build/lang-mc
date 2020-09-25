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
    const generated_functions = Object.keys(files).filter((name) => /__lib_generated__/.test(name));
    const user_functions = Object.keys(files).filter((name) => !/__lib_generated__/.test(name) && !name.startsWith("__"));
    const json_files = Object.keys(files).filter((name) => name.endsWith(".json")).map(name => ({
        name,
        content: files[name]
    }));
    let lookup = {};
    let functions = [];
    const transforms = {};
    const file_from_func = {};
    for (let func of generated_functions) {
        const [, name, , ...rest] = func.split("/");
        let id = rest.pop();
        const new_name = `data/lib/functions/${UID}/int/${id.replace(".mcfunction", "")}_.mcfunction`;
        lookup[`${name}:${rest.join("/") + "/" + id.replace(".mcfunction", "")}`] = `lib:${UID}/int/${id.replace(".mcfunction", "")}_`
        files[new_name] = files[func];
        transforms[func] = new_name;
        file_from_func[`lib:${UID}/int/${id.replace(".mcfunction", "")}_`] = new_name
        functions.push(`lib:${UID}/int/${id.replace(".mcfunction", "")}_`);
        delete files[func];
    }
    for (let replacement in lookup) {
        const target = new RegExp(replacement, "g");
        for (const name in files) {
            files[name] = files[name].replace(target, lookup[replacement]);
        }
        for (let i = 0; i < json_files.length; i++) {
            let c = json_files[i].content;
            for (const name in files) {
                c = c.replace(target, lookup[replacement]);
            }
            json_files[i].content = c;
        }
    }
    lookup = {};
    let usr_id = 0;
    for (let func of user_functions) {
        if (func.endsWith(".mcfunction")) {
            const [, name, , ...rest] = func.split("/");
            let id = rest.pop();
            const new_name = `data/lib/functions/${UID}/ext/${usr_id}_.mcfunction`;
            lookup[`${name}:${rest.join("/") + "/" + id.replace(".mcfunction", "")}`] = `lib:${UID}/ext/${usr_id}_`
            files[new_name] = files[func];
            file_from_func[`lib:${UID}/ext/${usr_id}_`] = new_name
            transforms[func] = new_name;
            delete files[func];
            functions.push(`lib:${UID}/ext/${usr_id}_`);
            usr_id++;
        }
    }

    for (let replacement in lookup) {
        const target = new RegExp(replacement, "g");
        for (const name in files) {
            files[name] = files[name].replace(target, lookup[replacement]);
        }
        for (let i = 0; i < json_files.length; i++) {
            let c = json_files[i].content;
            for (const name in files) {
                c = c.replace(target, lookup[replacement]);
            }
            json_files[i].content = c;
        }
    }
    const dependencies = {};
    function getDeps(content) {
        return functions.filter((func) => content.indexOf(func) != -1);
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
        json_files[i].dependencies = flatten(getDeps(json_files[i].content));
    }
    if (context.ext === ".mcm") {
        const entry = '__MACRO_METADATA__' + path.resolve(SRC_DIR, context.file);
        const data = JSON.parse(files[entry]);
        const output = {};
        for (const name in data) {
            output[name] = {
                tokens: data[name].map((item) => {
                    item.line = "lib/" + LIB_CONF.name;
                    item.file = "lib/" + LIB_CONF.name;
                    return item;
                }),
                dependencies: flatten(getDeps(data[name].map(({ token }) => token).join("\n"))).map(_ => file_from_func[_])
            }
        }
        return { macros: output, json: json_files };
    } else {
        const current = context.vfs[path.join("src", context.file)];
        const output = {};
        for (const func in current) {
            if (func.endsWith(".mcfunction")) {
                output[transforms[func]] = {
                    content: files[transforms[func]],
                    dependencies: flatten(getDeps(files[transforms[func]])).map(_ => file_from_func[_])
                }
            }
        }
        return { functions: output, json: json_files };
    }

}