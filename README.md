## 介绍

这是一个将 proto 文件转换成 OpenAPI2.0(swagger)文档的工具，支持批量转换，并支持同步至 yapi 中。

## 使用

复制`config.json.tpl`文件在项目根目录，命名为`config.json`，修改配置选项：

| 选项       | 描述                                                  | 示例                 |
| ---------- | ----------------------------------------------------- | -------------------- |
| baseDir    | proto 文件所属顶级目录，支持多层目录                  | ~/code/protos        |
| serverHost | yapi 服务地址                                         | https://yapi.xxx.com |
| projectId  | yapi 项目 ID，通过浏览器访问对应的项目并从 uri 中获得 | 11                   |
| cookie     | yapi 用户 cookie，通过浏览器 network 面板抓包获得     |                      |

运行`npm run build`即可完成转换和导入。

## 说明

### proto 文件示例

```proto
syntax = "proto3";

package user;

message UserAddReq {
  string name = 1; // 用户名
  int32 age = 2;   // 年龄
}

message UserAddResp {}
```

### 产出目录

- ./build/temp
  存放修改后的 proto 文件

- ./build/generated
  存放转换后的 swagger.json 文件
