using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;

// Pure fake-policy checks. No HNetCfg object is constructed by this executable.
internal sealed class FakeGuardPolicy : IGuardPolicy {
    internal List<GuardRule> Rules = new List<GuardRule>();
    internal GuardPolicyInfo Health = new GuardPolicyInfo { DomainEnabled = true, PrivateEnabled = true, PublicEnabled = true };
    internal int Adds, Removes, FailAddAt, FailRemoveAt;
    internal bool ThrowAfterAdd, ThrowAfterRemove, FailRollbackAdd;
    public List<GuardRule> ReadRules() { return Rules.Select(row => row.Copy()).ToList(); }
    public GuardPolicyInfo ReadPolicy() { return Health; }
    public void Add(GuardRule rule) {
        Adds++;
        if (Rules.Any(row => row.Name == rule.Name)) throw new Exception("attempted replacement");
        if ((FailAddAt == Adds || (FailRollbackAdd && Removes > 0)) && !ThrowAfterAdd) throw new Exception("injected add failure");
        Rules.Add(rule.Copy());
        if (FailAddAt == Adds && ThrowAfterAdd) throw new Exception("injected post-add failure");
    }
    public void Remove(GuardRule expected) {
        Removes++;
        GuardRule found = Rules.FirstOrDefault(row => row.Name == expected.Name);
        if (found != null && !found.Same(expected, true)) throw new Exception("changed rule must not be removed");
        if (FailRemoveAt == Removes && !ThrowAfterRemove) throw new Exception("injected remove failure");
        Rules.RemoveAll(row => row.Name == expected.Name);
        if (FailRemoveAt == Removes && ThrowAfterRemove) throw new Exception("injected post-remove failure");
    }
}
internal static class ClientUpdateGuardTests {
    static int count;
    const string Root = @"e:\local-test\完整客户端";
    static GuardClient Client() { return new GuardClient(Root, ClientUpdateGuard.ProgramNames, true); }
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static void Test(string name, Action body) { body(); count++; Console.WriteLine("PASS " + name); }
    static GuardRule Foreign() { return new GuardRule { Name = "OtherVendor", Description = "keep", ApplicationName = @"c:\elsewhere\app.exe", Enabled = true }; }
    static bool EqualRules(List<GuardRule> a, List<GuardRule> b) { return a.Count == b.Count && a.All(row => b.Any(other => row.Same(other, true))); }
    static bool InRanges(string address, string ranges) {
        byte[] value = IPAddress.Parse(address).GetAddressBytes();
        foreach (string token in ranges.Split(',')) {
            string[] endpoints = token.Split('-'); byte[] low = IPAddress.Parse(endpoints[0]).GetAddressBytes(), high = IPAddress.Parse(endpoints.Length == 1 ? endpoints[0] : endpoints[1]).GetAddressBytes();
            if (value.Length == low.Length && Compare(value, low) >= 0 && Compare(value, high) <= 0) return true;
        }
        return false;
    }
    static int Compare(byte[] a, byte[] b) { for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return a[i].CompareTo(b[i]); return 0; }
    static void Main() {
        Test("Windows canonical single-address range and full prefix retain exact ownership scope",delegate{
            var expected=ClientUpdateGuard.Specs(Root,new[]{"300.exe"})[1];var actual=expected.Copy();
            actual.RemoteAddresses="::-::,::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff";Check(actual.Same(expected,true),"Windows COM getter canonicalizes :: as ::-::");
            actual.RemoteAddresses="::/128,::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff";Check(actual.Same(expected,true),"single address prefix equivalent");
            actual.RemoteAddresses="::/127,::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff";Check(!actual.Same(expected,true),"broader prefix still refused");
        });
        Test("remote scopes exclude every IPv4 loopback and IPv6 loopback", delegate {
            foreach (string ip in new[] { "127.0.0.0", "127.0.0.1", "127.128.4.9", "127.255.255.255" }) Check(!InRanges(ip, ClientUpdateGuard.IPv4Remote), ip);
            foreach (string ip in new[] { "0.0.0.0", "1.1.1.1", "126.255.255.255", "128.0.0.0", "192.168.1.1", "255.255.255.255" }) Check(InRanges(ip, ClientUpdateGuard.IPv4Remote), ip);
            Check(!InRanges("::1", ClientUpdateGuard.IPv6Remote), "IPv6 loopback");
            foreach (string ip in new[] { "::", "::2", "2001:db8::1", "fe80::1", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" }) Check(InRanges(ip, ClientUpdateGuard.IPv6Remote), ip);
        });
        Test("six deterministic exact-path owned specifications and no arbitrary program", delegate {
            GuardRule[] rows = ClientUpdateGuard.Specs(Root, ClientUpdateGuard.ProgramNames); Check(rows.Length == 6 && rows.Select(r => r.Name).Distinct().Count() == 6, "six unique rules");
            Check(rows.All(row => row.Direction == 2 && row.Action == 0 && row.Protocol == 256 && row.Profiles == 7), "outbound-only complete scope");
            Check(rows.All(row => row.Grouping == ClientUpdateGuard.Group && row.ApplicationName.StartsWith(Root + "\\", StringComparison.OrdinalIgnoreCase)), "owner and exact directory");
            Check(ClientUpdateGuard.Specs(Root.ToUpperInvariant(), ClientUpdateGuard.ProgramNames)[0].Name == rows[0].Name, "case-stable identifier");
            bool rejected = false; try { ClientUpdateGuard.Specs(Root, new[] { "powershell.exe" }); } catch (GuardError) { rejected = true; } Check(rejected, "arbitrary executable rejected");
        });
        Test("enable and disable preserve unrelated rules and enable is idempotent", delegate {
            var policy = new FakeGuardPolicy(); GuardRule foreign = Foreign(); policy.Rules.Add(foreign.Copy()); var engine = new GuardEngine(policy, Client());
            GuardStatus first = engine.Enable(); Check(first.Ok && first.Protected && first.RuleCount == 6, "enabled"); Check(policy.Adds == 6, "created six");
            Check(engine.Enable().Protected && policy.Adds == 6, "no replacement on repeat"); Check(engine.Disable().Ok && policy.Rules.Count == 1 && policy.Rules[0].Same(foreign, true), "unrelated rule retained");
        });
        Test("an exact identifier with foreign owner or changed shape never gets replaced or deleted", delegate {
            foreach (Action<GuardRule> change in new Action<GuardRule>[] { r => r.Description = "foreign", r => r.Grouping = "foreign", r => r.ApplicationName = @"c:\other\300.exe", r => r.RemoteAddresses = "*", r => r.Protocol = 6, r => r.Direction = 1, r => r.ServiceName = "BITS", r => r.Interfaces = "custom" }) {
                var policy = new FakeGuardPolicy(); GuardRule colliding = ClientUpdateGuard.Specs(Root, new[] { "300.exe" })[0]; change(colliding); policy.Rules.Add(colliding); List<GuardRule> before = policy.ReadRules(); var engine = new GuardEngine(policy, Client());
                Check(!engine.Enable().Ok && !engine.Disable().Ok && EqualRules(policy.Rules, before), "collision refusal"); Check(policy.Adds == 0 && policy.Removes == 0, "no mutation");
            }
        });
        Test("disabled owned rules are refused without repair of baseline", delegate {
            var policy = new FakeGuardPolicy(); GuardRule row = ClientUpdateGuard.Specs(Root, new[] { "300.exe" })[0]; row.Enabled = false; policy.Rules.Add(row); var engine = new GuardEngine(policy, Client());
            Check(engine.Enable().Code == "RULE_DISABLED" && policy.Adds == 0 && !row.Enabled, "baseline not changed"); Check(engine.Disable().Ok && policy.Rules.Count == 0, "disabled rule removable");
        });
        Test("profile off and system policy prevent enabled claims but do not trap cleanup", delegate {
            for (int field = 0; field < 4; field++) {
                var policy = new FakeGuardPolicy(); if (field == 0) policy.Health.DomainEnabled = false; if (field == 1) policy.Health.PrivateEnabled = false; if (field == 2) policy.Health.PublicEnabled = false; if (field == 3) policy.Health.LocalPolicyModifyState = 1;
                policy.Rules.AddRange(ClientUpdateGuard.Specs(Root, ClientUpdateGuard.ProgramNames)); var engine = new GuardEngine(policy, Client());
                Check(!engine.Inspect().Protected && engine.Inspect().Policy != null && engine.Inspect().Details.Length > 0, "truthful inactive status"); Check(!engine.Enable().Ok && policy.Adds == 0, "no ineffective enable"); Check(engine.Disable().Ok && policy.Rules.Count == 0, "cleanup available");
            }
        });
        Test("failed add, including after-write failure, removes only newly created rules", delegate {
            foreach (bool after in new[] { false, true }) {
                var policy = new FakeGuardPolicy(); policy.Rules.Add(Foreign()); policy.Rules.Add(ClientUpdateGuard.Specs(Root, new[] { "300.exe" })[0]); List<GuardRule> before = policy.ReadRules(); policy.FailAddAt = 3; policy.ThrowAfterAdd = after;
                GuardStatus result = new GuardEngine(policy, Client()).Enable(); Check(!result.Ok && !result.Uncertain && EqualRules(policy.Rules, before), "exact enable rollback");
            }
        });
        Test("failed removal restores the complete original snapshots including disabled state", delegate {
            foreach (bool after in new[] { false, true }) {
                var policy = new FakeGuardPolicy(); policy.Rules.AddRange(ClientUpdateGuard.Specs(Root, ClientUpdateGuard.ProgramNames)); policy.Rules[1].Enabled = false; policy.Rules.Add(Foreign()); List<GuardRule> before = policy.ReadRules(); policy.FailRemoveAt = 3; policy.ThrowAfterRemove = after;
                GuardStatus result = new GuardEngine(policy, Client()).Disable(); Check(!result.Ok && !result.Uncertain && EqualRules(policy.Rules, before), "exact removal rollback");
            }
        });
        Test("rollback failure is explicitly uncertain and never reports protected", delegate {
            var policy = new FakeGuardPolicy(); policy.Rules.AddRange(ClientUpdateGuard.Specs(Root, ClientUpdateGuard.ProgramNames)); policy.FailRemoveAt = 2; policy.FailRollbackAdd = true;
            GuardStatus result = new GuardEngine(policy, Client()).Disable(); Check(!result.Ok && result.Uncertain && !result.Protected && result.State == "uncertain", "uncertain is visible");
        });
        Test("post-delete cleanup error is certain when the final baseline is independently verified", delegate {
            var policy = new FakeGuardPolicy(); List<GuardRule> before = policy.ReadRules(); policy.FailAddAt = 3; policy.FailRemoveAt = 1; policy.ThrowAfterRemove = true;
            GuardStatus result = new GuardEngine(policy, Client()).Enable(); Check(!result.Ok && !result.Uncertain && EqualRules(policy.Rules, before), "verified rollback overrides uncertain API acknowledgement");
        });
        Test("missing client remains inspectable and removable", delegate {
            var policy = new FakeGuardPolicy(); policy.Rules.AddRange(ClientUpdateGuard.Specs(Root, ClientUpdateGuard.ProgramNames)); var engine = new GuardEngine(policy, new GuardClient(Root, new string[0], false)); GuardStatus status = engine.Inspect();
            Check(status.HasRules && status.RulesKnown && !status.Protected && status.RuleCount == 6 && status.ExpectedCount == 0 && status.State == "orphaned", "orphan reported"); Check(engine.Disable().Ok && policy.Rules.Count == 0, "missing path cleanup");
        });
        Test("duplicate reserved identifiers fail before mutation", delegate {
            var policy = new FakeGuardPolicy(); GuardRule row = ClientUpdateGuard.Specs(Root, new[] { "300.exe" })[0]; policy.Rules.Add(row); policy.Rules.Add(row.Copy()); var engine = new GuardEngine(policy, Client());
            Check(!engine.Enable().Ok && !engine.Disable().Ok && policy.Adds == 0 && policy.Removes == 0, "duplicate identifiers rejected");
        });
        Test("UNC, relative, device, traversal and command-shaped inputs rejected without COM", delegate {
            foreach (string path in new[] { @"\\server\client", "relative", @"C:relative", @"\\?\C:\client", @"C:\client\..\other", "C:\\game\";boom", "C:\\game\nother", @"C:\game:stream" }) {
                bool rejected = false; try { ClientUpdateGuard.NormalizeDirectory(path, false); } catch { rejected = true; } Check(rejected, "unsafe path " + path);
            }
        });
        Console.WriteLine("PASS " + count + " test groups; no real firewall API was used.");
    }
}
