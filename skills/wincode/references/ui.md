# 窗口与 UI 取证

## 规范字段

参数名称区分大小写；额外字段仅被容忍和忽略，不会被当成筛选条件。不能把 `automationID`、`AutomationId` 或 `title` 当作下面的规范字段。数字、布尔值必须使用真正的 JSON 类型。

| 工具/字段 | 类型与约束 |
| --- | --- |
| `wincode_ui_list_windows` | 所有字段可选：`pid` 为整数 1–2147483647；`processName`、`titleContains` 为非空字符串、最长 128；`maxWindows` 为整数 1–100，默认 30。筛选同时满足，`processName` 不带 `.exe` |
| `wincode_ui_inspect.pid` | 可选正整数；与 `hwnd` 至少提供一个 |
| `hwnd` | 可选非空字符串，十六进制如 `"0x123ABC"` 或十进制字符串；不能传 JSON 数字 |
| `capture` | 可选字符串 `none/original/annotated`，默认 `none` |
| `maxDepth` / `maxNodes` | 可选整数，分别为 1–50（默认 6）、1–5000（默认 300） |
| `backgroundOnly` | 可选布尔值，默认 `false`；为 `true` 时必须同时提供 `pid` 和 `hwnd` |
| `readStates` | 可选布尔值，默认 `false`；只读状态，不执行动作或读取输入值 |
| `query` | 可选对象；至少有一个规范定位字段 `automationId/name/controlType`，每个为非空白字符串、最长 256；可选 `maxSearchNodes` 整数 1–5000、默认 1000，`maxMatches` 整数 1–20、默认 10。仅有未知字段不构成有效查询 |
| `wincode_ui_review` | 接受上述 inspect 的全部规范字段，另必填 `candidateFiles`：1–16 个相对 `.xaml` 路径、每项最长 512；可选 `candidateCodeFiles`：1–8 个相对 `.cs` 路径、每项最长 512；可选 `textQueries`：最多 5 个非空字面字符串、每项最长 80 |

候选路径必须在工作区内，不得包含通配符或父目录逃逸；参数合法不保证文件存在或运行窗口与源码对应，仍检查结果中的缺口。`query:{automationId:"SaveButton",maxSearchNodes:1000}` 是规范示例；`query:{automationID:"SaveButton"}` 缺少规范定位条件，仍会报错。没有未列出的 UI 工具别名。

## 选择目标与取证

已知准确 PID/HWND 就直接使用；未知时调用 wincode_ui_list_windows，以 processName（不带 .exe）、pid 或 titleContains 缩小范围，maxWindows 建议 10。筛选同时满足。候选歧义时先确认目标，标题不证明源码归属；失效句柄才重新发现。

对用户指定窗口调用 wincode_ui_inspect，例如（编号必须替换为真实结果）：

```json
{"pid":12345,"hwnd":"0x123ABC","backgroundOnly":true,"capture":"none","maxDepth":4,"maxNodes":100}
```

只查指定控件时增加 query，例如 {automationId:"SaveButton",controlType:"Button"}；automationId/name/controlType 为区分大小写的精确 AND 条件。搜索默认 1000 节点（上限 5000）、最多返回 10 个候选（上限 20），独立于子树 maxNodes；另有 2 秒/50 层软限制，整个 Helper 仍有硬超时。
queryResult.searchComplete=true 且 status="unique" 才展开子树；ambiguous 返回多个候选，incomplete 不证明唯一，not-found 只限本次搜索范围。treeComplete 仅描述返回子树结构；propertyIssues 单独说明属性不支持、错误或裁剪。节点 id 只在本次结果有效，不作为下次定位凭据。
需要勾选/选中/展开状态时传 readStates=true；states 的 unsupported/unknown 不等于 false，不读取输入框值或执行操作。截图仍是整个目标窗口，局部查询只缩减树和标注范围。旧 Host 不支持时应更新构建，不移除查询参数冒充成功。

先取足够的小树，出现相关截断再增预算。需要看视觉布局才用 capture="original"；需要对应节点编号用 "annotated"。图片直接消费 MCP image 块，不把 Base64 转贴为文本。

后台取证保持 backgroundOnly=true 并同时传 PID/HWND，避免游戏或其他遮挡窗口污染屏幕回退。不要为截图抢前台、还原窗口或操作游戏。PrintWindow 成功仍可能黑屏/陈旧；检查 captureMethod、captureQuality、imageOmitted 与截断。最小化不支持；整个 Helper 超时可能无树，不无界重试。

captureQuality 在标注前检查原始像素，最多采样 1024 点；suspect-low-variation 表示采样 RGB 各通道范围不超过 3，可能是空图，也可能是正常纯色或低对比界面。unknown 不表示图片合格；采样可能漏掉局部内容。提示不丢弃原图或 UIA、不自动切换截图方式。旧 Host 未提供该字段时按未验证处理。

需要源码候选时，确认源码工作区后改用 wincode_ui_review，一次取得快照与证据；无需先 inspect 再重复截图。沿用上述参数，增加 candidateFiles:["Views/MainWindow.xaml"]，必要时 textQueries:["保存"]。
- 候选为 1–16 个工作区内相对 XAML 路径；只传相关文件。
- textQueries 最多 5 个、每个 80 字符，字面量且区分大小写。
- 行号/哈希/AutomationId 候选不证明运行时版本；runtimeSourceVerified=false，保留 ambiguous、unsupported、not-found 等边界。
- 已知相关 C# 文件时可加 candidateCodeFiles:["ViewModels/MainWindowViewModel.cs"]，1–8 个工作区内相对 .cs 路径。codeEvidence 提供 Click/简单 Binding 的文字声明/赋值候选；按实际线索使用其 nextRequest 续查 prepare_context，并核对目标正文。
- 不传 candidateCodeFiles 不读取 C#。单文件 256 KiB、总计 1 MiB，线索/匹配/JSON 均有限额；检查 fileScanComplete、searchComplete、truncated 和省略原因。候选文件无匹配不证明全仓不存在。
- runtimeBuildSourceIdentity=unknown、templateResolution=unsupported；不推定 DataContext 或 CanExecute，也不把构造参数相似当执行链证明。多个同名声明继续保留歧义，不能自动选择首项。
- nextRequest 先读候选所在精确行；relatedSymbol 仅为构造参数文字线索，可能是变量。核对赋值后再明确请求方法，不能因该字段自动认定为方法或完整调用链。复杂插值原始字符串/超出嵌套限制的文字扫描报告不支持。

内置 Host 强制显示半透明 REC/WinCoding 标志并记录极简审计，不绕过。审计提示按诊断手册处理。取证不授权点击、输入或读取其他窗口。启动测试应用时使用其全新隔离数据模式，避免个人数据库。
