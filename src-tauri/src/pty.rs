//! 疑似端末（PTY）。本物のシェルを起動し、入出力をフロントエンドへ中継する。

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

#[derive(Clone, Serialize)]
struct DataPayload {
    id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: u32,
    code: Option<u32>,
}

pub fn default_shell() -> String {
    static SHELL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SHELL.get_or_init(detect_shell).clone()
}

fn detect_shell() -> String {
    #[cfg(windows)]
    {
        // where コマンドを起動せず、PATH から pwsh.exe を探す
        let has_pwsh = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|d| d.join("pwsh.exe").is_file()))
            .unwrap_or(false);
        if has_pwsh { "pwsh.exe".into() } else { "powershell.exe".into() }
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

/// 末尾で途切れた UTF-8 の手前までの長さを返す（文字化け防止）
fn utf8_valid_prefix(b: &[u8]) -> usize {
    match std::str::from_utf8(b) {
        Ok(_) => b.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => b.len(),
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// "C:\\Program Files\\Git\\bin\\bash.exe" --login のように、引用符を考えて分ける
fn split_command(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in s.trim().chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[derive(Serialize)]
pub struct ShellInfo {
    name: String,
    command: String,
}

/// この PC で使えるシェルの一覧（ターミナルの「＋」から選べる）
#[tauri::command(async)]
pub fn pty_shells() -> Vec<ShellInfo> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        let in_path = |exe: &str| {
            std::env::var_os("PATH").map(|p| std::env::split_paths(&p).any(|d| d.join(exe).is_file())).unwrap_or(false)
        };
        out.push(ShellInfo { name: "PowerShell".into(), command: "powershell.exe".into() });
        if in_path("pwsh.exe") {
            out.push(ShellInfo { name: "PowerShell 7".into(), command: "pwsh.exe".into() });
        }
        out.push(ShellInfo { name: "コマンドプロンプト (cmd)".into(), command: "cmd.exe".into() });
        for base in [std::env::var("ProgramFiles").unwrap_or_default(), std::env::var("LOCALAPPDATA").map(|l| format!("{l}\\Programs")).unwrap_or_default()] {
            let bash = Path::new(&base).join("Git").join("bin").join("bash.exe");
            if !base.is_empty() && bash.is_file() {
                out.push(ShellInfo { name: "Git Bash".into(), command: format!("\"{}\" --login -i", bash.to_string_lossy()) });
                break;
            }
        }
        if in_path("wsl.exe") {
            out.push(ShellInfo { name: "WSL (Linux)".into(), command: "wsl.exe".into() });
        }
    }
    #[cfg(not(windows))]
    {
        let mut seen = std::collections::HashSet::new();
        let mut add = |cmd: String| {
            if Path::new(&cmd).is_file() && seen.insert(cmd.clone()) {
                let name = Path::new(&cmd).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(cmd.clone());
                out.push(ShellInfo { name, command: cmd });
            }
        };
        if let Ok(sh) = std::env::var("SHELL") {
            add(sh);
        }
        if let Ok(list) = std::fs::read_to_string("/etc/shells") {
            for l in list.lines().map(str::trim).filter(|l| l.starts_with('/')) {
                add(l.to_string());
            }
        }
    }
    out
}

#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(err)?;

    let shell = shell.filter(|s| !s.trim().is_empty()).unwrap_or_else(default_shell);
    let parts = split_command(&shell);
    let program = parts.first().cloned().unwrap_or_else(|| "sh".into());
    let mut cmd = CommandBuilder::new(&program);
    let user_args = &parts[1..];
    for a in user_args {
        cmd.arg(a);
    }
    // Windows の日本語が文字化けしないよう、UTF-8 で動かす
    #[cfg(windows)]
    {
    if user_args.is_empty() {
        let exe = Path::new(&program).file_name().map(|f| f.to_string_lossy().to_lowercase()).unwrap_or_default();
        if exe == "cmd.exe" || exe == "cmd" {
            cmd.args(["/K", "chcp 65001 >nul"]);
        } else if exe.starts_with("powershell") || exe.starts_with("pwsh") {
            cmd.args([
                "-NoLogo",
                "-NoExit",
                "-Command",
                // Tab：候補を一覧にして矢印で選ぶ（MenuComplete）。↑↓：打ちかけの文字から始まる前のコマンドを探す
                "[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; $PSDefaultParameterValues['Out-File:Encoding']='utf8'; chcp 65001 > $null; try { Set-PSReadLineKeyHandler -Key Tab -Function MenuComplete -ErrorAction Stop; Set-PSReadLineKeyHandler -Key UpArrow -Function HistorySearchBackward; Set-PSReadLineKeyHandler -Key DownArrow -Function HistorySearchForward } catch {}",
            ]);
        }
    }
    }
    // 画面への入出力（print・input）だけを UTF-8 にする。
    // open() でファイルを読み書きするときは、VS Code などと同じく OS の既定（日本語の Windows なら Shift_JIS）のまま
    cmd.env("PYTHONIOENCODING", "utf-8");
    match cwd.filter(|c| Path::new(c).is_dir()) {
        Some(c) => cmd.cwd(c),
        None => cmd.cwd(crate::fsops::home_dir()),
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Aizome");

    let child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;

    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    state
        .sessions
        .lock()
        .map_err(err)?
        .insert(id, Session { master: pair.master, writer, child });

    // 出力の読み取り。たくさん出力するプログラムでも画面が固まらないよう、
    // 読んだ分はためておき、別のスレッドが 16ms ごと（1 秒に約 60 回）にまとめて送る
    let shared: Arc<(Mutex<Vec<u8>>, AtomicBool)> = Arc::new((Mutex::new(Vec::new()), AtomicBool::new(false)));
    let reader_side = shared.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut b) = reader_side.0.lock() {
                        // 画面が追いつかないほど出たら、古い分は捨てて最新を見せる
                        if b.len() > 4 * 1024 * 1024 {
                            let cut = b.len() - 1024 * 1024;
                            b.drain(..cut);
                        }
                        b.extend_from_slice(&buf[..n]);
                    }
                }
            }
        }
        reader_side.1.store(true, Ordering::SeqCst);
    });
    let app_out = app.clone();
    std::thread::spawn(move || {
        let mut carry: Vec<u8> = Vec::new();
        loop {
            std::thread::sleep(Duration::from_millis(16));
            let finished = shared.1.load(Ordering::SeqCst);
            let chunk = match shared.0.lock() {
                Ok(mut b) => std::mem::take(&mut *b),
                Err(_) => break,
            };
            if !chunk.is_empty() {
                carry.extend_from_slice(&chunk);
                let valid = utf8_valid_prefix(&carry);
                if valid > 0 {
                    let data = String::from_utf8_lossy(&carry[..valid]).to_string();
                    carry.drain(..valid);
                    let _ = app_out.emit("pty:data", DataPayload { id, data });
                }
            }
            if finished && chunk.is_empty() {
                break;
            }
        }
    });

    // 終了の監視（Windows の ConPTY は読み取り側に EOF が届かないことがあるため別スレッドで見る）
    let app_exit = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        let st = app_exit.state::<PtyState>();
        let mut sessions = match st.sessions.lock() {
            Ok(s) => s,
            Err(_) => break,
        };
        let Some(session) = sessions.get_mut(&id) else { break };
        if let Ok(Some(status)) = session.child.try_wait() {
            sessions.remove(&id);
            drop(sessions);
            let _ = app_exit.emit("pty:exit", ExitPayload { id, code: Some(status.exit_code()) });
            break;
        }
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(err)?;
    let s = sessions.get_mut(&id).ok_or("NO_SESSION")?;
    s.writer.write_all(data.as_bytes()).map_err(err)?;
    s.writer.flush().map_err(err)
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(err)?;
    let s = sessions.get(&id).ok_or("NO_SESSION")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(err)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    let removed = state.sessions.lock().map_err(err)?.remove(&id);
    if let Some(mut s) = removed {
        let _ = s.child.kill();
    }
    Ok(())
}
