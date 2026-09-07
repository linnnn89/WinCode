# WinCode.UIA.Host

Windows UI Automation (FlaUI.UIA3) 一次性取证进程。

## 职责边界
1. **单次执行**：接收 stdin JSON，执行单次有界 UIA 遍历与可选截图，输出 stdout 纯净 JSON 后退出。
2. **零副作用**：只 attach 目标进程窗口，绝不主动启动、激活焦点或杀死目标进程。
3. **坐标系统**：
   - 采用 `SetProcessDpiAwarenessContext(PerMonitorV2)`。
   - 所有输出矩形（`bounds`, `captureOrigin`, `relativeBounds`）均为**物理屏幕像素**。
   - 截图采用 `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` 获取物理扩展边框。根节点 `relativeBounds (-9, 0)` 等偏移量系 Windows DWM 阴影扩展边框所致，为正常物理像素差值。
4. **截屏管线**：
   - 优先级 1: `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)`，可截取 GPU 硬件加速的 WPF 窗口且不受普通遮挡影响。
   - 优先级 2: `PrintWindow(hwnd, hdc, 0)`。
   - 优先级 3: 桌面 DC `BitBlt`。
   - 优先级 4: `CopyFromScreen`（使用 GDI 兼容的 `PixelFormat.Format32bppRgb`）。
   - 响应包含 `captureMethod`（例如 `printWindowDwm`）。

## 协议示例

### 1. 输入 (stdin)
```json
{
  "schemaVersion": "1.0",
  "requestId": "req-123",
  "action": "inspect",
  "pid": 25864,
  "hwnd": "0x60766",
  "capture": "annotated",
  "maxDepth": 6,
  "maxNodes": 300,
  "timeoutMs": 10000
}
```

### 2. 正常响应 (stdout)
```json
{
  "schemaVersion": "1.0",
  "protocolVersion": "1.0",
  "requestId": "req-123",
  "success": true,
  "pid": 25864,
  "hwnd": "0x60766",
  "captureOrigin": { "x": 2044, "y": 669, "width": 1032, "height": 741 },
  "captureMethod": "printWindowDwm",
  "tree": {
    "id": 1,
    "parentId": null,
    "automationId": "WinCodeWpfFixtureRoot",
    "name": "WinCode UI Review Fixture",
    "controlType": "Window",
    "className": "Window",
    "bounds": { "x": 2035, "y": 669, "width": 1050, "height": 750 },
    "relativeBounds": { "x": -9, "y": 0, "width": 1050, "height": 750 },
    "isEnabled": true,
    "isOffscreen": false,
    "children": []
  },
  "totalNodes": 32,
  "maxDepthReached": 4,
  "truncated": false,
  "annotatedPngBase64": "..."
}
```

### 3. 多窗口候选响应
```json
{
  "schemaVersion": "1.0",
  "protocolVersion": "1.0",
  "requestId": "req-124",
  "success": false,
  "errorCode": "MULTIPLE_WINDOWS",
  "errorMessage": "Could not resolve target window for PID 1234 / HWND .",
  "candidateWindows": [
    {
      "hwnd": "0x30882",
      "title": "WinCode UI Review Fixture",
      "className": "Window",
      "bounds": { "x": 100, "y": 100, "width": 700, "height": 500 },
      "isIconic": false
    }
  ]
}
```
