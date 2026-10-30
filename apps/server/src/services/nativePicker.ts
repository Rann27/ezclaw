import { spawn } from "node:child_process";
import { HttpError } from "../errors.js";

/**
 * The Windows "choose folder" dialog (the Explorer-style IFileOpenDialog with FOS_PICKFOLDERS),
 * opened by the server because a web page is never told a folder's real path. A small hidden
 * topmost window owns the dialog so it appears in front of the browser.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EzFolderDialog {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItem ppv);

  public static string Pick(IntPtr owner, string title, string initial) {
    IFileDialog dlg = (IFileDialog)new FileOpenDialogRCW();
    uint opts; dlg.GetOptions(out opts);
    dlg.SetOptions(opts | 0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    dlg.SetTitle(title);
    dlg.SetOkButtonLabel("Pakai folder ini");
    if (!String.IsNullOrEmpty(initial)) {
      try {
        Guid iid = typeof(IShellItem).GUID;
        IShellItem start; SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out start);
        dlg.SetFolder(start);
      } catch { }
    }
    int hr = dlg.Show(owner);
    if (hr != 0) return null; // cancelled (or closed)
    IShellItem item; dlg.GetResult(out item);
    string path; item.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
'@
if ($env:EZ_PICK_CHECK) { 'ok'; exit 0 }
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$owner.Show()
$owner.Activate()
$picked = [EzFolderDialog]::Pick($owner.Handle, $env:EZ_PICK_TITLE, $env:EZ_PICK_INITIAL)
$owner.Close()
if ($picked) { 'PATH:' + $picked } else { 'CANCEL' }
`;

const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
let busy = false;

function runPowerShell(env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", windir: process.env.windir ?? "C:\\Windows", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "", USERPROFILE: process.env.USERPROFILE ?? "", PSModulePath: process.env.PSModulePath ?? "", ...env },
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Dialog folder tidak dijawab dalam batas waktu."));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim().split(/\r?\n/)[0] || `PowerShell keluar dengan kode ${code}.`));
    });
  });
}

/** Opens the Windows folder dialog. Returns the chosen path, or null when the owner cancels. */
export async function pickFolderNative(opts: { initial?: string | null; title?: string } = {}): Promise<string | null> {
  if (process.platform !== "win32") throw new HttpError(501, "picker_unsupported", "Dialog folder sistem hanya tersedia di Windows.");
  if (busy) throw new HttpError(409, "picker_busy", "Dialog folder sudah terbuka. Selesaikan dulu di jendela itu.");
  busy = true;
  try {
    const out = await runPowerShell({ EZ_PICK_TITLE: opts.title ?? "Pilih folder", EZ_PICK_INITIAL: opts.initial ?? "" }, 15 * 60_000);
    const line = out.split(/\r?\n/).find((l) => l.startsWith("PATH:") || l === "CANCEL");
    if (!line) throw new Error(out || "Dialog folder tidak memberi jawaban.");
    return line === "CANCEL" ? null : line.slice(5);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, "picker_failed", `Dialog folder Windows gagal dibuka: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    busy = false;
  }
}

/** Compiles the dialog code without showing anything; used by tests. */
export async function checkNativePicker(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  return (await runPowerShell({ EZ_PICK_CHECK: "1" }, 60_000)).endsWith("ok");
}
