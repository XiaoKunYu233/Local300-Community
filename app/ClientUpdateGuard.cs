using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;

public sealed class GuardPolicyInfo {
    public bool DomainEnabled, PrivateEnabled, PublicEnabled;
    public int ActiveProfiles, LocalPolicyModifyState;
    public bool Healthy { get { return DomainEnabled && PrivateEnabled && PublicEnabled && LocalPolicyModifyState == 0; } }
}
public sealed class GuardStatus {
    public bool Ok, HasRules, Protected, Uncertain, RulesKnown;
    public string State = "unknown", Message = "保护状态尚未核对。", Code = "UNKNOWN", Directory = "";
    public int RuleCount = -1, ExpectedCount;
    public string[] Programs = new string[0], Details = new string[0];
    public GuardPolicyInfo Policy;
}

// This class never launches a process, executes a script, writes a result path,
// or changes global firewall settings. The WinForms host elevates this same EXE
// only for Enable/Disable; Inspect and RequireClosed do not require elevation.
public static class ClientUpdateGuard {
    internal static readonly string[] ProgramNames = { "300.exe", "launcher.exe", "Jump.net Launcher.exe" };
    internal const string Group = "Local300.UpdateGuard.v1";
    internal const string Owner = "Local300-owned-update-guard:v1";
    internal const string IPv4Remote = "0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255";
    internal const string IPv6Remote = "::,::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff";

    public static GuardStatus Inspect(string directory) {
        string root = "";
        try {
            root = NormalizeDirectory(directory, false);
            GuardClient client = InspectFiles(root, false);
            using (var policy = new ComGuardPolicy()) return new GuardEngine(policy, client).Inspect();
        } catch (Exception error) { return Failure(error, root); }
    }
    public static GuardStatus RequireClosed(string directory) {
        string root = "";
        try {
            root = NormalizeDirectory(directory, false); CheckClosed(root);
            return new GuardStatus { Ok = true, State = "closed", Code = "CLIENT_CLOSED", Directory = root, Message = "所选客户端和更新器均已关闭。" };
        } catch (Exception error) { return Failure(error, root); }
    }
    public static GuardStatus Enable(string directory) { return Change(directory, true); }
    public static GuardStatus Disable(string directory) { return Change(directory, false); }
    public static string[] ProtectedDirectories() {
        try {
            var directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (var policy = new ComGuardPolicy()) foreach (GuardRule row in policy.ReadRules()) {
                try {
                    string root = NormalizeDirectory(Path.GetDirectoryName(row.ApplicationName), false);
                    if (Specs(root, ProgramNames).Any(spec => row.Same(spec, false))) directories.Add(root);
                } catch (GuardError) { }
                  catch (ArgumentException) { }
            }
            return directories.OrderBy(value => value, StringComparer.OrdinalIgnoreCase).ToArray();
        } catch (Exception error) { throw new GuardError("FIREWALL_UNAVAILABLE", "无法核对旧路径保护，请检查 Windows 防火墙服务后重试。" + (error is GuardError ? " " + error.Message : "")); }
    }
    static GuardStatus Change(string directory, bool enable) {
        string root = "";
        try {
            root = NormalizeDirectory(directory, enable);
            if (!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
                throw new GuardError("ADMIN_REQUIRED", "请在 Windows 权限提示中允许本次操作。");
            using (var mutex = new Mutex(false, "Global\\Local300.UpdateGuard.v1." + HashRoot(root))) {
                bool locked = false;
                try {
                    try { locked = mutex.WaitOne(0); } catch (AbandonedMutexException) { locked = true; }
                    if (!locked) throw new GuardError("OPERATION_BUSY", "另一次客户端保护操作正在进行，请稍后重试。");
                    CheckClosed(root);
                    // Missing files are allowed on removal: old exact-path
                    // rules must remain removable after moving/deleting a copy.
                    GuardClient client = enable ? InspectFiles(root, true) : new GuardClient(root, new string[0], false);
                    using (var policy = new ComGuardPolicy()) return enable ? new GuardEngine(policy, client).Enable() : new GuardEngine(policy, client).Disable();
                } finally { if (locked) mutex.ReleaseMutex(); }
            }
        } catch (Exception error) { return Failure(error, root); }
    }
    internal static GuardStatus Failure(Exception error, string root) {
        GuardError known = error as GuardError;
        string code = known == null ? "FIREWALL_UNAVAILABLE" : known.Code;
        string message = known == null ? "无法核对 Windows 防火墙。请保留现有设置，检查系统防火墙服务后重试。" : known.Message;
        return new GuardStatus { Ok = false, State = code == "CLIENT_RUNNING" || code == "PROCESS_UNKNOWN" ? "busy" : code == "RULE_CONFLICT" ? "conflict" : "unavailable", Code = code, Message = message, Directory = root, Details = new[] { error.GetType().Name + ": " + error.Message } };
    }
    internal static string NormalizeDirectory(string directory, bool requireExisting) {
        if (String.IsNullOrEmpty(directory) || directory.Length > 4096 || directory.Length < 3 || !Char.IsLetter(directory[0]) || directory[1] != ':' || (directory[2] != '\\' && directory[2] != '/'))
            throw new GuardError("UNSAFE_PATH", "请选择本机磁盘上的完整游戏文件夹路径，不能使用网络路径。");
        foreach (char c in directory) if (c < 32 || c == '"' || c == '*' || c == '?' || c == '<' || c == '>' || c == '|')
            throw new GuardError("UNSAFE_PATH", "客户端路径包含不支持的字符，未修改保护。");
        if (directory.Substring(2).Contains(":")) throw new GuardError("UNSAFE_PATH", "客户端路径格式不正确，未修改保护。");
        string normalized = directory.Replace('/', '\\');
        foreach (string part in normalized.Substring(3).Split('\\')) if (part == "." || part == ".." || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal))
            throw new GuardError("UNSAFE_PATH", "请选择正常的完整文件夹路径，不能包含转向或省略片段。");
        string root = Path.GetFullPath(normalized);
        while (root.Length > 3 && root.EndsWith("\\", StringComparison.Ordinal)) root = root.Substring(0, root.Length - 1);
        new UTF8Encoding(false, true).GetBytes(root);
        CheckAncestors(root, requireExisting);
        return ExpandExistingPrefix(root).ToLowerInvariant();
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetLongPathName(string shortPath, StringBuilder longPath, uint length);
    static string ExpandExistingPrefix(string root) {
        var missing = new Stack<string>(); string prefix = root;
        while (!System.IO.Directory.Exists(prefix)) {
            missing.Push(Path.GetFileName(prefix)); string parent = Path.GetDirectoryName(prefix);
            if (String.IsNullOrEmpty(parent) || parent == prefix) throw new GuardError("UNSAFE_PATH", "无法核对客户端的本机磁盘路径。");
            prefix = parent;
        }
        var buffer = new StringBuilder(32768); uint length = GetLongPathName(prefix, buffer, (uint)buffer.Capacity);
        if (length == 0 || length >= buffer.Capacity) throw new GuardError("UNSAFE_PATH", "无法核对客户端的完整路径，未修改保护。");
        string result = buffer.ToString(); while (missing.Count > 0) result = Path.Combine(result, missing.Pop()); return result;
    }
    static void CheckAncestors(string fullPath, bool requireExisting) {
        string current = Path.GetPathRoot(fullPath);
        var parts = fullPath.Substring(current.Length).Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
        CheckDirectoryComponent(current, true);
        bool missing = false;
        foreach (string part in parts) {
            current = Path.Combine(current, part);
            if (!missing) missing = !CheckDirectoryComponent(current, false);
        }
        if (missing && requireExisting) throw new GuardError("CLIENT_MISSING", "找不到所选客户端文件夹，请重新选择完整客户端。");
    }
    static bool CheckDirectoryComponent(string path, bool required) {
        FileAttributes attributes;
        try { attributes = File.GetAttributes(path); }
        catch (FileNotFoundException) { if (!required) return false; throw; }
        catch (DirectoryNotFoundException) { if (!required) return false; throw; }
        if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0)
            throw new GuardError("UNSAFE_PATH", "客户端路径存在链接或转向，未修改保护。请选择普通本地文件夹。");
        return true;
    }
    static bool PlainFile(string file, bool required, bool executable) {
        FileAttributes attributes;
        try { attributes = File.GetAttributes(file); }
        catch (FileNotFoundException) { if (!required) return false; throw new GuardError("CLIENT_INCOMPLETE", "缺少完整客户端文件，请重新选择原版游戏文件夹。"); }
        catch (DirectoryNotFoundException) { if (!required) return false; throw new GuardError("CLIENT_INCOMPLETE", "缺少完整客户端文件，请重新选择原版游戏文件夹。"); }
        if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) throw new GuardError("UNSAFE_PATH", "客户端文件存在链接或类型异常，未修改保护。");
        if (executable) using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
            if (stream.ReadByte() != 'M' || stream.ReadByte() != 'Z') throw new GuardError("CLIENT_INCOMPLETE", "客户端程序格式异常，请使用完整原版客户端。");
        }
        return true;
    }
    static GuardClient InspectFiles(string root, bool required) {
        var programs = new List<string>();
        foreach (string name in ProgramNames) if (PlainFile(Path.Combine(root, name), required && name == "300.exe", true)) programs.Add(name);
        bool complete = programs.Contains("300.exe");
        if (required) {
            CheckAncestors(Path.Combine(root, "Config"), true);
            PlainFile(Path.Combine(root, "Config", "serverlist.ini"), true, false);
        }
        return new GuardClient(root, programs.ToArray(), complete);
    }
    static void CheckClosed(string root) {
        foreach (string name in ProgramNames) {
            Process[] processes;
            try { processes = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(name)); }
            catch { throw new GuardError("PROCESS_UNKNOWN", "无法核对客户端运行状态，请正常关闭游戏和更新器后重试。"); }
            foreach (Process process in processes) using (process) {
                string file;
                try {
                    if (process.HasExited) continue;
                    file = process.MainModule.FileName;
                    if (String.IsNullOrEmpty(file)) throw new InvalidOperationException();
                } catch {
                    try { if (process.HasExited) continue; } catch { }
                    throw new GuardError("PROCESS_UNKNOWN", "有同名游戏或更新器进程无法核对路径，请正常关闭后重试。");
                }
                if (String.Equals(Path.GetFullPath(file).TrimEnd('\\'), Path.Combine(root, name), StringComparison.OrdinalIgnoreCase))
                    throw new GuardError("CLIENT_RUNNING", "请先正常退出所选客户端及其更新器，再修改保护或恢复原服。");
            }
        }
    }
    internal static string HashRoot(string root) {
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(new UTF8Encoding(false, true).GetBytes(root.ToLowerInvariant()))).Replace("-", "").ToLowerInvariant();
    }
    internal static GuardRule[] Specs(string root, IEnumerable<string> programs) {
        var rows = new List<GuardRule>();
        foreach (string name in programs) {
            int index = Array.IndexOf(ProgramNames, name);
            if (index < 0) throw new GuardError("UNSAFE_PROGRAM", "保护目标不在本软件支持的程序列表中。");
            foreach (string family in new[] { "v4", "v6" }) rows.Add(new GuardRule {
                Name = Group + "." + HashRoot(root) + ".p" + index + "." + family,
                Description = Owner + "\nRoot=" + root.ToLowerInvariant() + "\nProgram=" + name.ToLowerInvariant() + "\nFamily=" + family,
                Grouping = Group, ApplicationName = Path.Combine(root, name).ToLowerInvariant(), Direction = 2, Action = 0, Profiles = 7, Protocol = 256,
                Enabled = true, LocalAddresses = "*", RemoteAddresses = family == "v4" ? IPv4Remote : IPv6Remote, InterfaceTypes = "All"
            });
        }
        return rows.ToArray();
    }
}

internal sealed class GuardError : Exception {
    internal readonly string Code;
    internal GuardError(string code, string message) : base(message) { Code = code; }
}
internal sealed class GuardClient {
    internal readonly string Root;
    internal readonly string[] Programs;
    internal readonly bool Complete;
    internal GuardClient(string root, string[] programs, bool complete) { Root = root; Programs = programs; Complete = complete; }
}
internal sealed class GuardRule {
    internal string Name = "", Description = "", Grouping = "", ApplicationName = "", ServiceName = "", LocalAddresses = "*", RemoteAddresses = "", LocalPorts = "", RemotePorts = "", InterfaceTypes = "All", Interfaces = "";
    internal int Direction, Action, Profiles, Protocol;
    internal bool Enabled, EdgeTraversal;
    internal GuardRule Copy() { return (GuardRule)MemberwiseClone(); }
    static string Text(string value) { return value ?? ""; }
    static string Any(string value) { return String.IsNullOrEmpty(value) || value == "*" ? "*" : value; }
    static string Addresses(string value) {
        return String.Join(",", Text(value).Split(',').Select(token => {
            string text = token.Trim(); string[] range = text.Split('-');
            if (range.Length == 1) {
                IPAddress single;
                if(IPAddress.TryParse(text,out single))return single.ToString().ToLowerInvariant();
                string[] prefix=text.Split('/');int bits;
                if(prefix.Length==2&&IPAddress.TryParse(prefix[0],out single)&&Int32.TryParse(prefix[1],out bits)&&bits==single.GetAddressBytes().Length*8)return single.ToString().ToLowerInvariant();
                return text.ToLowerInvariant();
            }
            if (range.Length == 2) { IPAddress start, end; if (IPAddress.TryParse(range[0].Trim(), out start) && IPAddress.TryParse(range[1].Trim(), out end)) return start.Equals(end)?start.ToString().ToLowerInvariant():start.ToString().ToLowerInvariant() + "-" + end.ToString().ToLowerInvariant(); }
            return text.ToLowerInvariant();
        }).OrderBy(token => token, StringComparer.Ordinal));
    }
    internal bool Same(GuardRule other, bool enabled) {
        return other != null && Name == other.Name && Description == other.Description && Grouping == other.Grouping &&
            String.Equals(ApplicationName, other.ApplicationName, StringComparison.OrdinalIgnoreCase) && Text(ServiceName) == Text(other.ServiceName) &&
            Direction == other.Direction && Action == other.Action && (Profiles == Int32.MaxValue ? 7 : Profiles) == (other.Profiles == Int32.MaxValue ? 7 : other.Profiles) && Protocol == other.Protocol &&
            (!enabled || Enabled == other.Enabled) && EdgeTraversal == other.EdgeTraversal && Any(LocalAddresses) == Any(other.LocalAddresses) &&
            Addresses(RemoteAddresses) == Addresses(other.RemoteAddresses) && Any(LocalPorts) == Any(other.LocalPorts) && Any(RemotePorts) == Any(other.RemotePorts) &&
            String.Equals(InterfaceTypes, other.InterfaceTypes, StringComparison.OrdinalIgnoreCase) && Text(Interfaces) == Text(other.Interfaces);
    }
}
internal interface IGuardPolicy {
    List<GuardRule> ReadRules();
    GuardPolicyInfo ReadPolicy();
    void Add(GuardRule rule);
    void Remove(GuardRule expected);
}

internal sealed class GuardEngine {
    readonly IGuardPolicy policy;
    readonly GuardClient client;
    readonly GuardRule[] catalog, expected;
    internal GuardEngine(IGuardPolicy policy, GuardClient client) {
        this.policy = policy; this.client = client;
        catalog = ClientUpdateGuard.Specs(client.Root, ClientUpdateGuard.ProgramNames); expected = ClientUpdateGuard.Specs(client.Root, client.Programs);
    }
    Dictionary<string, GuardRule> Managed() {
        var names = new HashSet<string>(catalog.Select(r => r.Name), StringComparer.OrdinalIgnoreCase);
        var rows = new Dictionary<string, GuardRule>(StringComparer.OrdinalIgnoreCase);
        foreach (GuardRule row in policy.ReadRules()) if (names.Contains(row.Name)) {
            if (rows.ContainsKey(row.Name)) throw new GuardError("RULE_CONFLICT", "保护规则名称发生冲突，未修改现有规则。请核对防火墙后重试。");
            rows.Add(row.Name, row.Copy());
        }
        return rows;
    }
    void Validate(Dictionary<string, GuardRule> rows) {
        foreach (GuardRule row in rows.Values) if (!row.Same(catalog.First(spec => String.Equals(spec.Name, row.Name, StringComparison.OrdinalIgnoreCase)), false))
            throw new GuardError("RULE_CONFLICT", "发现同名但内容不属于本软件的规则，未覆盖或删除。请先人工核对防火墙规则。");
    }
    GuardStatus Status(Dictionary<string, GuardRule> rows, GuardPolicyInfo health) {
        Validate(rows);
        bool complete = client.Complete && expected.Length > 0 && expected.All(spec => rows.ContainsKey(spec.Name) && rows[spec.Name].Enabled);
        var status = new GuardStatus { Ok = true, Directory = client.Root, RuleCount = rows.Count, ExpectedCount = expected.Length, HasRules = rows.Count > 0, RulesKnown = true, Programs = client.Programs, Policy = health };
        status.Protected = complete && health.Healthy;
        status.State = status.Protected ? "protected" : rows.Count == 0 ? "disabled" : !client.Complete ? "orphaned" : "partial";
        status.Code = status.Protected ? "PROTECTED" : rows.Count == 0 ? "NO_RULES" : "PARTIAL_RULES";
        status.Message = status.Protected ? "所选客户端的外网保护已启用，本地连接保留。" : rows.Count == 0 ? "客户端外网保护尚未启用。" : !client.Complete ? "客户端路径已变化，旧保护规则仍保留，可以撤销。" : "保护规则不完整或已停用，请先撤销，再重新启用。";
        if (!health.Healthy) {
            status.State = "unavailable"; status.Code = "POLICY_INACTIVE";
            var detail = new List<string>();
            if (!health.DomainEnabled) detail.Add("域网络防火墙关闭");
            if (!health.PrivateEnabled) detail.Add("专用网络防火墙关闭");
            if (!health.PublicEnabled) detail.Add("公用网络防火墙关闭");
            if (health.LocalPolicyModifyState != 0) detail.Add("系统策略限制本地规则（" + health.LocalPolicyModifyState + "）");
            status.Details = detail.ToArray(); status.Message = "保护未生效：" + String.Join("；", detail) + "。本工具不会改变系统全局防火墙设置。";
        }
        return status;
    }
    internal GuardStatus Inspect() {
        Dictionary<string, GuardRule> rows = null;
        try { rows = Managed(); return Status(rows, policy.ReadPolicy()); }
        catch (Exception error) { return ErrorStatus(error, rows, false); }
    }
    GuardStatus ErrorStatus(Exception error, Dictionary<string, GuardRule> rows, bool uncertain) {
        GuardStatus status = ClientUpdateGuard.Failure(error, client.Root);
        status.Programs = client.Programs; status.ExpectedCount = expected.Length;
        if (rows != null) { status.RuleCount = rows.Count; status.HasRules = rows.Count > 0; status.RulesKnown = true; }
        status.Uncertain = uncertain;
        if (uncertain) { status.State = "uncertain"; status.Code = "ROLLBACK_UNCERTAIN"; status.Message = "本次操作未完成，规则恢复尚未确认。请刷新核对并重试撤销，不要继续恢复原服。"; }
        return status;
    }
    static bool SnapshotSame(Dictionary<string, GuardRule> left, Dictionary<string, GuardRule> right) {
        return left.Count == right.Count && left.All(pair => right.ContainsKey(pair.Key) && pair.Value.Same(right[pair.Key], true));
    }
    internal GuardStatus Enable() {
        Dictionary<string, GuardRule> before = null;
        bool mutationStarted = false;
        try {
            before = Managed(); Validate(before);
            GuardPolicyInfo health = policy.ReadPolicy();
            if (!health.Healthy) { GuardStatus inactive = Status(before, health); inactive.Ok = false; return inactive; }
            if (!client.Complete || expected.Length == 0) throw new GuardError("CLIENT_INCOMPLETE", "请先选择完整原版客户端，再启用保护。");
            if (before.Values.Any(row => !row.Enabled)) throw new GuardError("RULE_DISABLED", "已有保护规则被停用，请先点击撤销保护，再重新启用。");
            foreach (GuardRule spec in expected) if (!before.ContainsKey(spec.Name)) { mutationStarted = true; policy.Add(spec.Copy()); }
            GuardStatus after = Inspect();
            if (!after.Protected) throw new GuardError("VERIFY_FAILED", "保护规则写入后的核对未通过。");
            return after;
        } catch (Exception error) {
            bool uncertain = false;
            if (mutationStarted && before != null) {
                // Include an Add that threw after applying: remove only an
                // absent-before, exact owned specification; never touch baseline.
                foreach (GuardRule spec in expected.Where(row => !before.ContainsKey(row.Name)).Reverse()) try {
                    Dictionary<string, GuardRule> current = Managed(); GuardRule row;
                    if (current.TryGetValue(spec.Name, out row)) { if (!row.Same(spec, true)) { uncertain = true; continue; } policy.Remove(row); }
                } catch { uncertain = true; }
                try { uncertain = !SnapshotSame(before, Managed()); } catch { uncertain = true; }
            }
            Dictionary<string, GuardRule> now = null; try { now = Managed(); } catch { if (mutationStarted) uncertain = true; }
            return ErrorStatus(error, now, uncertain);
        }
    }
    internal GuardStatus Disable() {
        Dictionary<string, GuardRule> before = null;
        bool mutationStarted = false;
        try {
            before = Managed(); Validate(before);
            foreach (GuardRule row in before.Values) { mutationStarted = true; policy.Remove(row); }
            Dictionary<string, GuardRule> remaining = Managed();
            if (remaining.Count != 0) throw new GuardError("VERIFY_FAILED", "撤销后的规则核对未通过。");
            return new GuardStatus { Ok = true, State = "disabled", Code = "DISABLED", Message = "本软件的客户端保护规则已撤销。", Directory = client.Root, RuleCount = 0, ExpectedCount = expected.Length, RulesKnown = true, Programs = client.Programs };
        } catch (Exception error) {
            bool uncertain = false;
            if (mutationStarted && before != null) {
                foreach (GuardRule original in before.Values) try {
                    Dictionary<string, GuardRule> current = Managed(); GuardRule row;
                    if (!current.TryGetValue(original.Name, out row)) policy.Add(original.Copy());
                    else if (!row.Same(original, true)) uncertain = true;
                } catch { uncertain = true; }
                try { uncertain = !SnapshotSame(before, Managed()); } catch { uncertain = true; }
            }
            Dictionary<string, GuardRule> now = null; try { now = Managed(); } catch { if (mutationStarted) uncertain = true; }
            return ErrorStatus(error, now, uncertain);
        }
    }
}

internal sealed class ComGuardPolicy : IGuardPolicy, IDisposable {
    readonly object policyObject, rulesObject;
    readonly dynamic policy, rules;
    internal ComGuardPolicy() {
        Type type = Type.GetTypeFromProgID("HNetCfg.FwPolicy2", true);
        policyObject = Activator.CreateInstance(type); policy = policyObject;
        try { rulesObject = policy.Rules; rules = rulesObject; }
        catch { Release(policyObject); throw; }
    }
    public GuardPolicyInfo ReadPolicy() {
        return new GuardPolicyInfo { DomainEnabled = (bool)policy.FirewallEnabled[1], PrivateEnabled = (bool)policy.FirewallEnabled[2], PublicEnabled = (bool)policy.FirewallEnabled[4], ActiveProfiles = (int)policy.CurrentProfileTypes, LocalPolicyModifyState = (int)policy.LocalPolicyModifyState };
    }
    public List<GuardRule> ReadRules() {
        var result = new List<GuardRule>();
        foreach (object item in (IEnumerable)rulesObject) {
            try {
                dynamic rule = item;
                string name = (string)rule.Name;
                // Other applications' rules are neither interpreted nor changed.
                // The engine selects the exact six names for its selected path.
                if (String.IsNullOrEmpty(name) || !name.StartsWith(ClientUpdateGuard.Group + ".", StringComparison.OrdinalIgnoreCase)) continue;
                int protocol = (int)rule.Protocol;
                object interfaces = rule.Interfaces;
                string interfaceText = interfaces == null ? "" : interfaces is Array ? String.Join(",", ((Array)interfaces).Cast<object>().Select(value => Convert.ToString(value)).OrderBy(value => value, StringComparer.Ordinal)) : Convert.ToString(interfaces);
                result.Add(new GuardRule { Name = name, Description = (string)rule.Description, Grouping = (string)rule.Grouping, ApplicationName = (string)rule.ApplicationName, ServiceName = (string)rule.ServiceName, Direction = (int)rule.Direction, Action = (int)rule.Action, Profiles = (int)rule.Profiles, Protocol = protocol, Enabled = (bool)rule.Enabled, EdgeTraversal = (bool)rule.EdgeTraversal, LocalAddresses = (string)rule.LocalAddresses, RemoteAddresses = (string)rule.RemoteAddresses, LocalPorts = protocol == 6 || protocol == 17 ? (string)rule.LocalPorts : "", RemotePorts = protocol == 6 || protocol == 17 ? (string)rule.RemotePorts : "", InterfaceTypes = (string)rule.InterfaceTypes, Interfaces = interfaceText });
            } finally { Release(item); }
        }
        return result;
    }
    public void Add(GuardRule spec) {
        // INetFwRules.Add overwrites equal identifiers. Reject any existing name
        // before calling it, including on rollback; never use Add as an update.
        if (ReadRules().Any(row => String.Equals(row.Name, spec.Name, StringComparison.OrdinalIgnoreCase))) throw new GuardError("RULE_CONFLICT", "保护规则名称发生冲突，未覆盖现有规则。");
        object instance = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FWRule", true));
        try {
            dynamic rule = instance;
            rule.Name = spec.Name; rule.Description = spec.Description; rule.Grouping = spec.Grouping;
            rule.ApplicationName = spec.ApplicationName; rule.Protocol = spec.Protocol;
            rule.Direction = spec.Direction; rule.Action = spec.Action; rule.Profiles = spec.Profiles;
            rule.LocalAddresses = String.IsNullOrEmpty(spec.LocalAddresses) ? "*" : spec.LocalAddresses; rule.RemoteAddresses = spec.RemoteAddresses;
            rule.InterfaceTypes = spec.InterfaceTypes; rule.EdgeTraversal = spec.EdgeTraversal;
            rule.Enabled = spec.Enabled;
            rules.Add(rule);
        } finally { Release(instance); }
    }
    public void Remove(GuardRule expected) {
        string name = expected.Name;
        List<GuardRule> found = ReadRules().Where(row => String.Equals(row.Name, name, StringComparison.OrdinalIgnoreCase)).ToList();
        if (found.Count == 0) return;
        if (found.Count != 1 || !found[0].Same(expected, true)) throw new GuardError("RULE_CONFLICT", "保护规则在操作期间发生变化，未删除规则。");
        rules.Remove(name);
    }
    static void Release(object instance) { if (instance != null && Marshal.IsComObject(instance)) Marshal.ReleaseComObject(instance); }
    public void Dispose() { Release(rulesObject); Release(policyObject); }
}
