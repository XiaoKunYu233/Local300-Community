using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Diagnostics;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("Local300")]
[assembly: AssemblyDescription("Local300 v0.12 公开测试版")]
[assembly: AssemblyProduct("Local300")]
[assembly: AssemblyCompany("Local300")]
[assembly: AssemblyVersion("0.12.0.0")]
[assembly: AssemblyFileVersion("0.12.0.0")]

static class Program {
    internal static string DataRoot, CacheRoot, SelfTestFile;
    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        // The elevated helper runs compiled, fixed-scope code only. It must not
        // extract a writable payload or start the ordinary account backend.
        if (args.Length > 0 && args[0].StartsWith("--update-guard=")) {
            try {
                if(args.Length!=2||!args[1].StartsWith("--client64="))throw new Exception("客户端保护参数不完整。");
                string action=args[0].Substring(15),directory=new UTF8Encoding(false,true).GetString(Convert.FromBase64String(args[1].Substring(11)));
                GuardStatus result;
                if(action=="enable")result=ClientUpdateGuard.Enable(directory);
                else if(action=="disable")result=ClientUpdateGuard.Disable(directory);
                else throw new Exception("客户端保护操作无效。");
                if(!result.Ok){MessageBox.Show(result.Message,"客户端保护未完成",MessageBoxButtons.OK,MessageBoxIcon.Information);Environment.ExitCode=2;}
            } catch(Exception e){MessageBox.Show(e.Message,"客户端保护未完成",MessageBoxButtons.OK,MessageBoxIcon.Error);Environment.ExitCode=2;}
            return;
        }
        try {
            bool render = args.Length > 0 && args[0].StartsWith("--render=");
            if (render) {
                using (var f = new MainForm(true)) { f.ShowInTaskbar=false;f.Opacity=0;f.Show();Application.DoEvents();f.PerformLayout(); using (var b = new Bitmap(f.Width, f.Height)) { f.DrawToBitmap(b, new Rectangle(0, 0, f.Width, f.Height)); b.Save(args[0].Substring(9)); } } return;
            }
            DataRoot = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "Local300-data");
            if(File.Exists(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath),"300.exe")))throw new Exception("请把本工具放在游戏客户端文件夹之外，方便保留和恢复原配置。");
            foreach (var a in args) {if (a.StartsWith("--data=")) DataRoot = Path.GetFullPath(a.Substring(7));if(a.StartsWith("--self-test="))SelfTestFile=Path.GetFullPath(a.Substring(12));}
            if(DataRoot.Length >= 220)throw new Exception("工具所在路径太长，请把主程序和已有 Local300-data 一起移到较短的文件夹，例如 D:\\Local300，再重新打开。请勿删除存档。");
            Directory.CreateDirectory(DataRoot);
            bool owned; using (var mutex = new System.Threading.Mutex(true, "Local300-" + Hash(Encoding.UTF8.GetBytes(DataRoot.ToLowerInvariant())), out owned)) {
                if (!owned) { MessageBox.Show("这份工具已经打开，请回到原窗口操作。", "Local300"); return; }
                Extract(); Application.Run(new MainForm(false));
            }
        } catch (Exception e) { if(SelfTestFile!=null){File.WriteAllText(SelfTestFile,new JavaScriptSerializer().Serialize(new {ok=false,error=e.ToString()}));Environment.ExitCode=1;return;}if(args.Length>0&&args[0].StartsWith("--render=")){File.WriteAllText(args[0].Substring(9)+".error.txt",e.ToString());return;} MessageBox.Show("工具未能启动：" + e.Message + "\n请把程序放到自己的下载或文档文件夹后重试。不要删除已有数据文件夹。", "Local300", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }
    internal static string Hash(byte[] bytes) { using (var s = SHA256.Create()) return BitConverter.ToString(s.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static void Extract() {
        CacheRoot = Path.Combine(DataRoot, ".runtime-" + BuildInfo.PayloadSHA.Substring(0, 16));
        if((File.GetAttributes(DataRoot)&FileAttributes.ReparsePoint)!=0)throw new Exception("数据文件夹存在转向，请使用普通文件夹保留存档。");
        if (!Directory.Exists(CacheRoot)) {
            // Avoid repeating the cache key in temporary paths: native asset
            // names can otherwise exceed the legacy Windows path limit.
            string temporary = Path.Combine(DataRoot, ".t-" + Guid.NewGuid().ToString("N"));
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload")) {
                if (stream == null) throw new Exception("程序内的运行资料缺失，请重新取得完整程序。");
                byte[] bytes; using (var ms = new MemoryStream()) { stream.CopyTo(ms); bytes = ms.ToArray(); }
                if (Hash(bytes) != BuildInfo.PayloadSHA) throw new Exception("程序内的运行资料核对失败。");
                using (var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read)) {
                    foreach (var entry in zip.Entries) {
                        string candidate = Path.GetFullPath(Path.Combine(temporary, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                        if (candidate.Length >= 260 || Path.GetDirectoryName(candidate).Length >= 248)
                            throw new Exception("工具所在路径太长，请把主程序和已有 Local300-data 一起移到较短的文件夹，例如 D:\\Local300，再重新打开。请勿删除存档。");
                    }
                    Directory.CreateDirectory(temporary);
                    foreach (var entry in zip.Entries) {
                        string target = Path.GetFullPath(Path.Combine(temporary, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                        if (!target.StartsWith(temporary + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("运行资料路径无效。");
                        if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(target)); using (var input = entry.Open()) using (var output = new FileStream(target, FileMode.CreateNew)) input.CopyTo(output);
                    }
                }
            }
            Directory.Move(temporary, CacheRoot);
        }
        if((File.GetAttributes(CacheRoot)&FileAttributes.ReparsePoint)!=0)throw new Exception("运行资料目录存在转向，已停止启动。");
        var json = new JavaScriptSerializer(); json.MaxJsonLength = 20 * 1024 * 1024;
        var indexBytes=File.ReadAllBytes(Path.Combine(CacheRoot,"file-index.json"));if(Hash(indexBytes)!=BuildInfo.IndexSHA)throw new Exception("运行资料清单已变化，请保留存档后重新取得程序。");
        var manifest = json.Deserialize<List<Dictionary<string, object>>>(Encoding.UTF8.GetString(indexBytes));
        foreach (var row in manifest) {
            string name = Convert.ToString(row["path"]), file = Path.GetFullPath(Path.Combine(CacheRoot, name.Replace('/', Path.DirectorySeparatorChar)));
            for(string check=file;check!=CacheRoot&&check!=null;check=Path.GetDirectoryName(check))if((File.GetAttributes(check)&FileAttributes.ReparsePoint)!=0)throw new Exception("运行资料路径存在转向，已停止启动。");
            if (!file.StartsWith(CacheRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(file) || Hash(File.ReadAllBytes(file)) != Convert.ToString(row["sha256"])) throw new Exception("必要运行资料已变化：" + name + "。请保留存档，重新取得程序。");
        }
    }
}

sealed class MainForm : Form {
    readonly Color ink = Color.FromArgb(27, 42, 61), teal = Color.FromArgb(17, 115, 123), paper = Color.FromArgb(246, 248, 251);
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly bool preview; Process backend; int port; string token, readyFile; bool busy, closing, closed;
    TabControl tabs; TextBox clientPath, version, search, mailTitle, mailMessage; Label status, recovery, feedback, limitedState, guardState; CheckBox restore; ComboBox protectedPaths;
    NumericUpDown gold, diamonds, quantity; ListView items; Button start, stop, launch, official, previous, save, gmGold, gmRecharge, gmMail, gmReset;
    string selectedItem = "", selectedName = ""; Dictionary<string, object> current;
    internal MainForm(bool render) {
        preview = render; json.MaxJsonLength = 4 * 1024 * 1024;
        Text = "Local300 · v0.12 公开测试版"; ClientSize = new Size(1020, 750); MinimumSize = new Size(980, 720); StartPosition = FormStartPosition.CenterScreen;
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Font = new Font("Microsoft YaHei UI", 10); BackColor = paper; ForeColor = ink;
        Build();if(Program.SelfTestFile!=null){ShowInTaskbar=false;Opacity=0;} Shown += async delegate { if (!preview) {await Boot();if(Program.SelfTestFile!=null)await SelfTest();} };
        FormClosing += async delegate(object sender, FormClosingEventArgs e) {
            if (closed || preview) return; e.Cancel = true; if (closing || busy) return; closing = true;
            try {
                if(port==0||backend==null||backend.HasExited){if(backend!=null&&!backend.HasExited){backend.StandardInput.Close();await Task.Run(delegate{backend.WaitForExit(20000);});}closed=true;Close();return;}
                await Run(async delegate { var result = await Call(D("operation", "quit")); if (!Okay(result)) return; ShowRestoreResult(result);if(S(result,"warning")!="")MessageBox.Show(S(result,"warning"),"请保留存档和诊断资料"); closed = true; Close(); });
            }finally{if(!closed)closing=false;}
        };
    }
    static Dictionary<string, object> D(params object[] pairs) { var d = new Dictionary<string, object>(); for (int i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1]; return d; }
    static string S(Dictionary<string, object> d, string key) { return d != null && d.ContainsKey(key) && d[key] != null ? Convert.ToString(d[key]) : ""; }
    static Dictionary<string, object> O(Dictionary<string, object> d, string key) { return d != null && d.ContainsKey(key) ? d[key] as Dictionary<string, object> : null; }
    Label LabelAt(Control parent, string text, int x, int y, int w, int h, bool heading = false) { var l = new Label { Text = text, Location = new Point(x, y), Size = new Size(w, h), ForeColor = ink, Font = new Font(Font.FontFamily, heading ? 15 : 10, heading ? FontStyle.Bold : FontStyle.Regular) }; parent.Controls.Add(l); return l; }
    Button ButtonAt(Control parent, string text, int x, int y, int w, EventHandler click, bool primary = false) { var b = new Button { Text = text, Location = new Point(x, y), Size = new Size(w, 42), FlatStyle = FlatStyle.Flat, BackColor = primary ? teal : Color.White, ForeColor = primary ? Color.White : ink, Cursor = Cursors.Hand }; b.FlatAppearance.BorderColor = primary ? teal : Color.FromArgb(213, 222, 232); b.Click += click; parent.Controls.Add(b); return b; }
    TextBox TextAt(Control parent, string value, int x, int y, int w) { var t = new TextBox { Text = value, Location = new Point(x, y), Size = new Size(w, 30), BorderStyle = BorderStyle.FixedSingle }; parent.Controls.Add(t); return t; }
    NumericUpDown NumberAt(Control parent, decimal max, decimal initial, int x, int y, int w) { var n = new NumericUpDown { Minimum = 1, Maximum = max, Value = initial, Location = new Point(x, y), Size = new Size(w, 30), ThousandsSeparator = true }; parent.Controls.Add(n); return n; }
    TabPage Page(string name) { var p = new TabPage(name) { BackColor = Color.White, Padding = new Padding(12),AutoScroll=true }; tabs.TabPages.Add(p); return p; }
    void Build() {
        LabelAt(this, "Local300", 30, 21, 280, 42, true); LabelAt(this, "v0.12 公开测试版  ·  本地独立测试", 280, 26, 600, 32);
        LabelAt(this, "免费公开，禁止销售", 30, 63, 900, 28);
        tabs = new TabControl { Location = new Point(24, 105), Size = new Size(972, 590), Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right, ItemSize = new Size(145, 36), SizeMode = TabSizeMode.Fixed }; Controls.Add(tabs);
        var home = Page("开始使用"); status = LabelAt(home, "正在准备工具…", 28, 25, 850, 40, true);
        LabelAt(home, "1 选择游戏文件夹", 28, 91, 320, 30, true);
        clientPath = TextAt(home, "", 28, 133, 690); clientPath.ReadOnly = true;
        ButtonAt(home, "选择文件夹", 732, 126, 166, async delegate { await ChooseClient(); });
        LabelAt(home, "请选择包含 300.exe 的完整客户端文件夹，建议专门复制一份用于本地测试。\n首次使用请到“客户端保护”启用禁止更新；请保留 launcher.exe 原文件名。", 28, 175, 870, 42);
        LabelAt(home, "2 启动服务，再启动游戏", 28, 219, 650, 30, true);
        start = ButtonAt(home, "启动本地服务", 28, 264, 195, async delegate { await Start(); }, true);
        launch = ButtonAt(home, "启动游戏", 237, 264, 165, async delegate { await LaunchGame(); });
        stop = ButtonAt(home, "保存并关闭服务", 417, 264, 200, async delegate { await Run(async delegate { var r = await Call(D("operation", "stop")); if (Okay(r)) { Apply(r); ShowRestoreResult(r); } }); });
        LabelAt(home, "启动游戏时，请确认 Windows 的权限提示。\n只从【十二试炼】区服登录（SESL）：账号 admin  /  密码 admin\n关闭工具前请先退出游戏；存档保存在程序旁的 Local300-data 文件夹。", 28, 327, 870, 72);
        var notice = new Panel { Location = new Point(28, 411), Size = new Size(870, 207), BackColor = paper }; home.Controls.Add(notice);
        var warning=LabelAt(notice, "当前战场可选黑岩射手和亚瑟王。亚瑟王技能尚未实现，基本都有 BUG。\n进入战场后，10 / 30 / 50 秒分别出现一名敌方假人。\n这是未完成的测试版本，可能出现任何不可预期的 BUG；请经常正常保存。", 17, 14, 825, 88);warning.ForeColor=Color.FromArgb(150,65,15);
        LabelAt(notice, "Local300 社区协作版", 17, 108, 825, 29);
        LabelAt(notice, "本软件免费公开，禁止以任何方式销售。\n如果你是付费获得本软件的，说明你被骗了。", 17, 140, 825, 52);
        var gm = Page("GM 工具"); LabelAt(gm, "给自己的本地账号发放测试内容", 25, 18, 850, 32, true);
        LabelAt(gm, "金币", 25, 70, 90, 25); gold = NumberAt(gm, 1000000000, 10000, 100, 68, 145); gmGold = ButtonAt(gm, "发放金币", 264, 61, 155, async delegate { await Gm(D("operation", "gold", "amount", (int)gold.Value)); });
        LabelAt(gm, "钻石", 445, 70, 65, 25); diamonds = NumberAt(gm, 1000000, 10, 514, 68, 136); gmRecharge = ButtonAt(gm, "模拟充值", 668, 61, 152, async delegate { await Gm(D("operation", "recharge", "diamonds", (int)diamonds.Value)); }, true);
        LabelAt(gm, "模拟充值会增加钻石、VIP 成长和积分。首充奖励需要自己到游戏界面领取。", 25, 118, 850, 30);
        search = TextAt(gm, "", 25, 166, 590); ButtonAt(gm, "搜索道具", 632, 159, 188, async delegate { await SearchItems(); });
        items = new ListView { Location = new Point(25, 210), Size = new Size(795, 168), View = View.Details, FullRowSelect = true, MultiSelect = false, HideSelection = false,ShowItemToolTips=true }; items.Columns.Add("编号", 90); items.Columns.Add("道具名称", 440); items.Columns.Add("类型", 150); gm.Controls.Add(items);
        items.SelectedIndexChanged += delegate { if (items.SelectedItems.Count == 1) { selectedItem = items.SelectedItems[0].Text; selectedName = items.SelectedItems[0].SubItems[1].Text; } };
        quantity = NumberAt(gm, 65535, 1, 670, 399, 150); LabelAt(gm, "数量", 609, 402, 60, 25);
        mailTitle = TextAt(gm, "本地测试道具", 25, 399, 260); mailMessage = TextAt(gm, "请在游戏邮件中领取附件。", 300, 399, 293);
        gmMail = ButtonAt(gm, "通过邮件发送选中道具", 25, 450, 300, async delegate { if (selectedItem == "") { MessageBox.Show("请先搜索并选中一个道具。"); return; } await Gm(D("operation", "mail", "title", mailTitle.Text, "message", mailMessage.Text, "attachments", new object[] { D("itemId", int.Parse(selectedItem), "count", (int)quantity.Value) })); }, true);
        gmReset = ButtonAt(gm, "重置首充资格", 342, 450, 190, async delegate { if (MessageBox.Show("重置后，需要再次模拟充值，才能在游戏中重新领取首充奖励。已有钻石和 VIP 进度会保留。", "重置首充", MessageBoxButtons.OKCancel) == DialogResult.OK) await Gm(D("operation", "reset-first-gift")); });
        ButtonAt(gm, "重试未确认操作", 548, 450, 180, async delegate { await Run(async delegate { Okay(await Call(D("operation", "retry-gm"))); }); });
        LabelAt(gm, "战场可选黑岩射手和亚瑟王；道具表可查询编号，领取邮件后在背包使用。", 25, 509, 850, 28);
        var limited=Page("限定神赐");LabelAt(limited,"重置限定神赐合成活动",25,24,850,36,true);
        LabelAt(limited,"原活动每月限开启一次，开启后有24小时限定合成窗口。\n这些按钮供本地测试重复使用，保留已有神赐、材料、保底和其他资产。",25,80,850,66);
        limitedState=LabelAt(limited,"启动本地服务后，可刷新查看当前开启次数和活动状态。",25,174,850,90,true);
        ButtonAt(limited,"刷新状态",25,287,170,async delegate{await Run(async delegate{await RefreshLimited();});});
        ButtonAt(limited,"重置开启次数（恢复1次）",214,287,315,async delegate{if(MessageBox.Show("恢复一次开启资格，不会自动开启或延长当前活动。请回到游戏的限定神赐界面自己点击开启。", "重置开启资格",MessageBoxButtons.OKCancel)==DialogResult.OK)await Gm(D("operation","reset-limited-godsend"));},true);
        ButtonAt(limited,"结束当前24小时活动",548,287,285,async delegate{if(MessageBox.Show("结束当前限定合成窗口，并清除限定心愿。已经拥有的神赐和材料会保留，已使用的开启次数不会返还。", "结束限定活动",MessageBoxButtons.OKCancel)==DialogResult.OK)await Gm(D("operation","close-limited-godsend"));});
        LabelAt(limited,"使用步骤\n1. 回到游戏大厅，在这里重置开启次数。\n2. 去游戏内的限定神赐合成活动界面，自己点击开启。\n3. 测试完成后，可在这里提前结束当前活动；需要再测时，重新重置一次。",25,367,850,145);
        var protection=Page("客户端保护");LabelAt(protection,"禁止专用客户端连接外网更新",25,20,870,35,true);
        LabelAt(protection,"保留完整客户端文件，不改名、不删除更新器。仅限制所选客户端的游戏及更新程序；\n允许连接本机的 Local300 服务。另一文件夹里的原服客户端不受这些规则影响。",25,72,870,62);
        guardState=LabelAt(protection,"请先选择客户端，然后刷新查看保护状态。",25,155,870,95,true);
        ButtonAt(protection,"启用禁止更新",25,273,220,async delegate{await ChangeGuard(true,clientPath.Text);},true);
        ButtonAt(protection,"撤销保护／允许联网",264,273,250,async delegate{await ChangeGuard(false,clientPath.Text);});
        ButtonAt(protection,"刷新保护状态",533,273,210,async delegate{await Run(async delegate{await RefreshGuard();});});
        LabelAt(protection,"首次启用和撤销会请求 Windows 管理员权限。请先正常退出游戏和更新器。\n保存停服、关闭工具后保护仍然保留；点击“恢复原服配置”会同时撤销本工具的保护。\n请勿关闭系统防火墙，也不要让游戏平台更新这份专用副本。",25,335,870,88);
        LabelAt(protection,"更换或移动客户端后，可在这里清理旧位置的保护：",25,451,870,28);
        protectedPaths=new ComboBox{Location=new Point(25,490),Size=new Size(615,32),DropDownStyle=ComboBoxStyle.DropDownList};protection.Controls.Add(protectedPaths);
        ButtonAt(protection,"撤销选中位置保护",657,483,230,async delegate{if(protectedPaths.SelectedItem!=null)await ChangeGuard(false,Convert.ToString(protectedPaths.SelectedItem));});
        var config = Page("设置与恢复"); LabelAt(config, "客户端配置可以还原", 25, 20, 850, 35, true);
        recovery = LabelAt(config, "尚未选择客户端。", 25, 68, 850, 78);
        restore = new CheckBox { Text = "保存并关闭服务时，恢复使用本工具前的客户端配置", Checked = true, Location = new Point(25, 158), Size = new Size(840, 30) }; config.Controls.Add(restore);
        previous = ButtonAt(config, "恢复使用前配置", 25, 211, 205, async delegate { await Restore("before-test"); });
        official = ButtonAt(config, "恢复原服配置", 249, 211, 205, async delegate { await Restore("official"); }, true);
        ButtonAt(config, "导入原版配置备份", 475, 211, 225, async delegate { await ImportBackup(); });
        LabelAt(config, "操作前请先正常退出游戏。“恢复原服配置”会撤销本工具的联网保护。\n如果客户端已更新或配置被别的软件改动，会先提示冲突，保留新配置。", 25, 279, 850, 64);
        LabelAt(config, "尝试新版客户端", 25, 367, 600, 32, true); LabelAt(config, "服务端版本号", 25, 414, 160, 30); version = TextAt(config, "8824", 193, 410, 200);
        save = ButtonAt(config, "保存设置", 417, 403, 180, async delegate { await SaveSettings(); });
        LabelAt(config, "建议保留专用客户端。修改版本号只能调整版本检查；遇到大更新仍可能出现 BUG。", 25, 469, 850, 58);
        var help = Page("使用说明"); var text = new RichTextBox { Dock = DockStyle.Fill, ReadOnly = true, BorderStyle = BorderStyle.None, BackColor = Color.White, ForeColor = ink, Font = Font, ScrollBars = RichTextBoxScrollBars.Vertical, Text = HelpText()+"\n\n限定神赐测试\n\n在限定神赐页点击重置开启次数，会恢复一次资格；请回到游戏中自己点击开启24小时活动。重置不会自动开启或延长当前窗口。提前结束会关闭当前窗口并清除限定心愿，不返还次数、不删除已有神赐和材料。可刷新查看当前次数和活动状态。" }; help.Controls.Add(text);
        feedback = LabelAt(this, "登录十二试炼区服 · 当前版本可能出现任何不可预期的 BUG", 28, 710, 950, 30); feedback.Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        if (preview) { status.Text = "本地服务已关闭"; clientPath.Text = "请选择已有的 300Hero 游戏文件夹"; recovery.Text = "修改前完整备份；保存退出后可恢复原配置。"; guardState.Text="当前客户端：尚未启用禁止更新\n启用后仍可连接本地服务；回原服可一键撤销。"; }
    }
    string HelpText() {
        const string shortGuide = "只从十二试炼（SESL）区服登录：admin / admin。\n当前战场可选黑岩射手、亚瑟王；亚瑟王技能尚未实现，基本都有 BUG。\n敌方假人在进入战场后第10、30、50秒出现。\n当前版本可能出现任何不可预期的 BUG。\n请先正常退出游戏，再保存并关闭服务。\n免费公开，禁止销售；付费获得说明被骗。";
        if (String.IsNullOrEmpty(Program.CacheRoot)) return shortGuide;
        string file = Path.Combine(Program.CacheRoot, "docs", "使用说明.txt");
        return File.Exists(file) ? File.ReadAllText(file, Encoding.UTF8) : shortGuide;
    }
    async Task Boot() {
        try {
            readyFile = Path.Combine(Program.DataRoot, "backend-" + Guid.NewGuid().ToString("N") + ".json");
            var info = new ProcessStartInfo(Path.Combine(Program.CacheRoot, "runtime", "node.exe"), Quote(Path.Combine(Program.CacheRoot, "app", "backend.js")) + " --data=" + Quote(Program.DataRoot) + " --ready=" + Quote(readyFile));
            info.WorkingDirectory = Program.CacheRoot; info.UseShellExecute = false; info.CreateNoWindow = true; info.RedirectStandardInput = true; info.RedirectStandardError = true; info.RedirectStandardOutput = true;
            foreach (string key in new List<string>(info.EnvironmentVariables.Keys.CastStrings())) if (key.StartsWith("DSH_",StringComparison.OrdinalIgnoreCase)||key.Equals("NODE_OPTIONS",StringComparison.OrdinalIgnoreCase)) info.EnvironmentVariables.Remove(key);
            backend = Process.Start(info); string errors = ""; backend.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) errors += e.Data + "\n"; }; backend.BeginErrorReadLine(); backend.BeginOutputReadLine();
            for (int i = 0; i < 240 && !File.Exists(readyFile); i++) { if (backend.HasExited) throw new Exception(errors); await Task.Delay(100); }
            if (!File.Exists(readyFile)) throw new Exception("准备时间过长，请关闭后重试。"); var ready = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(readyFile)); port = Convert.ToInt32(ready["port"]); token = S(ready, "token"); Apply(await Call(D("operation", "status")));if(Program.SelfTestFile==null)await RefreshGuard();
        } catch (Exception e) { status.Text = "工具未能就绪"; feedback.Text = e.Message; if(Program.SelfTestFile==null)MessageBox.Show(e.Message, "启动未完成"); }
    }
    static string Quote(string s) { return "\"" + s.Replace("\"", "") + "\""; }
    async Task<Dictionary<string, object>> Call(Dictionary<string, object> body) {
        if (port == 0) throw new Exception("工具尚未就绪，请稍候或重新打开。");
        return await Task.Run(delegate { var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/request"); req.Proxy = null; req.Method = "POST"; req.ContentType = "application/json; charset=utf-8"; req.Headers["X-Local300-Token"] = token; req.Timeout = 120000;
            byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(body)); req.ContentLength = bytes.Length; using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length); using (var response = req.GetResponse()) using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) return json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd()); });
    }
    async Task SelfTest(){
        try{
            string client=Path.Combine(Program.DataRoot,"synthetic-client"),config=Path.Combine(client,"Config");Directory.CreateDirectory(config);File.WriteAllBytes(Path.Combine(client,"300.exe"),new byte[]{77,90,0,0});
            byte[] original=Encoding.GetEncoding(936).GetBytes("# 测试配置\r\nnode AREA SERVER 测试-SESL original.example 30000|30001 20034\r\nnode AREA SERVER 测试-ZHJ original.example 30000|30001 20032\r\n");File.WriteAllBytes(Path.Combine(config,"serverlist.ini"),original);
            Action<Dictionary<string,object>> check=delegate(Dictionary<string,object> r){if(!r.ContainsKey("ok")||!Convert.ToBoolean(r["ok"]))throw new Exception(json.Serialize(r));};
            check(await Call(D("operation","configure","clientDirectory",client,"clientVersion",8824,"restoreOnStop",true)));check(await Call(D("operation","start")));
            var prepared=await Call(D("operation","launch"));check(prepared);var launchTarget=O(prepared,"launchTarget");if(launchTarget==null||S(launchTarget,"file")!=Path.Combine(client,"300.exe")||S(launchTarget,"cwd")!=client)throw new Exception("Native launch target handoff failed");
            var searchResult=await Call(D("operation","search-items","query","1000经验包"));check(searchResult);if(Convert.ToInt32(searchResult["total"])<1)throw new Exception("Search did not return current native items");
            check(await Call(D("operation","gm","payload",D("operation","recharge","diamonds",10,"transactionId","exe-selftest-recharge"))));
            check(await Call(D("operation","gm","payload",D("operation","reset-limited-godsend","transactionId","exe-selftest-limited-reset"))));check(await Call(D("operation","limited-status")));
            check(await Call(D("operation","stop")));if(Program.Hash(original)!=Program.Hash(File.ReadAllBytes(Path.Combine(config,"serverlist.ini"))))throw new Exception("Client routing not restored byte for byte");
            var quit=await Call(D("operation","quit"));check(quit);File.WriteAllText(Program.SelfTestFile,json.Serialize(new {ok=true,embeddedRuntime=true,nativeTcpGreeting=true,launchTargetPrepared=true,gameExecuted=false,search=true,recharge=true,limitedReset=true,normalSave=true,byteExactRestore=true}));
        }catch(Exception e){Environment.ExitCode=1;File.WriteAllText(Program.SelfTestFile,json.Serialize(new {ok=false,error=e.ToString()}));if(backend!=null&&!backend.HasExited)backend.StandardInput.Close();}
        finally{closed=true;Close();}
    }
    async Task Run(Func<Task> action) { if (busy) return; busy = true; tabs.Enabled = false; feedback.Text = "正在操作，请稍候…"; try { await action(); if (!closed) Apply(await Call(D("operation", "status"))); } catch (Exception e) { feedback.Text = e.Message; MessageBox.Show(e.Message, "操作未完成"); } finally { busy = false; tabs.Enabled = true; } }
    bool Okay(Dictionary<string, object> r) { bool ok = r.ContainsKey("ok") && Convert.ToBoolean(r["ok"]); feedback.Text = S(r, "message"); if (!ok) MessageBox.Show(S(r, "message"), "操作未完成", MessageBoxButtons.OK, MessageBoxIcon.Information); else if (feedback.Text == "") feedback.Text = "操作已完成。"; return ok; }
    void Apply(Dictionary<string, object> r) { if (!r.ContainsKey("phase")) return; current = r; bool running = Convert.ToBoolean(r["running"]); status.Text = running ? "本地服务已就绪" : S(r, "phase") == "stopped" ? "本地服务已关闭" : "本地服务状态：" + S(r, "phase"); var settings = O(r, "settings"); clientPath.Text = S(settings, "clientDirectory"); version.Text = S(settings, "clientVersion"); restore.Checked = settings.ContainsKey("restoreOnStop") && Convert.ToBoolean(settings["restoreOnStop"]); start.Enabled = !running; stop.Enabled = running; launch.Enabled = running; save.Enabled = !running;
        restore.Enabled=!running;version.Enabled=!running;var rr = O(r, "recovery"); recovery.Text = rr == null ? "尚未选择客户端。" : S(rr, "message"); }
    void ShowRestoreResult(Dictionary<string, object> r) { var rr = O(r, "restoreResult"); if (rr != null && !Convert.ToBoolean(rr["ok"])) MessageBox.Show("服务已保存关闭。\n" + S(rr, "message"), "客户端配置尚未恢复"); }
    async Task RefreshGuard() {
        string directory=clientPath.Text;
        var state=await Task.Run(delegate{return ClientUpdateGuard.Inspect(directory);});
        guardState.Text=state.Message;
        var directories=await Task.Run(delegate{return ClientUpdateGuard.ProtectedDirectories();});
        protectedPaths.Items.Clear();foreach(string p in directories)protectedPaths.Items.Add(p);if(protectedPaths.Items.Count>0)protectedPaths.SelectedIndex=0;
    }
    void EnsureClientClosed(string directory){var state=ClientUpdateGuard.RequireClosed(directory);if(!state.Ok)throw new Exception(state.Message);}
    async Task<GuardStatus> SetGuard(bool enable,string directory) {
        if(String.IsNullOrWhiteSpace(directory))throw new Exception("请先选择游戏客户端文件夹。");
        directory=Path.GetFullPath(directory);
        EnsureClientClosed(directory);
        if(enable)foreach(string name in new[]{"launcher.exe","Jump.net Launcher.exe"})if(!File.Exists(Path.Combine(directory,name))&&File.Exists(Path.Combine(directory,name+".disabled")))throw new Exception("请先把 "+name+".disabled 恢复原名 "+name+"。改名可能影响客户端启动，本工具会保留原文件。");
        var before=await Task.Run(delegate{return ClientUpdateGuard.Inspect(directory);});
        if(!before.RulesKnown)throw new Exception("保护规则尚未核对，不能确认启用或撤销。\n"+before.Message);
        if(enable&&before.Protected||!enable&&!before.HasRules)return before;
        feedback.Text=enable?"正在请求管理员权限，为这份客户端启用保护…":"正在请求管理员权限，撤销这份客户端的保护…";
        int exit=await Task.Run(delegate{
            try{
                string encoded=Convert.ToBase64String(Encoding.UTF8.GetBytes(directory));
                var info=new ProcessStartInfo(Application.ExecutablePath,"--update-guard="+(enable?"enable":"disable")+" --client64="+encoded){UseShellExecute=true,Verb="runas",WorkingDirectory=Path.GetDirectoryName(Application.ExecutablePath),WindowStyle=ProcessWindowStyle.Hidden};
                using(var helper=Process.Start(info)){if(helper==null)throw new Exception("Windows 没有启动客户端保护，请重试。");helper.WaitForExit();return helper.ExitCode;}
            }catch(System.ComponentModel.Win32Exception e){if(e.NativeErrorCode==1223)throw new Exception("你取消了 Windows 权限请求，客户端保护没有更改。");throw new Exception("Windows 未能修改客户端保护（错误 "+e.NativeErrorCode+"）。");}
        });
        var after=await Task.Run(delegate{return ClientUpdateGuard.Inspect(directory);});
        try{File.AppendAllText(Path.Combine(Program.DataRoot,"diagnostics.jsonl"),json.Serialize(D("at",DateTime.UtcNow.ToString("o"),"operation",enable?"enable-update-guard":"disable-update-guard","state",after.State,"ruleCount",after.RuleCount,"exitCode",exit))+"\n");}catch{}
        if(exit!=0||!after.RulesKnown||enable&&!after.Protected||!enable&&after.HasRules)throw new Exception("客户端保护未能确认完成。"+after.Message);
        return after;
    }
    async Task ChangeGuard(bool enable,string directory){await Run(async delegate{
        EnsureClientClosed(directory);
        if(enable&&MessageBox.Show("将限制这份客户端的游戏及更新程序连接外网，只保留连接本机。\n\n"+directory+"\n\n保护在关闭工具后仍保留；回原服时可撤销。请确认这是本地专用副本。","启用禁止更新",MessageBoxButtons.OKCancel,MessageBoxIcon.Information)!=DialogResult.OK)return;
        var result=await SetGuard(enable,directory);feedback.Text=result.Message;await RefreshGuard();
    });}
    async Task LaunchGame() {
        await Run(async delegate {
            var result=await Call(D("operation","launch"));if(!Okay(result))return;
            var target=O(result,"launchTarget");if(target==null)throw new Exception("启动资料缺失，请重新取得完整工具。");
            string directory=Path.GetFullPath(S(target,"cwd")),file=Path.GetFullPath(S(target,"file"));
            if(!file.Equals(Path.Combine(directory,"300.exe"),StringComparison.OrdinalIgnoreCase))throw new Exception("启动目标核对失败，请保留配置并反馈。");
            var protection=await Task.Run(delegate{return ClientUpdateGuard.Inspect(directory);});
            if(!protection.RulesKnown)throw new Exception("无法核对客户端保护，已暂停启动。\n"+protection.Message);
            if(protection.HasRules&&!protection.Protected)throw new Exception("客户端保护尚未完整生效，请到“客户端保护”查看后重新启用或撤销。\n"+protection.Message);
            string arguments=protection.Protected?"LauncherShellExecuteGame":"";
            feedback.Text="Windows 将请求游戏所需的管理员权限，请在权限窗口确认。";
            await Task.Run(delegate {
                try {
                    var info=new ProcessStartInfo(file,arguments){WorkingDirectory=directory,UseShellExecute=true,Verb="runas",WindowStyle=ProcessWindowStyle.Normal};
                    var process=Process.Start(info);if(process==null)throw new Exception("Windows 没有启动游戏，请查看权限提示。");process.Dispose();
                } catch(System.ComponentModel.Win32Exception error) {
                    if(error.NativeErrorCode==1223)throw new Exception("你取消了 Windows 权限请求，游戏没有启动。可再次点击启动游戏。");
                    throw new Exception("Windows 未能启动游戏（错误 "+error.NativeErrorCode+"）。请确认权限提示和客户端文件完整。");
                }
            });
            feedback.Text="游戏已直接启动，请选十二试炼区服（SESL），手动输入 admin / admin。";
        });
    }
    async Task ChooseClient() { using (var dialog = new FolderBrowserDialog { Description = "选择包含300.exe的原版游戏文件夹", ShowNewFolderButton = false }) if (dialog.ShowDialog(this) == DialogResult.OK) { clientPath.Text = dialog.SelectedPath; await SaveSettings(); } }
    async Task SaveSettings() { int n; if (!int.TryParse(version.Text, out n) || n < 1) { MessageBox.Show("请输入有效的整数版本号。"); return; } await Run(async delegate { var r = await Call(D("operation", "configure", "clientDirectory", clientPath.Text, "clientVersion", n, "restoreOnStop", restore.Checked)); if (Okay(r)){Apply(r);await RefreshGuard();} }); }
    async Task Start() { await Run(async delegate { var r = await Call(D("operation", "start")); if (S(r, "code") == "EXISTING_TEST_ROUTE" || S(r, "code") == "BASELINE_ALREADY_LOCAL") { if (MessageBox.Show(S(r, "message") + "\n是否保存当前配置并继续？它不能作为原服备份。", "当前已是本地配置", MessageBoxButtons.OKCancel) == DialogResult.OK) r = await Call(D("operation", "start", "allowExistingTestRoute", true)); } if (Okay(r)) Apply(r); }); }
    async Task Restore(string target) { await Run(async delegate {
        EnsureClientClosed(clientPath.Text);
        string policy="keep",confirmed="";var prepared=await Call(D("operation","prepare-restore","target",target));
        if(S(prepared,"code")=="RESTORE_CONFLICT"){
            if(MessageBox.Show(S(prepared,"message")+"\n是否先完整保存当前配置，再恢复备份？","恢复配置",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK)return;
            policy="backup-and-restore";confirmed=S(O(prepared,"context"),"currentSha256");prepared=await Call(D("operation","prepare-restore","target",target,"conflictPolicy",policy,"expectedCurrentSha256",confirmed));
        }
        if(!Okay(prepared))return;
        if(target=="official"){await SetGuard(false,clientPath.Text);await RefreshGuard();}
        var r=await Call(D("operation","restore","target",target,"conflictPolicy",policy,"expectedCurrentSha256",confirmed,"preparedCurrentSha256",S(O(prepared,"context"),"currentSha256"),"preparedTargetSha256",S(O(prepared,"context"),"targetSha256")));
        if(target=="official"&&(!r.ContainsKey("ok")||!Convert.ToBoolean(r["ok"])))r["message"]="联网保护已撤销，但原服连接配置尚未恢复。\n"+S(r,"message");Okay(r);
    }); }
    async Task ImportBackup() { using (var dialog = new OpenFileDialog { Title = "选择可信的原版serverlist.ini配置备份", Filter = "配置备份|*.ini;*.bak;*.bin|所有文件|*.*" }) if (dialog.ShowDialog(this) == DialogResult.OK) { if (MessageBox.Show("只有你确认来自原版客户端的完整配置才能作为原服备份。请选择正确备份后继续。", "导入原版配置", MessageBoxButtons.OKCancel) == DialogResult.OK) await Run(async delegate { Okay(await Call(D("operation", "import-official", "backupFile", dialog.FileName))); }); } }
    async Task SearchItems() { await Run(async delegate { var r = await Call(D("operation", "search-items", "query", search.Text)); if (!Okay(r)) return; items.Items.Clear(); selectedItem = ""; var rows = r["items"] as System.Collections.IEnumerable; if (rows != null) foreach (var value in rows) { var row = value as Dictionary<string, object>; var item = new ListViewItem(S(row, "id")); item.SubItems.Add(S(row, "name")); string type=S(row,"type"),use=S(row,"use");item.SubItems.Add(use=="experience"?"经验道具":use=="hero-skin-gift"?"英雄／皮肤礼包":type=="weapon"?"武器":type=="armour"?"护甲":type=="treasure"?"饰品":type=="gem"?"宝石":type=="restore"?"礼包":"道具");item.ToolTipText=S(row,"description");items.Items.Add(item); } feedback.Text = "搜索到 " + S(r, "total") + " 个结果，显示前100个。"; }); }
    async Task RefreshLimited(){var r=await Call(D("operation","limited-status"));if(!Okay(r))return;var state=O(r,"result");bool active=Convert.ToBoolean(state["active"]);string expiry=active?new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).AddMilliseconds(Convert.ToDouble(state["expiresAt"])).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss"):"未开启";limitedState.Text="当前可开启次数："+S(state,"remaining")+"次\n活动状态："+(active?"已开启，截止 "+expiry:"已关闭");}
    async Task Gm(Dictionary<string, object> payload) { payload["transactionId"] = Guid.NewGuid().ToString(); await Run(async delegate { var r = await Call(D("operation", "gm", "payload", payload)); if (Okay(r)) { feedback.Text = S(payload, "operation") == "mail" ? "邮件已发出，请在游戏里领取附件。" : "操作已完成，请到游戏中查看。";if(S(payload,"operation").Contains("limited-godsend"))await RefreshLimited(); } }); }
}
static class StringCollectionHelpers { internal static IEnumerable<string> CastStrings(this System.Collections.ICollection values) { foreach (object v in values) yield return Convert.ToString(v); } }
