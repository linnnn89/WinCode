# 代码与工作区

先定位范围，再按结果中的缺口定向补读。原生连接的 `health.workspaceBinding.mode` 为 `dynamic` 时，除 `workspace_open` 使用 `path` 外，下列项目工具（含回收目录移动与 `wincode_ui_review`）每次调用均须传入目标项目的绝对路径 `workspacePath`（例如 `wincode_search_text({"workspacePath":"C:/projects/App","scopePaths":["src"],"query":"ToolRouter"})`）。源码查询返回的 `nextRequest` 已包含对应的 `workspacePath`，可直接传给 `wincode_prepare_context`。固定模式按启动根目录查询。连接或版本异常见 [诊断与恢复](diagnostics.md)。

## 选择读取方式

| 已知信息或目标 | 推荐工具与方式 |
| --- | --- |
| 已知文件与起止行号 | `wincode_prepare_context` 的 `lineRanges` 直接精读目标区间 |
| 已知文件与声明名称 | `wincode_prepare_context` 的 `scopeFiles` + `symbol` 读取声明附近窗口 |
| 已知文件但位置不明 | 先调用 `wincode_file_outline` 获取声明列表，再按 `nextRequest` 续读 |
| 仅知关键词或字符串 | `wincode_search_text`（限定 `scopePaths`）定位行号后再读上下文 |
| C# 精确引用与变更影响 | 启用 Roslyn 后先搜索符号消歧，再将完整 `location` 传给引用/影响工具 |
| 项目结构或依赖关系 | `workspace_open` / `wincode_list_directory` / `wincode_analyze_workspace` |

若宿主环境已具备本地文件读取工具且行号明确，可直接有界读取本地文件。默认符号窗口约 24 行，检查资源释放或异常处理时请覆盖完整逻辑分支，勿将局部片段完整等同于整个方法完整。

## 工具与字段约束

参数名称严格区分大小写，未声明的额外字段会被剔除而不生效（例如 `scopeFile` 不能代替 `scopeFiles`，查符号时 `symbolName` 不能代替 `query`）。单次请求原始 JSON 上限为 **64 KiB**（UTF-8）。

| 工具 | 必填字段 | 可选字段与范围约束 |
| --- | --- | --- |
| `workspace_open` | `path`：非空字符串（最长 4096） | `includeTree`：布尔值；`maxOutputChars`：整数 `2048–32768`（默认 8000） |
| `wincode_list_directory` | 无（动态模式需 `workspacePath`） | `path`：默认 `.`（最长 4096）；`maxDepth`：`1–5`（默认 1）；`maxEntries`：`1–500`（默认 100）；`maxOutputChars`：`2048–32768`（默认 8000）；`includeIgnored`：默认 `false` |
| `wincode_analyze_workspace` | 无（动态模式需 `workspacePath`） | `maxDepth`：整数 `1–5`（默认 2）；整份序列化 JSON 上限 `32768` UTF-16 字符 |
| `wincode_search_text` | `query`：非空白单行字面量（最长 256，不支持正则） | `scopePaths`：`1–20` 个字面文件或目录（默认全工作区）；`caseSensitive`：默认 `false`；`maxResults`：`1–200`（默认 50）；`maxOutputChars`：`2048–32768`（默认 8000） |
| `wincode_file_outline` | `file`：工作区内字面文件路径 | `maxSymbols`：`1–200`（默认 100）；`maxOutputChars`：`2048–32768`（默认 8000） |
| `wincode_find_code_symbol` | `query`：非空名称子串（忽略大小写，Roslyn 最长 256） | `kind`：符号类型（Roslyn 最长 128，区分大小写；`local-text` 忽略大小写）。不支持文件范围参数，单文件符号读取请用 `prepare_context` 的 `scopeFiles + symbol` |
| `wincode_find_references` | `symbolName`：非空字符串 | `relativePath`：定义文件相对路径；`symbolLocation`：Roslyn 搜索返回的完整定位（`snapshotId`/`project`/`file`/`position` 均必填）；`limit`：Roslyn 条数 `1–1000`（默认 100，须配 `symbolLocation`）；`maxOutputChars`：`2048–32768`（默认 8000） |
| `analyze_change_impact` | `target`：非空符号名 | `symbolLocation`：搜索返回的完整定位（提供时 `target` 须为该符号的简单名称）；公布别名 `wincode_analyze_change_impact` |
| `wincode_plan_refactoring` | `target`、`goal`：非空字符串 | `symbolLocation`：同影响分析 |
| `wincode_safe_move_to_trash` | `filePath`：工作区内普通文件相对路径 | `reason`：移动原因说明；经原生 Windows 助手校验句柄后移入本地回收目录，仅在用户明确授权移除文件时调用 |

- 路径参数均使用字面路径（兼容动态连接所选项目根的标准长路径与 Windows 8.3 短路径），不支持 glob 通配符或工作区外符号链接，默认跳过编译生成目录。
- `wincode_search_text` 单文件上限 256 KiB、单次扫描总读取上限 8 MiB、最多枚举 5000 项；注意结合 `foundItems`、`returnedItems`、`fileIssues` 与扫描完整性判断结果。
- `kind` 支持范围：`local-text` 覆盖有限的 C# / TS / JS / Python 声明模式；Roslyn 支持 `class` / `interface` / `struct` / `enum` / `type` / `method` / `property`（构造函数归入 `method`）。

## 定向上下文

`wincode_prepare_context` 参数规则：

| 字段 | 类型与约束 | 作用与组合规则 |
| --- | --- | --- |
| `task` | 必填非空白字符串（最长 8192） | 描述当前需要核查的具体问题或目标声明名 |
| `candidateFiles` | 可选字符串数组（最多 20 项，每项 `<=1024`） | **优先候选（非排他）**；与 `scopeFiles` 同用时须包含在其范围内 |
| `scopeFiles` | 可选字符串数组（`1–20` 项，每项 `<=1024`） | **排他文件范围**；不可与 `focusAreas` 同用 |
| `symbol` | 可选无空白字符串（最长 128） | 区分大小写的精确声明名；必须配合 `scopeFiles`，不可与 `lineRanges` 同用 |
| `lineRanges` | 可选对象数组（`1–8` 项） | 每项含 `file`（`<=1024`）与正整数 `startLine` / `endLine`（1 起始闭区间，每段 `<=500` 行，每文件限一段）；不可与 `symbol` 或 `includeFullText: true` 同用 |
| `focusAreas` | 可选字符串数组（最多 5 项，每项 `<=1024`） | 聚焦文件或目录直属文件（不支持通配符） |
| `compress` / `outputFormat` | 可选布尔值 / `"markdown"`（默认）或 `"xml"` | `compress` 仅在全文且调用外部 Repomix CLI 时转发，内置降级不做 AST 压缩 |
| `includeFullText` / `responseFormat` | 可选布尔值（默认 `false`）/ `"compact"`（默认）或 `"legacy"` | 即使设 `includeFullText: true` 仍受总预算裁剪；`legacy` 额外附加 Markdown 文本并计入同一预算 |
| `maxTokens` | 可选整数 `512–65536`（默认 8000） | 按 `UTF-16 字符数 / 4` 估算（含 JSON 元数据与转义），非具体模型 tokenizer 精确值 |

- **已知行号精读示例**：
  ```json
  {"workspacePath":"C:/projects/App","task":"核对保存失败时的资源释放","lineRanges":[{"file":"src/Service.cs","startLine":50,"endLine":80}],"maxTokens":2000}
  ```
- **多声明名合并扫描（0.17.1+）**：未知具体文件但知道多个相关声明名时，可将名称放在同一次 `task` 前部（如 `{"task":"ChatViewModel ConversationWindowService 核对窗口关闭流程","maxTokens":8000}`）。`local-text` 默认将最多 4 个提取关键词合并为一次目录扫描；若任一词达到 500 条匹配或触发扫描截断，则在剩余期限内自动回退为逐词查询（避免使用 `Async` 等过宽泛词，且切勿传入 `batchSymbols` 等不存在的参数）。
- **覆盖率核查**：先看 `summary`（`scope` / `status` / `nextAction`），再核对 `coverage`（区分 `requested-lines`、`packed-files`、`displayed-snippets`）。使用 `lineRanges` 时核对 `allRequestedCovered`、`missingRanges` 与 `endLineComplete`；使用 `symbol` 时 `symbolCoverage` 为 `unknown`，按返回的 `nextRequest` 继续补读。

## 文本与 Roslyn 引用

- 默认后端 `source: "local-text"` 执行启发式声明与文本扫描（支持 C# Unicode 标识符与 `@` 逐字标识符），不具备编译器级类型消歧能力；出现 `lexical-uncertainty`、`degraded` 或 `queryComplete: false` 时须留意覆盖缺口。当前后端以 `hello.codeProvider` 为准。
- **Roslyn 精确引用流程**：
  1. 调用 `wincode_find_code_symbol({ query: "Save" })`，按返回的 `signature`、`file`、`location.project` 选定目标声明。
  2. 将所选符号的 `name` 与完整 `location`（含 `snapshotId`、`project`、`file` 与 0 基 UTF-16 `position`）原样传回：
     ```json
     {"symbolName":"Save","symbolLocation":{"snapshotId":"...","project":"...","file":"...","position":120}}
     ```
- 若向 `analyze_change_impact` 仅传符号名而不带 `symbolLocation`，Roslyn 在当前快照中唯一匹配时才会统计引用；遇到重载或同名符号时 `totalReferences` 返回 `null`，需从 `matchedSymbols` 中选定精确 `symbolLocation` 重试。向 `symbolLocation` 传入调用处而非声明处会返回 `SYMBOL_MISMATCH`。
- Roslyn 当前排除分析器与源生成器，`queryComplete` 保持 `false`，**零引用不等于可安全删除**。编辑源码、手动释放内存或重启 Host 后旧 `snapshotId` 失效，需重新搜索符号获取新 `location`。

## 显式配置 Roslyn

仅在用户允许 MSBuild 设计时项目求值时，通过网关启动参数 `--roslyn-config <绝对JSON路径>` 启用（动态模式须同时传 `--workspace <授权项目根>`）：

```json
{"enabled":true,"allowProjectEvaluation":true,"project":"App/App.csproj","configuration":"Debug","targetFramework":"net10.0","dotnetPath":"C:/Program Files/dotnet/dotnet.exe","hostPath":"C:/path/to/WinCode/tools/WinCode.Code.Host/bin/Release/net10.0/publish/WinCode.Code.Host.dll","additionalInputs":[]}
```

- 配置文件上限 16 KiB；`project` 为相对授权工作区的路径，`dotnetPath` 与 `hostPath` 须为实际普通文件绝对路径（不支持符号链接，且需保留完整的 Code Host `publish/` 目录及 `BuildHost-netcore`）。`loadTimeoutMs` 默认 `120000`（`1–120000`），`queryTimeoutMs` 默认 `30000`（`1–60000`）。
- `additionalInputs` 可声明最多 32 个工作区内相对文件（JSON 数组 `<=4096` UTF-16 字符，不支持目录、glob 或链接）；遇到 `INPUT_BUDGET_EXCEEDED` 时缩小项目输入范围。

## 文件移除

重构建议工具本身不修改任何文件；仅在任务明确授权移除文件时调用 `wincode_safe_move_to_trash`，并核查返回的 `outcome`：

- `completed`：文件移入本地回收目录且 `.meta.json` 元数据写入完成。
- `not_moved`：文件未移动，检查 `failureStage` 与原文件状态。
- `partial`：文件已移动但元数据记录未完成；保留并告知返回的 `originalPath`、`trashPath` 与 `metadataPath` 供人工核实恢复，切勿重复移动或盲目自动移回。
