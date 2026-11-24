# 在后台使用 WPF 快捷键

这个功能适用于能修改源码的 WPF 程序。程序决定哪个控件可以接收哪个快捷键。WinCode 请求程序自己处理按键，您的鼠标和前台窗口可以继续使用。若快捷键原有的处理逻辑会打开对话框，程序仍可能自己弹窗。

## 在程序中声明快捷键

将同目录的 [BackgroundShortcut.cs](BackgroundShortcut.cs) 加入需要开放快捷键的 WPF 项目。也可以在项目文件中用 `<Compile Include="..." Link="WinCode/BackgroundShortcut.cs" />` 引用它。该文件使用现代 .NET 的 WPF 和 C# 10 语法。

在窗口的 XAML 中加入命名空间 `xmlns:wc="clr-namespace:WinCode.Wpf"`。将下面的声明放入同一窗口的可见布局中。`Editor` 是实际处理快捷键的控件名称，`SaveShortcut` 是您为这个入口选的唯一 ID。

```xml
<wc:BackgroundShortcut AutomationProperties.AutomationId="SaveShortcut"
                       Target="{Binding ElementName=Editor}"
                       Gesture="Ctrl+S" />
```

这个元素没有自己的画面，也不接收鼠标。保留其可见性，以便 WinCode 找到它。程序应已在目标控件或其上级处理相应的 WPF 按键事件或 `KeyBinding`。支持有效的 WPF `KeyGesture`，修饰键可用 Ctrl、Shift 或两者组合。

## 授权窗口并调用

1. 启动程序，核实其进程和顶层窗口。用以下 PowerShell 取得绑定值，把示例进程号换成实际值。

   ```powershell
   $appProcess = Get-Process -Id 12345
   '{0}:0x{1:X}:{2}' -f $appProcess.Id, $appProcess.MainWindowHandle.ToInt64(), $appProcess.StartTime.ToFileTimeUtc()
   ```

2. 给 WinCode 连接加上 `--background-ui --ui-shortcut-window <绑定值>`，重新连接。固定工作区和动态工作区都可使用。程序重启后需要重新取得绑定值。
3. 目标程序在后台时，调用 `wincode_ui_shortcut`。使用实际的进程号、窗口句柄和快捷键 ID。

   ```json
   { "pid": 12345, "hwnd": "0x123ABC", "targetAutomationId": "SaveShortcut" }
   ```

4. 返回 `shortcut-requested` 表示程序已接收请求。随后用 `wincode_ui_inspect` 按相同的 `automationId` 查询入口。节点的 `shortcutStatus` 显示最近一次处理的状态。该字段由同一入口的所有调用共享。

   | 状态 | 含义 |
   | --- | --- |
   | `ready` | 入口尚未收到请求 |
   | `pending` | 请求正在等待程序处理 |
   | `routed` | 按键事件已送到控件。保存是否完成，还要核对文件或程序里的结果 |
   | `failed` | 处理途中停止。部分事件可能已经生效，重试前应先核对程序里的结果 |

## Background shortcuts in a WPF app

Include `BackgroundShortcut.cs` in the WPF application and declare an endpoint in a visible layout as shown above. Give it a unique automation ID, bind `Target` to the real control and set `Gesture` to a shortcut that the application handles. Ctrl and Shift are supported individually or together.

Start the application. Bind one top-level window to the WinCode connection with `--background-ui --ui-shortcut-window <PID>:<HWND>:<processStartFileTime>`. While a different process owns the foreground, call `wincode_ui_shortcut` with the PID, HWND and declared ID. The shortcut runs inside the application. Inspect the endpoint for its latest `shortcutStatus`, then check the application output to confirm the command took effect. Obtain a new binding after restarting the application.
