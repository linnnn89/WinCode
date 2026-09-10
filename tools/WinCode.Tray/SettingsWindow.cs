using System.Text.Json;

namespace WinCode.Tray;

internal sealed class SettingsWindow : Form
{
    private readonly PipeHub hub;
    private readonly DataGridView grid = new() { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false,
        AllowUserToDeleteRows = false, RowHeadersVisible = false, MultiSelect = false, SelectionMode = DataGridViewSelectionMode.FullRowSelect,
        AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, BackgroundColor = SystemColors.Window, BorderStyle = BorderStyle.FixedSingle,
        AccessibleName = "已连接的 WinCode 实例" };
    private readonly Label summary = new() { AutoSize = true, MaximumSize = new Size(1000, 0) };
    private readonly Label detail = new() { Dock = DockStyle.Fill, AutoSize = true, MaximumSize = new Size(1100, 0), AccessibleName = "操作结果" };
    private readonly Button refresh = new() { Text = "刷新状态", AutoSize = true, AccessibleName = "刷新状态" };
    private readonly Button release = new() { Text = "释放 Roslyn 内存", AutoSize = true, Enabled = false, AccessibleName = "手动释放 Roslyn 内存" };
    private readonly Button stop = new() { Text = "停止此实例", AutoSize = true, Enabled = false };
    private readonly NotifyIcon icon;
    private bool exiting, updating, acting, refreshing;
    private readonly System.Windows.Forms.Timer freshness = new() { Interval = 1000 };
    public bool ExitRequested => exiting;
    public string LastResult { get; private set; } = "";
    private string? lastResultInstanceId;
    internal string SelectedDetail => detail.Text;

    public SettingsWindow(PipeHub hub)
    {
        this.hub = hub;
        Text = $"WinCode 设置 · {Program.Version}"; AccessibleName = "WinCode 设置";
        Size = new Size(920, 570); MinimumSize = new Size(780, 500); StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 10); AutoScaleMode = AutoScaleMode.Dpi;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(22), ColumnCount = 1, RowCount = 7 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 108));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(new Label { Text = "内存管理", AutoSize = true, Font = new Font(Font.FontFamily, 17, FontStyle.Bold), Margin = new Padding(0, 0, 0, 12) });
        layout.Controls.Add(new Label { Text = "自动释放：关闭。保留 Roslyn 热状态，需腾出内存时再手动释放。",
            AutoSize = true, MaximumSize = new Size(1000, 0), Margin = new Padding(0, 0, 0, 10) });
        layout.Controls.Add(summary);
        grid.Columns.Add("workspace", "工作区"); grid.Columns.Add("provider", "代码能力"); grid.Columns.Add("state", "状态");
        grid.Columns.Add("memory", "Roslyn"); grid.Columns.Add("pid", "PID");
        grid.Columns[0].FillWeight = 240; grid.Columns[4].FillWeight = 55;
        layout.Controls.Add(grid);
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, Padding = new Padding(0, 10, 0, 8) };
        buttons.Controls.AddRange([refresh, release, stop]); layout.Controls.Add(buttons); layout.Controls.Add(detail);
        layout.Controls.Add(new Label { Text = "暂无在途请求不代表 Agent 任务结束。释放后首次语义查询需要重新加载，旧定位需重新搜索；在途请求或收尾期间拒绝释放。",
            AutoSize = true, MaximumSize = new Size(1000, 0), ForeColor = SystemColors.GrayText });
        Controls.Add(layout);
        layout.SizeChanged += (_, _) => {
            int width = Math.Max(200, layout.ClientSize.Width - layout.Padding.Horizontal - 12);
            foreach (var label in layout.Controls.OfType<Label>()) label.MaximumSize = new Size(width, 0);
        };
        var menu = new ContextMenuStrip();
        menu.Items.Add("设置 / 内存管理", null, (_, _) => Open());
        menu.Items.Add("退出托盘（实例继续运行）", null, (_, _) => ExitTray());
        icon = new NotifyIcon { Icon = (Icon)SystemIcons.Application.Clone(), Text = "WinCode · 自动释放已关闭", ContextMenuStrip = menu, Visible = true };
        icon.DoubleClick += (_, _) => Open();
        refresh.Click += async (_, _) => await RefreshStatus();
        release.Click += async (_, _) => await ReleaseSelected();
        stop.Click += async (_, _) => {
            var peer = Selected;
            if (peer != null && MessageBox.Show(this, "停止此实例会中断其连接。客户端可能自动建立新的实例。是否继续？", "停止 WinCode 实例", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                await Act(peer, "shutdown");
        };
        grid.SelectionChanged += (_, _) => { if (!updating) UpdateSelection(); };
        hub.Changed += OnChanged; hub.ShowRequested += OpenFromAnyThread;
        FormClosing += (_, e) => { if (!exiting) { e.Cancel = true; Hide(); } };
        Shown += (_, _) => UpdateRows();
        // 仅在窗口可见时重绘观察时效，不向后端发请求。
        freshness.Tick += (_, _) => UpdateRows();
        VisibleChanged += (_, _) => freshness.Enabled = Visible;
    }

    private GatewayPeer? Selected => grid.SelectedRows.Count == 1 ? grid.SelectedRows[0].Tag as GatewayPeer : null;
    private void OnChanged() { if (IsHandleCreated && !IsDisposed && !Disposing) { try { BeginInvoke(() => UpdateRows()); } catch (InvalidOperationException) { } } }
    private void OpenFromAnyThread() { if (IsHandleCreated && !IsDisposed) { try { BeginInvoke(() => Open()); } catch (InvalidOperationException) { } } }
    public void Open() { Show(); WindowState = FormWindowState.Normal; Activate(); UpdateRows(); _ = RefreshStatus(); }
    private static string State(GatewayPeer peer) => !peer.Connected ? "失联 / 未知" : !peer.StatusCurrent ? "状态未知 / 请刷新" : GatewayPeer.Text(peer.Status, "state") switch {
        "busy" => "有在途请求", "releasing" => "正在释放", "shutting-down" => "正在退出", "recovery-required" => "需要恢复", _ => "暂无在途请求" };
    private void UpdateRows()
    {
        if (IsDisposed || Disposing) return;
        var selected = Selected?.Id; updating = true;
        try
        {
            grid.Rows.Clear();
            foreach (var peer in hub.Peers)
            {
                var state = peer.Status;
                int row = grid.Rows.Add(GatewayPeer.Text(state, "workspace"), GatewayPeer.Text(state, "provider") == "roslyn" ? "C# 语义" : "本地文本",
                    State(peer), !peer.StatusCurrent ? "上次：" + (state.GetProperty("roslynLoaded").GetBoolean() ? "已加载" : "未加载") : state.GetProperty("roslynLoaded").GetBoolean() ? "已加载" : "未加载", peer.Pid);
                grid.Rows[row].Tag = peer;
                if (!peer.Connected) grid.Rows[row].DefaultCellStyle.ForeColor = SystemColors.GrayText;
                if (peer.Id == selected) grid.Rows[row].Selected = true;
            }
            summary.Text = $"当前连接 {hub.Peers.Count(peer => peer.Connected)} 个实例。旧版或未启用托盘连接的实例不会出现在这里。";
            if (hub.LastConnectionError != null) summary.Text += "\n最近连接错误：" + hub.LastConnectionError;
        }
        finally { updating = false; }
        UpdateSelection();
    }

    private void UpdateSelection()
    {
        var peer = Selected;
        release.Enabled = !acting && !refreshing && peer is { StatusCurrent: true } && GatewayPeer.Text(peer.Status, "state") == "idle" &&
            GatewayPeer.Text(peer.Status, "provider") == "roslyn" && peer.Status.GetProperty("roslynLoaded").GetBoolean();
        stop.Enabled = !acting && peer is { Connected: true };
        if (!acting && peer != null) detail.Text = $"实例 {peer.Id}\n版本 {peer.Version} · 观察于 {peer.ObservedAt:HH:mm:ss}\n{peer.ObservationError ?? GatewayPeer.Text(peer.Status, "lastError", 500)}\n{(lastResultInstanceId == peer.Id ? "上次操作：" + LastResult : "")}";
    }

    public async Task RefreshStatus()
    {
        if (acting || refreshing) return;
        refreshing = true; refresh.Enabled = false; UpdateSelection();
        try { await Task.WhenAll(hub.Peers.Where(peer => peer.Connected).Select(async peer => {
            try { await peer.Request("status"); } catch (Exception error) when (error is IOException or InvalidDataException or TimeoutException or InvalidOperationException or KeyNotFoundException) { }
        })); UpdateRows(); }
        finally { refreshing = false; if (!IsDisposed) { refresh.Enabled = true; UpdateSelection(); } }
    }

    public async Task ReleaseSelected() { if (Selected is { Connected: true } peer) await Act(peer, "releaseRoslyn"); }
    private async Task Act(GatewayPeer peer, string operation)
    {
        if (acting || refreshing) return;
        acting = true; lastResultInstanceId = peer.Id; UpdateSelection(); refresh.Enabled = false;
        try
        {
            // 每次手动操作先取得新状态；超时绝不接着释放，更不排队到稍后重试。
            if (operation == "releaseRoslyn") await peer.Request("status");
            var result = await peer.Request(operation);
            LastResult = GatewayPeer.Text(result, "message", 2000);
            if (peer.Connected && operation != "shutdown") await peer.Request("status");
        }
        catch (Exception error) when (error is IOException or InvalidDataException or TimeoutException or InvalidOperationException or KeyNotFoundException) { LastResult = error.Message; }
        finally
        {
            acting = false;
            if (!IsDisposed) { refresh.Enabled = true; UpdateRows(); }
        }
    }

    public void ExitTray() { exiting = true; Close(); }
    // 仅供同程序集验收使用，仍调用真实按钮处理路径与真实本地控制连接。
    internal bool SelectInstance(string id) {
        UpdateRows(); grid.ClearSelection();
        foreach (DataGridViewRow row in grid.Rows) if ((row.Tag as GatewayPeer)?.Id == id) { row.Selected = true; return release.Enabled; }
        return false;
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) { freshness.Dispose(); hub.Changed -= OnChanged; hub.ShowRequested -= OpenFromAnyThread; icon.Visible = false; icon.ContextMenuStrip?.Dispose(); icon.Icon?.Dispose(); icon.Dispose(); }
        base.Dispose(disposing);
    }
}
