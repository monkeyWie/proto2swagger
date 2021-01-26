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
generatedOpenAPI(path.resolve(tempDir, "pay/pay_133_get_asset.proto"));

async function generatedOpenAPI(proto) {
  const name = path.basename(proto);
  const result = genTemp(proto);
  if (!result) {
    return;
  }
  const { ast, ast2, pkg, gen, paths } = result;

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
  // 添加接口简介和版本
  const versions = addApiInfo(swaggerJson, paths);
  // 添加注释
  addComment(swaggerJson, ast, ast2, pkg);
  // number类型处理
  undateNumberProperties(swaggerJson);
  fs.writeFileSync(swaggerPath, JSON.stringify(swaggerJson));

  // 模拟yAPI导入
  const json = JSON.parse(fs.readFileSync(swaggerPath).toString());
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
    ast = parser.parse(text, { weakResolve: true });
    ast2 = protobuf.parse(text, {
      alternateCommentMode: true,
      preferTrailingComment: true,
    });
  } catch (e) {
    console.log("解析失败，需手动处理：" + proto);
    return;
  }

  const fullPkg = ast.package;
  if (fullPkg == "proto.grpc" || fullPkg == "proto.base") {
    return;
  }
  const name = path.basename(proto, ".proto");
  let pkg = fullPkg.lastIndexOf(".");
  pkg = pkg != -1 ? fullPkg.substring(pkg + 1) : fullPkg;

  const paths = getMessages(ast, ast2, name, pkg, text);
  if (paths.length == 0) {
    return;
  }

  const apisText = paths
    .map((api) => {
      const apiName = paths.length == 1 ? name : api.req.biz;
      return ` rpc ${apiName}(${api.req.name})
    returns(${api.resp.name}) {
    option(google.api.http) = {
      post : "${api.req.uri}"
      body : "*"
  };
}

`;
    })
    .join("");
  const fakeText = paths
    .map((api) => {
      if (!api.req.syntaxType) {
        return `
      message ${api.req.name} {}
      
      `;
      } else if (!api.resp.syntaxType) {
        return `
      message ${api.resp.name} {}
      
      `;
      } else {
        return "";
      }
    })
    .join("");

  text = text.replace(
    /(syntax\s*=\s*"proto3";)/,
    '$1\r\nimport "google/api/annotations.proto";'
  );
  text = text.replace(
    /(package\s[a-z|0-9\.]+;)/,
    `$1\r\nservice ${pkg} {
    ${apisText}
}

`
  );
  text += fakeText;

  return {
    ast,
    ast2,
    pkg,
    gen: text,
    paths,
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

// 获取出顶级的message配对列表
function getMessages(ast, ast2, name, pkg, text) {
  const ret = [];

  const reqs = [];
  const resps = [];

  const pks = ast.package.split(".");
  let node = ast.root.nested;
  for (const pk of pks) {
    node = node[pk].nested;
  }

  for (const key of Object.keys(node)) {
    const t = node[key];
    if (t.syntaxType === "MessageDefinition") {
      let mr = t.name.match(new RegExp(/^(.*)(?:Request|Req)(.*)$/, "i"));
      if (mr) {
        t.biz = mr[1] + mr[2];
        reqs.push(t);
      } else {
        mr = t.name.match(
          new RegExp(/^(.*)(?:Respond|Response|Resp|Rsp)(.*)$/, "i")
        );
        if (mr) {
          t.biz = mr[1] + mr[2];
          resps.push(t);
        }
      }
    }
  }

  if (reqs.length == 0 && resps.length == 0) {
    return ret;
  }

  if (reqs.length != resps.length) {
    const diff = reqs.length - resps.length;
    const absDiff = Math.abs(diff);
    if (diff < 0) {
      // 缺少请求补上
      for (let i = 0; i < absDiff; i++) {
        reqs.push({ name: "RequestFake" + i });
      }
    } else {
      // 缺少响应补上
      for (let i = 0; i < absDiff; i++) {
        resps.push({ name: "ResponseFake" + i });
      }
    }
    for (let i = 0; i < reqs.length; i++) {
      if (!reqs[i].biz) {
        reqs[i].biz = resps[i].biz;
      }
      ret.push({
        req: reqs[i],
        resp: resps[i],
      });
    }
  } else if (reqs.length > 1) {
    // 存在多个接口的情况，匹配对应的请求和响应
    for (let i = 0; i < reqs.length; i++) {
      const req = reqs[i];
      const t = resps.find((r) => r.biz == req.biz);
      if (t) {
        ret.push({
          req,
          resp: t,
        });
      } else {
        ret.push({
          req,
          resp: resps[i],
        });
      }
    }
  } else {
    ret.push({
      req: reqs[0],
      resp: resps[0],
    });
  }

  // 接口命名修复逻辑处理，不能重复，不能以数字开头
  for (const req of reqs) {
    let modify = false;
    if (reqs.some((r) => r != req && r.biz == req.biz)) {
      req.biz = req.name;
      modify = true;
    }
    if (req.biz.match(/^\d/)) {
      modify = true;
    }
    if (modify) {
      req.biz = "Api" + req.biz;
    }
  }

  // 全局
  const guri = text.match(/(\/[a-zA-Z_\-]+)(\/[a-zA-Z0-9_\-]+)+/);
  const gbrief = text.match(/@brief\s+([^\s]+)\n/);
  const gversions = text.match(/@version\s+([^\s]+)\n/);
  const isSingle = reqs.length == 1 || resps.length == 1;

  // 获取接口基本信息
  for (const req of reqs) {
    let uri, brief, versions;
    if (isSingle) {
      if (guri) {
        uri = guri[0];
      } else {
        uri = "/" + name;
      }
      brief = gbrief;
      versions = gversions;
    }

    if (req.syntaxType) {
      const type = ast2.root.lookupTypeOrEnum(req.name);
      if (type && type.comment) {
        const speUri = type.comment.match(/@?router\s+([^\s]+)\n/);
        if (speUri) {
          uri = speUri[1];
        }
        const speBrief = type.comment.match(/@brief\s+([^\s]+)\n/);
        if (speBrief) {
          brief = speBrief;
        }
        const speVersions = type.comment.match(/@version\s+([^\s]+)\n/);
        if (speVersions) {
          versions = speVersions;
        }
      }
    }

    if (uri) {
      req.uri = uri;
    } else {
      req.uri = "/" + pkg + "_" + req.name;
    }
    if (brief) {
      req.brief = brief[1];
    }
    if (versions) {
      req.versions = versions[1].split(",");
    }
  }

  return ret;
}

// 遍历所有message
function eachMessage(node, handle) {
  if (!node) {
    return null;
  }
  if (node.syntaxType === "MessageDefinition") {
    handle(node);
  }
  if (!node.nested) {
    return;
  }
  for (const key of Object.keys(node.nested)) {
    eachMessage(node.nested[key], handle);
  }
}

function addComment(swaggerJson, ast, ast2, pkg) {
  const definitions = swaggerJson.definitions;

  eachMessage(ast.root, (node) => {
    const m = ast2.root.lookupTypeOrEnum(node.name);
    if (m) {
      let defName = node.fullName.match(
        new RegExp(`^\\.${ast.package}\\.(.*)$`)
      );
      if (defName) {
        defName = defName[1].replace(/\./g, "");
      }
      const definition = definitions[defName] || definitions[pkg + defName];
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
            const prop = definition.properties[field];
            if (prop["$ref"]) {
              prop["allOf"] = [{ $ref: prop["$ref"] }];
              delete prop["$ref"];
            }
            prop.description = f.comment;
          }
        }
      }
    }
  });
}

function undateNumberProperties(swaggerJson) {
  const definitions = swaggerJson.definitions;

  function checkAndModifyType(prop) {
    if (prop.format && prop.format.includes("int")) {
      prop.type = "integer";
    }
  }

  for (const defKey of Object.keys(definitions)) {
    const def = definitions[defKey];
    if (!def.properties) {
      continue;
    }
    for (const propKey of Object.keys(def.properties)) {
      const prop = def.properties[propKey];
      if (prop.type == "array") {
        checkAndModifyType(prop.items);
      } else {
        checkAndModifyType(prop);
      }
    }
  }
}

function addApiInfo(swaggerJson, paths) {
  const verionSet = new Set();
  for (const pk of Object.keys(swaggerJson.paths)) {
    const path = swaggerJson.paths[pk];
    const t = paths.find((p) => p.req.uri == pk);
    if (t.req.brief) {
      path.post.summary = t.req.brief;
    }
    if (t.req.versions) {
      path.post.tags.push(...t.req.versions);
      for (const v of t.req.versions) {
        verionSet.add(v);
      }
    }
  }
  return verionSet.size == 0 ? null : verionSet;
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
