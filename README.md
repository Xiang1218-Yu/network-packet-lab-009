# Network Packet Lab · 网络协议数据包可视化实验室

项目 10：一个用于学习和演示网络协议解析过程的可视化实验室。当前版本聚焦模拟 HTTP / TCP 数据包，提供输入、场景选择、协议层级字段树、十六进制数据、解析时间线，以及可供 React 管理界面调用的 Node.js API。

## 技术栈

- **前端**：React 18、Vite、TypeScript
- **后端**：Node.js、Express、TypeScript
- **工程**：前后端共享 `shared/types.ts` 类型，根目录统一管理脚本

## 目录结构

```text
network-packet-lab/
├── client/
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       └── styles.css
├── server/
│   └── index.ts
├── shared/
│   └── types.ts
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── vite.config.ts
└── .gitignore
```

## 功能

1. **模拟数据选择**：在 HTTP / TCP 协议之间切换，并选择请求、响应或 TCP 握手场景。
2. **数据包输入**：编辑原始 HTTP 文本或 TCP 模拟摘要，点击“解析数据包”重新生成可视化结果。
3. **协议字段树**：HTTP 展示起始行、Header、Payload（请求目标下挂 Path 与逐条 Query 参数节点）；TCP 展示 Ethernet、IPv4、TCP 和 Payload 层级，并支持折叠。
4. **请求语义检查器**：从解析后的 HTTP 请求中提取方法、路径、Query 参数、重复参数、Header 与 Body，支持“解码前 / 解码后”视图切换；当请求目标含有编码字符、重复 key、无值参数或 malformed percent-encoding 时，保留原始文本并在对应条目下给出局部诊断（含在原始目标中的偏移位置）。点击检查器中的任意条目可跳回字段树对应节点并高亮。TCP 数据包与 HTTP 响应显示“不适用”状态而非空白。
5. **十六进制视图**：以 offset、hex bytes、ASCII 三列展示当前 payload 的 UTF-8 字节。
6. **传输时间线**：展示抓包、解析、传输层解码和结构化输出等阶段。
7. **解析 API / 模拟数据 API**：Express 服务提供 `/api/parse`、`/api/simulate`、`/api/packets` 和 `/api/health`，响应中的 `inspection` 字段携带请求语义检查结果。

## 启动方式

当前只完整落盘项目文件，**没有安装依赖**。准备运行时，在本目录执行：

```bash
npm install
```

然后打开两个终端：

```bash
# 终端 1：启动 API 服务（默认 3001）
npm run dev:server

# 终端 2：启动 Vite 管理界面（默认 5173）
npm run dev:client
```

浏览器访问 `http://localhost:5173`。如需更换 API 地址，可设置 `VITE_API_BASE`，例如：

```bash
VITE_API_BASE=http://localhost:3001 npm run dev:client
```

生产构建：

```bash
npm run build
npm start
```

> `npm start` 会启动编译后的 API 服务；前端静态产物位于 `dist/client`，可交给任意静态服务器托管。

## API 示例

### 获取模拟数据

```bash
curl 'http://localhost:3001/api/simulate?protocol=HTTP&scenario=request'
curl 'http://localhost:3001/api/simulate?protocol=TCP&scenario=handshake'
```

### 解析输入数据包

```bash
curl -X POST 'http://localhost:3001/api/parse' \
  -H 'Content-Type: application/json' \
  -d '{"protocol":"HTTP","scenario":"request","raw":"GET /health HTTP/1.1\\r\\nHost: lab.local\\r\\n\\r\\n"}'
```

响应中的 `data.inspection` 即请求语义检查结果：

- `applicable: false`：TCP 数据包或 HTTP 响应，附带 `reason` / `reasonEn` 说明；
- `applicable: true`：包含 `method`、`path`（`raw` / `decoded` / `diagnostics`）、`query.params`（逐项保留 `rawSegment`、`rawKey` / `decodedKey`、`rawValue` / `decodedValue` 与局部诊断）、`duplicateKeys`、`headers`、`body`，以及汇总后的 `diagnostics`；
- 每个条目都带有 `fieldId`，对应 `data.fields` 字段树中的节点 `id`，前端据此实现“点击检查器条目 → 高亮字段树节点”的联动。

### 获取某协议的全部示例

```bash
curl 'http://localhost:3001/api/packets?protocol=TCP'
```

## 说明

本项目是教学用模拟器，不执行真实网卡抓包，也不声称校验真实 TCP 校验和。十六进制内容由当前输入字符串的 UTF-8 字节生成，字段解析为面向演示的轻量级解析结果。
