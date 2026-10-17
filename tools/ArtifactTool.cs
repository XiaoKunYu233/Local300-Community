// .NET Framework helper: inspect one pinned release resource, or archive this
// checkout's generated payload. It never invokes the release entry point.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

static class ArtifactTool {
    const string AcceptedExe = "c453821d4380fd66761e4810e24e6543d9a55470c61695cdfd70e30c69cbc051";
    const string AcceptedPayload = "fdf4dac26404deeb6f3e193532b7975318304d442db6a5425116fecc0e0a71fe";
    const string AcceptedIndex = "19b209ca8e046eb7c09095f436b99c503af1c13eac2fc863e8d45e326dc3a9af";
    const string ImportManifest = "ASSET-IMPORT.json", SourceIndex = "SOURCE-FILE-INDEX.json";
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly string Root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
    static readonly string Local = Path.Combine(Root, ".local");
    static readonly string Assets = Path.Combine(Local, "assets");
    static readonly string Payload = Path.Combine(Local, "build", "payload");
    static readonly string Archive = Path.Combine(Local, "build", "payload.zip");
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
    static string Hash(byte[] bytes) { using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static void Require(bool condition, string message) { if (!condition) throw new InvalidDataException(message); }
    static string SafeName(string name) {
        Require(!String.IsNullOrEmpty(name) && name.Length <= 512 && !Regex.IsMatch(name, "[\\\\:\\x00-\\x1f<>\"|?*]"), "Invalid archive path.");
        foreach (string piece in name.Split('/')) Require(piece.Length > 0 && piece != "." && piece != ".." && !piece.EndsWith(".") && !piece.EndsWith(" ") && !Regex.IsMatch(piece, @"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", RegexOptions.IgnoreCase), "Invalid archive path.");
        return name;
    }
    static string Ordinary(string file) {
        string result = Path.GetFullPath(file);
        Require(!result.StartsWith(@"\\", StringComparison.Ordinal) && result.Length > 3 && result[1] == ':', "Use an ordinary absolute local-drive path.");
        for (string current = result; current != null; current = Path.GetDirectoryName(current)) {
            try { Require((File.GetAttributes(current) & FileAttributes.ReparsePoint) == 0, "Redirected paths are not supported."); }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
        return result;
    }
    static string Within(string directory, string name) {
        string result = Ordinary(Path.Combine(directory, SafeName(name).Replace('/', Path.DirectorySeparatorChar)));
        Require(result.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "Archive path escapes its fixed directory.");
        Require(result.Length < 260 && Path.GetDirectoryName(result).Length < 248, "Checkout path is too long for .NET Framework. Move this checkout to a shorter path.");
        return result;
    }
    static bool IsAsset(string name) {
        SafeName(name);
        string[] pieces = name.Split('/');
        if (pieces.Any(p => new[] { "local300-data", "save", ".git", ".local", "sealed-code" }.Contains(p.ToLowerInvariant()))) return false;
        if (name == "public-assets-index.json") return true;
        return new[] { "data", "decoded", "docs", "map", "runtime", "server" }.Contains(pieces[0]) && new[] { ".json", ".jsonl", ".bin", ".tga", ".tsv", ".lua", ".txt", ".md" }.Contains(Path.GetExtension(name).ToLowerInvariant());
    }
    static List<Dictionary<string, object>> Rows(byte[] data) {
        var rows = Json.Deserialize<List<Dictionary<string, object>>>(Utf8.GetString(data));
        Require(rows != null && rows.Count > 0 && rows.Count <= 10000, "Invalid file index.");
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in rows) {
            Require(row.Count == 3 && row.ContainsKey("path") && row.ContainsKey("bytes") && row.ContainsKey("sha256"), "Invalid index row.");
            string name = SafeName(row["path"] as string), hash = row["sha256"] as string;
            Require(seen.Add(name), "Duplicate file-index path.");
            object size = row["bytes"];
            Require(size is int || size is long, "Invalid file-index size.");
            long length = Convert.ToInt64(size);
            Require(length >= 0 && length <= 512L * 1024 * 1024 && hash != null && Regex.IsMatch(hash, "^[0-9a-f]{64}$"), "Invalid file-index size/hash.");
        }
        return rows;
    }
    static byte[] ReadEntry(ZipArchiveEntry entry, long expected) {
        Require(entry.Length == expected && expected >= 0 && expected <= 512L * 1024 * 1024, "Archive size mismatch.");
        using (var input = entry.Open()) using (var output = new MemoryStream()) {
            byte[] block = new byte[65536]; int count;
            while ((count = input.Read(block, 0, block.Length)) > 0) { Require(output.Length + count <= expected, "Expanded archive entry exceeds its declared size."); output.Write(block, 0, count); }
            Require(output.Length == expected, "Truncated archive entry."); return output.ToArray();
        }
    }
    static Dictionary<string, ZipArchiveEntry> Entries(ZipArchive zip) {
        var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
        Require(zip.Entries.Count <= 10000, "Archive contains too many entries.");
        foreach (var entry in zip.Entries) {
            string name = entry.FullName;
            Require(!name.EndsWith("/"), "The pinned payload must contain file entries only.");
            SafeName(name);
            Require(((entry.ExternalAttributes >> 16) & 0xf000) != 0xa000 && (entry.ExternalAttributes & (int)FileAttributes.ReparsePoint) == 0, "Archive links are not supported.");
            Require(!entries.ContainsKey(name), "Duplicate archive entry."); entries.Add(name, entry);
        }
        return entries;
    }
    static void Import(string source) {
        source = Ordinary(source); Require(File.Exists(source), "Release EXE was not found.");
        Require(new FileInfo(source).Length == 43215872, "Release EXE size mismatch. Nothing imported.");
        byte[] executable = File.ReadAllBytes(source);
        Require(Hash(executable) == AcceptedExe, "Release EXE SHA-256 mismatch. Nothing imported.");
        Require(!Directory.Exists(Assets) && !File.Exists(Assets), "Local assets already exist; run verify-assets instead.");
        // Reflection-only metadata/resource access cannot execute Main, type
        // initializers, or methods in the supplied (already pinned) assembly.
        Assembly assembly = Assembly.ReflectionOnlyLoad(executable);
        byte[] payload;
        using (var stream = assembly.GetManifestResourceStream("payload")) {
            Require(stream != null, "Release payload resource is missing.");
            using (var output = new MemoryStream()) { stream.CopyTo(output); payload = output.ToArray(); }
        }
        Require(Hash(payload) == AcceptedPayload, "Release payload SHA-256 mismatch.");
        string staging = Ordinary(Path.Combine(Local, ".import-" + Guid.NewGuid().ToString("N")));
        Ordinary(Local); Directory.CreateDirectory(Local);
        try {
            using (var zip = new ZipArchive(new MemoryStream(payload), ZipArchiveMode.Read)) {
                var entries = Entries(zip); ZipArchiveEntry indexEntry;
                Require(entries.TryGetValue("file-index.json", out indexEntry) && indexEntry.Length <= 16 * 1024 * 1024, "Release file index is missing.");
                byte[] index = ReadEntry(indexEntry, indexEntry.Length);
                Require(Hash(index) == AcceptedIndex, "Release file-index SHA-256 mismatch.");
                var rows = Rows(index);
                Require(entries.Count == rows.Count + 1, "Archive and allowlist have different entry counts.");
                var imported = new List<Dictionary<string, object>>();
                foreach (var row in rows) {
                    string name = (string)row["path"]; ZipArchiveEntry entry;
                    Require(entries.TryGetValue(name, out entry) && entry.FullName == name, "Indexed entry is missing or its case differs.");
                    byte[] bytes = ReadEntry(entry, Convert.ToInt64(row["bytes"]));
                    Require(Hash(bytes) == (string)row["sha256"], "Indexed entry SHA-256 mismatch: " + name);
                    if (!IsAsset(name)) continue;
                    string destination = Within(staging, name); Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write)) output.Write(bytes, 0, bytes.Length);
                    imported.Add(row);
                }
                Directory.CreateDirectory(staging);
                File.WriteAllBytes(Path.Combine(staging, SourceIndex), index);
                var manifest = new Dictionary<string, object> {
                    { "format", "local300-local-assets-v1" }, { "sourceExeSha256", AcceptedExe },
                    { "payloadSha256", AcceptedPayload }, { "indexSha256", AcceptedIndex }, { "files", imported }
                };
                File.WriteAllText(Path.Combine(staging, ImportManifest), Json.Serialize(manifest) + "\n", Utf8);
                Ordinary(Assets); Directory.Move(staging, Assets);
                Console.WriteLine("Imported " + imported.Count + " local-only asset files from the pinned release. Skipped code, sealed modules, and Node executable.");
            }
        } finally {
            // Staging is generated here, immediately below this checkout's
            // .local directory, and never accepts a caller-provided path.
            if (Directory.Exists(staging)) { Ordinary(staging); Directory.Delete(staging, true); }
        }
    }
    static List<string> Files(string directory) {
        Ordinary(directory); var files = new List<string>();
        foreach (string entry in Directory.GetFileSystemEntries(directory).OrderBy(p => p, StringComparer.Ordinal)) {
            Ordinary(entry); FileAttributes attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.Directory) != 0) files.AddRange(Files(entry)); else files.Add(entry);
        }
        return files;
    }
    static void Zip() {
        Ordinary(Payload); Ordinary(Archive); Require(Directory.Exists(Payload), "Generated payload is missing.");
        Require(!File.Exists(Archive) && !Directory.Exists(Archive), "Generated payload ZIP already exists.");
        var files = Files(Payload).Select(f => new { File = f, Name = f.Substring(Payload.Length + 1).Replace('\\', '/') }).OrderBy(f => f.Name, StringComparer.Ordinal).ToList();
        Require(files.Count > 0 && files.Any(f => f.Name == "file-index.json"), "Generated payload has no file index.");
        var unique = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using (var output = new FileStream(Archive, FileMode.CreateNew, FileAccess.Write)) using (var zip = new ZipArchive(output, ZipArchiveMode.Create)) {
            foreach (var file in files) {
                SafeName(file.Name); Require(unique.Add(file.Name), "Duplicate generated path.");
                var entry = zip.CreateEntry(file.Name, CompressionLevel.Optimal);
                entry.LastWriteTime = new DateTimeOffset(2000, 1, 1, 0, 0, 0, TimeSpan.Zero); entry.ExternalAttributes = 0;
                using (var input = File.OpenRead(file.File)) using (var destination = entry.Open()) input.CopyTo(destination);
            }
        }
        Console.WriteLine("Created generated payload ZIP (" + files.Count + " files). No program was started.");
    }
    static void VerifyBuild() {
        string file = Ordinary(Path.Combine(Root, "dist", "Local300-v0.12.exe"));
        Require(File.Exists(file), "Community build EXE is missing.");
        Assembly assembly = Assembly.ReflectionOnlyLoad(File.ReadAllBytes(file));
        Type info = assembly.GetType("BuildInfo", true);
        string payloadHash = (string)info.GetField("PayloadSHA", BindingFlags.Static | BindingFlags.NonPublic).GetRawConstantValue();
        string indexHash = (string)info.GetField("IndexSHA", BindingFlags.Static | BindingFlags.NonPublic).GetRawConstantValue();
        byte[] payload;
        using (var input = assembly.GetManifestResourceStream("payload")) using (var output = new MemoryStream()) {
            Require(input != null, "Community build payload is missing."); input.CopyTo(output); payload = output.ToArray();
        }
        Require(Hash(payload) == payloadHash && Hash(File.ReadAllBytes(Ordinary(Archive))) == payloadHash, "Community embedded payload differs from its generated ZIP.");
        using (var zip = new ZipArchive(new MemoryStream(payload), ZipArchiveMode.Read)) {
            var entries = Entries(zip); ZipArchiveEntry indexEntry;
            Require(entries.TryGetValue("file-index.json", out indexEntry), "Community build index is missing.");
            byte[] index = ReadEntry(indexEntry, indexEntry.Length);
            Require(Hash(index) == indexHash, "Community build index SHA-256 mismatch.");
            var rows = Rows(index); Require(entries.Count == rows.Count + 1, "Community build ZIP contains unlisted files.");
            int sourceCount = 0;
            foreach (var row in rows) {
                string name = (string)row["path"]; ZipArchiveEntry entry;
                Require(entries.TryGetValue(name, out entry) && entry.FullName == name, "Community build indexed file is missing.");
                byte[] bytes = ReadEntry(entry, Convert.ToInt64(row["bytes"]));
                Require(Hash(bytes) == (string)row["sha256"] && Hash(File.ReadAllBytes(Within(Payload, name))) == (string)row["sha256"], "Community build indexed bytes changed: " + name);
                Require(!name.StartsWith("sealed-code/", StringComparison.OrdinalIgnoreCase) && name != "sealed-loader.js" && !name.Split('/').Any(p => p.Equals("Local300-data", StringComparison.OrdinalIgnoreCase)), "Sealed code or runtime user data entered the community build.");
                if (name.EndsWith(".js", StringComparison.OrdinalIgnoreCase)) {
                    Require(Hash(File.ReadAllBytes(Within(Root, name))) == (string)row["sha256"], "Community JS differs from editable source: " + name); sourceCount++;
                }
            }
            Console.WriteLine("Verified embedded community payload: " + sourceCount + " editable JS files; " + rows.Count + " indexed files; no sealed modules or runtime user saves. EXE was not executed.");
        }
    }
    static void SelfTest() {
        int checks = 0;
        foreach (string invalid in new[] { "../secret", "/root", "C:/root", "a\\b", "a//b", "a/./b", "a/../b", "x.", "a/nul.txt", "a/b ", "a/evil:stream", "a/evil*" }) {
            bool rejected = false; try { SafeName(invalid); } catch (InvalidDataException) { rejected = true; } Require(rejected, "Unsafe name accepted."); checks++;
        }
        Require(IsAsset("server/public-beta/release-template/role.bin") && IsAsset("server/items.json"), "Expected static assets rejected."); checks++;
        Require(!IsAsset("server/liveserver.js") && !IsAsset("sealed-code/key.bin") && !IsAsset("runtime/node.exe") && !IsAsset("Local300-data/save/admin/a.json"), "Code/runtime data accepted as assets."); checks++;
        byte[] duplicate = Utf8.GetBytes("[{\"path\":\"server/A.json\",\"bytes\":0,\"sha256\":\"" + new string('0', 64) + "\"},{\"path\":\"server/a.json\",\"bytes\":0,\"sha256\":\"" + new string('0', 64) + "\"}]");
        bool blocked = false; try { Rows(duplicate); } catch (InvalidDataException) { blocked = true; } Require(blocked, "Case-colliding index accepted."); checks++;
        using (var memory = new MemoryStream()) {
            using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, true)) { var link = zip.CreateEntry("server/link.json"); link.ExternalAttributes = 0xa000 << 16; }
            memory.Position = 0; using (var zip = new ZipArchive(memory, ZipArchiveMode.Read)) { blocked = false; try { Entries(zip); } catch (InvalidDataException) { blocked = true; } Require(blocked, "ZIP link accepted."); checks++; }
        }
        Console.WriteLine("PASS artifact helper synthetic checks: " + checks + ". No release EXE, service, client, or firewall was invoked.");
    }
    static int Main(string[] args) {
        try {
            Require(Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar).Equals(Path.Combine(Root, ".local", "tools"), StringComparison.OrdinalIgnoreCase), "Helper must run from this checkout's .local/tools directory.");
            Ordinary(Root);
            if (args.Length == 2 && args[0] == "import") Import(args[1]);
            else if (args.Length == 1 && args[0] == "zip") Zip();
            else if (args.Length == 1 && args[0] == "self-test") SelfTest();
            else if (args.Length == 1 && args[0] == "verify-build") VerifyBuild();
            else throw new InvalidDataException("Allowed helper modes: import <pinned-exe>, zip, verify-build, self-test. Output paths are fixed to this checkout.");
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
