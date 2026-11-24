using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace WinCode.UIA.Host;

// A file operation in the existing Windows helper. It never initializes UIA or reads the source's contents.
internal static class TrashFileMove
{
    [StructLayout(LayoutKind.Sequential)]
    private struct HandleInfo {
        public FileAttributes Attributes;
        public FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct RenameInfo {
        public uint Replace;
        public IntPtr Directory;
        public uint NameBytes;
        public char FirstCharacter;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, FileShare share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out HandleInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder name, uint capacity, uint flags);
    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock { public IntPtr Status, Information; }
    [DllImport("ntdll.dll")]
    private static extern int NtSetInformationFile(SafeFileHandle file, out IoStatusBlock status, IntPtr data, uint length, int kind);
    [DllImport("ntdll.dll")]
    private static extern uint RtlNtStatusToDosError(int status);

    private static SafeFileHandle Open(string path, uint access, bool directory)
    {
        const uint openExisting = 3, openReparsePoint = 0x00200000, backupSemantics = 0x02000000;
        // P/Invoke does not apply the extended-length prefix that .NET file APIs add.
        var extended = path.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + path[2..] : @"\\?\" + path;
        var file = CreateFileW(extended, access, FileShare.ReadWrite, IntPtr.Zero, openExisting,
            openReparsePoint | (directory ? backupSemantics : 0), IntPtr.Zero);
        if (file.IsInvalid) { var error = new Win32Exception(); file.Dispose(); throw error; }
        return file;
    }

    private static HandleInfo Verify(SafeFileHandle file, string expected, bool directory)
    {
        if (!GetFileInformationByHandle(file, out var info)) throw new Win32Exception();
        if (info.Attributes.HasFlag(FileAttributes.ReparsePoint) || info.Attributes.HasFlag(FileAttributes.Directory) != directory)
            throw new IOException("File type changed during the move.");
        var name = new StringBuilder(32768);
        var size = GetFinalPathNameByHandleW(file, name, (uint)name.Capacity, 0);
        if (size == 0 || size >= name.Capacity) throw new IOException("Could not confirm the file handle path.");
        var actual = name.ToString();
        if (actual.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) actual = @"\\" + actual[8..];
        else if (actual.StartsWith(@"\\?\", StringComparison.Ordinal)) actual = actual[4..];
        if (!string.Equals(actual, expected, StringComparison.Ordinal))
            throw new IOException("File handle resolves to a different path.");
        return info;
    }

    internal static void Run(string[] args, CancellationToken token)
    {
        if (args.Length != 7) throw new ArgumentException("Expected root, source, trash directory, leaf name and file identity.");
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(args[1]));
        string source = Path.GetFullPath(args[2]), trash = Path.GetFullPath(args[3]), leaf = args[4];
        bool Inside(string parent, string child) {
            var rel = Path.GetRelativePath(parent, child);
            return rel != "." && rel != ".." && !rel.StartsWith(@"..\", StringComparison.Ordinal) && !Path.IsPathRooted(rel);
        }
        if (!Inside(root, source) || !Inside(root, trash) || Inside(trash, source) || leaf.Length == 0 || leaf is "." or ".." ||
            leaf.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || Path.GetFileName(leaf) != leaf)
            throw new ArgumentException("Invalid project trash location.");
        ulong volume = ulong.Parse(args[5], CultureInfo.InvariantCulture), inode = ulong.Parse(args[6], CultureInfo.InvariantCulture);
        using var sourceHandle = Open(source, 0x10000 | 0x80, false); // DELETE | FILE_READ_ATTRIBUTES
        var info = Verify(sourceHandle, source, false);
        if (inode == 0 || info.Volume != volume || (((ulong)info.IndexHigh << 32) | info.IndexLow) != inode)
            throw new IOException("Source file identity changed.");
        using var destination = Open(trash, 0x20 | 0x80, true); // FILE_TRAVERSE | FILE_READ_ATTRIBUTES
        Verify(destination, trash, true);
        var name = Encoding.Unicode.GetBytes(leaf);
        int offset = Marshal.OffsetOf<RenameInfo>(nameof(RenameInfo.FirstCharacter)).ToInt32();
        int length = Math.Max(Marshal.SizeOf<RenameInfo>(), offset + name.Length + sizeof(char));
        var buffer = Marshal.AllocHGlobal(length);
        try {
            Marshal.StructureToPtr(new RenameInfo { Directory = destination.DangerousGetHandle(), NameBytes = (uint)name.Length }, buffer, false);
            Marshal.Copy(name, 0, buffer + offset, name.Length);
            Marshal.WriteInt16(buffer, offset + name.Length, 0);
            token.ThrowIfCancellationRequested();
            // FILE_RENAME_INFORMATION takes a simple name relative to the held destination directory.
            int status = NtSetInformationFile(sourceHandle, out _, buffer, (uint)length, 10 /* FileRenameInformation */);
            if (status != 0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
            GC.KeepAlive(destination);
        } finally { Marshal.FreeHGlobal(buffer); }
    }
}
