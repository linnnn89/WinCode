# 窗口与 UI 取证

已知准确 PID/HWND 就直接使用；未知时调用 wincode_ui_list_windows，以 processName（不带 .exe）、pid 或 titleContains 缩小范围，maxWindows 建议 10。筛选同时满足。候选歧义时先确认目标，标题不证明源码归属；失效句柄才重新发现。

对用户指定窗口调用 wincode_ui_inspect，例如（编号必须替换为真实结果）：

```json
{"pid":12345,"hwnd":"0x123ABC","backgroundOnly":true,"capture":"none","maxDepth":4,"maxNodes":100}
```

只查指定控件时增加 query，例如 {automationId:"SaveButton",controlType:"Button"}；automationId/name/controlType 为区分大小写的精确 AND 条件。搜索默认 1000 节点（上限 5000）、最多返回 10 个候选（上限 20），独立于子树 maxNodes；另有 2 秒/50 层软限制，整个 Helper 仍有硬超时。
queryResult.searchComplete=true 且 status="unique" 才展开子树；ambiguous 返回多个候选，incomplete 不证明唯一，not-found 只限本次搜索范围。treeComplete 仅描述返回子树结构；propertyIssues 单独说明属性不支持、错误或裁剪。节点 id 只在本次结果有效，不作为下次定位凭据。
需要勾选/选中/展开状态时传 readStates=true；states 的 unsupported/unknown 不等于 false，不读取输入框值或执行操作。截图仍是整个目标窗口，局部查询只缩减树和标注范围。旧 Host 不支持时应更新构建，不移除查询参数冒充成功。

先取足够的小树，出现相关截断再增预算。需要看视觉布局才用 capture="original"；需要对应节点编号用 "annotated"。图片直接消费 MCP image 块，不把 Base64 转贴为文本。

后台取证保持 backgroundOnly=true 并同时传 PID/HWND，避免游戏或其他遮挡窗口污染屏幕回退。不要为截图抢前台、还原窗口或操作游戏。PrintWindow 成功仍可能黑屏/陈旧；检查 captureMethod、imageOmitted 与截断。最小化不支持；整个 Helper 超时可能无树，不无界重试。

需要源码候选时，确认源码工作区后改用 wincode_ui_review，一次取得快照与证据；无需先 inspect 再重复截图。沿用上述参数，增加 candidateFiles:["Views/MainWindow.xaml"]，必要时 textQueries:["保存"]。
- 候选为 1–16 个工作区内相对 XAML 路径；只传相关文件。
- textQueries 最多 5 个、每个 80 字符，字面量且区分大小写。
- 行号/哈希/AutomationId 候选不证明运行时版本；runtimeSourceVerified=false，保留 ambiguous、unsupported、not-found 等边界。

内置 Host 强制显示半透明 REC/WinCoding 标志并记录极简审计，不绕过。审计提示按诊断手册处理。取证不授权点击、输入或读取其他窗口。启动测试应用时使用其全新隔离数据模式，避免个人数据库。
