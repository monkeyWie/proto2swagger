const tools = require("@accility/protoc-tools");
const swagger = require("@accility/protoc-swagger-plugin");
const apis = require("google-proto-files");
const path = require("path");
const fs = require("fs");
const fse = require("fs-extra");
const rimraf = require("rimraf");
const run = require("./lib/yapi/run");
const HandleImportData = require("./lib/yapi/HandleImportData");
const axios = require("axios").default;
// 这个parser用于遍历，注释功能有bug
const parser = require("proto-parser");
// 这个parser用于取注释
const protobuf = require("protobufjs");
const _ = require("lodash");

// admin@admin.com ymfe.org
const config = readConfig();
const baseDir = config.baseDir;
const buildDir = path.resolve(__dirname, "build");
const tempDir = path.resolve(buildDir, "temp");
const outDir = path.resolve(buildDir, "generated");
const serverHost = config.serverHost;
const projectId = config.projectId;
const cookie = config.cookie;

function readConfig() {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "config.json")).toString()
  );
}

function copyProto() {
  // 初始化目录
  if (fs.existsSync(buildDir)) {
    rimraf.sync(buildDir);
  }
  fs.mkdirSync(buildDir);
  fs.mkdirSync(tempDir);
  fs.mkdirSync(outDir);
  fse.copySync(baseDir, tempDir);
}

async function scanProto(dir, cb) {
  if (fs.statSync(dir).isDirectory()) {
    for (const file of fs.readdirSync(dir)) {
      await scanProto(path.join(dir, file), cb);
    }
  } else if (path.extname(dir) === ".proto") {
    await cb(dir);
  }
}

copyProto();
// scanProto(tempDir, generatedOpenAPI);
generatedOpenAPI(
  path.resolve(tempDir, "h5/h5_get_apply_open_org_record.proto")
);

async function generatedOpenAPI(proto) {
  const name = path.basename(proto);
  const result = genTemp(proto);
  if (!result) {
    return;
  }
  const { ast, ast2, fullPkg, pkg, gen, versions } = result;
  if (fullPkg == "proto.grpc" || fullPkg == "proto.base") {
    return;
  }

  // 写入一份修改后的.proto文件到临时目录
  fs.writeFileSync(proto, gen);

  await tools.protoc({
    includeDirs: [path.resolve(apis.getProtoPath(), ".."), path.dirname(proto)],
    files: [name],
    outDir: outDir,
    outOptions: [
      swagger.createSwaggerOptions({ outOptions: "logtostderr=true" }),
      tools.generators.js(),
    ],
  });

  // 删除无用文件
  fs.readdirSync(outDir).forEach((file) => {
    const pathname = path.join(outDir, file);
    if (fs.statSync(pathname).isFile() && path.extname(file) === ".js") {
      fs.unlinkSync(pathname);
    }
  });

  const swaggerPath = path.join(
    outDir,
    path.basename(proto, ".proto") + ".swagger.json"
  );

  const swaggerJson = JSON.parse(fs.readFileSync(swaggerPath).toString());
  // 添加注释
  addComment(swaggerJson, ast, ast2, pkg);
  // 添加版本tag
  addVersion(swaggerJson, versions);
  fs.writeFileSync(swaggerPath, JSON.stringify(swaggerJson));

  // 模拟yAPI导入
  const json = JSON.parse(fs.readFileSync(swaggerPath).toString());
  // 添加接口简介
  for (const key of Object.keys(json.paths)) {
    if (key.startsWith("/")) {
      json.paths[key].post.summary = path.basename(name, ".proto");
    }
  }
  // 标签维护
  updateTagList(versions);
  // 分类列表拉取
  const catList = (await getCatList()) || [];
  let currCat = catList.find((cat) => cat.name == pkg);
  currCat = currCat ? currCat._id : "";
  const res = await run(JSON.stringify(json));
  await HandleImportData(
    res,
    projectId, // 项目ID
    currCat, // 分类
    catList, //已存在的分类列表
    "",
    "mergin",
    console.log,
    console.error,
    () => {},
    cookie,
    serverHost
  );
}

function genTemp(proto) {
  let text = fs.readFileSync(proto).toString();
  // 构造proto AST
  let ast = null;
  let ast2 = null;
  try {
    ast = parser.parse(text);
    ast2 = protobuf.parse(text, {
      alternateCommentMode: true,
      preferTrailingComment: true,
    });
  } catch (e) {
    console.log("解析失败，需手动处理：" + proto);
    return;
  }

  const name = path.basename(proto, ".proto");
  let fullPkg = ast.package;
  let pkg = "";
  let reqNode = findMessage(ast.root, "Req|Request");
  let req = reqNode ? reqNode.name : null;
  let respNode = findMessage(ast.root, "Resp|Res|Rsp|Respond|Response");
  let resp = respNode ? respNode.name : null;
  let uri = text.match(/(\/[a-zA-Z_\-]+)(\/[a-zA-Z0-9_\-]+)+/);
  let versions = text.match(/@version\s+([^\s]+)\n/);

  if (!req && !resp) {
    return null;
  }

  if (!req) {
    req = "RequestFake";
    console.warn(`没有匹配到请求：${proto}`);
  }

  if (!resp) {
    resp = "ResponseFake";
    console.warn(`没有匹配到响应：${proto}`);
  }

  if (uri) {
    uri = uri[0];
  } else {
    uri = "/" + name;
    console.warn(`没有匹配到uri：${proto}`);
  }

  if (fullPkg) {
    const index = fullPkg.lastIndexOf(".");
    pkg = index > 0 ? fullPkg.substring(index + 1) : fullPkg;
  } else {
    console.warn(`没有匹配到package：${proto}`);
  }

  if (versions) {
    versions = versions[1].split(",");
  }

  text = text.replace(
    /(syntax\s*=\s*"proto3";)/,
    '$1\r\nimport "google/api/annotations.proto";'
  );
  text = text.replace(
    /(package\s[a-z|0-9\.]+;)/,
    `$1\r\nservice ${pkg} {
    rpc ${name}(${req})
        returns(${resp}) {
        option(google.api.http) = {
          post : "${uri}"
          body : "*"
      };
    }
}\r\n
${req === "RequestFake" ? "message RequestFake {}\r\n" : ""}
${resp === "ResponseFake" ? "message ResponseFake {}\r\n" : ""}`
  );

  return {
    ast,
    ast2,
    fullPkg,
    pkg,
    gen: text,
    versions,
  };
}

function findMessage(node, exp) {
  if (!node) {
    return null;
  }
  if (
    node.syntaxType === "MessageDefinition" &&
    node.name.match(new RegExp(exp, "i"))
  ) {
    return node;
  }
  if (!node.nested) {
    return null;
  }
  for (const key of Object.keys(node.nested)) {
    const result = findMessage(node.nested[key], exp);
    if (result) {
      return result;
    }
  }
}

// 遍历所有message
function eachMessage(parents, node, handle) {
  if (!node) {
    return null;
  }
  if (node.syntaxType === "MessageDefinition") {
    parents = parents || [];
    handle(parents, node);
    parents.push(node);
  }
  if (!node.nested) {
    return;
  }
  for (const key of Object.keys(node.nested)) {
    eachMessage(parents, node.nested[key], handle);
  }
}

function addComment(swaggerJson, ast, ast2, pkg) {
  const definitions = swaggerJson.definitions;

  eachMessage(null, ast.root, (parents, node) => {
    const m = ast2.root.lookupTypeOrEnum(node.name);
    if (m) {
      const prefix =
        (parents.length ? "" : pkg) + parents.map((n) => n.name).join("");
      const definition = definitions[prefix + m.name];
      if (definition) {
        if (m.comment) {
          definition.description = m.comment;
        }
        // 遍历所有字段
        for (const field of Object.keys(node.fields)) {
          const f = ast2.root.lookup(
            node.name + "." + _.camelCase(field),
            protobuf.Field
          );
          if (f && f.comment && definition.properties[field]) {
            definition.properties[field].description = f.comment;
          }
        }
      }
    }
  });

  /*
  const definitions = swaggerJson.definitions;
  const arr = [];
  function flatMessage(node) {
    if (!node) {
      return;
    }
    if (node.syntaxType === "MessageDefinition") {
      arr.push(node);
    }
    if (!node.nested) {
      return;
    }
    for (const key of Object.keys(node.nested)) {
      const result = flatMessage(node.nested[key]);
      if (result) {
        arr.push(node);
      }
    }
  }
  flatMessage(node, arr);

  for (const def of Object.keys(definitions)) {
    // 匹配对应的注释
    const t1 = arr.find((n) => !!def.match(new RegExp(`${n.name}$`)));
    if (t1) {
      if (t1.comment) {
        definitions[def].description = t1.comment;
      }
      if (t1.fields && definitions[def].properties) {
        for (const prop of Object.keys(definitions[def].properties)) {
          for (const field of Object.keys(t1.fields)) {
            if (prop == field && t1.fields[field].comment) {
              definitions[def].properties[prop].description =
                t1.fields[field].comment;
            }
          }
        }
      }
    }
  }
  */
}

function addVersion(swaggerJson, version) {
  if (version) {
    const paths = swaggerJson.paths;
    const uri = paths[Object.keys(paths)[0]];
    const method = uri[Object.keys(uri)[0]];
    method.tags.push(...version);
  }
}

async function getCatList() {
  return (
    await axios.get(
      `${serverHost}/api/interface/getCatMenu?project_id=${projectId}`,
      {
        headers: {
          Cookie: cookie,
        },
      }
    )
  ).data.data;
}

async function updateTagList(versions) {
  if (!versions) {
    return;
  }
  const tagList = (
    await axios.get(`${serverHost}/api/project/get?id=${projectId}`, {
      headers: {
        Cookie: cookie,
      },
    })
  ).data.data.tag;
  let change = false;
  for (const version of versions) {
    if (!tagList.some((tag) => tag.name == version)) {
      tagList.push({ name: version, desc: `${version}迭代相关` });
      change = true;
    }
  }

  if (change) {
    await axios.post(
      `${serverHost}/api/project/up_tag`,
      { id: projectId, tag: tagList },
      {
        headers: {
          Cookie: cookie,
        },
      }
    );
  }
}
