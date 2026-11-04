//! アプリ内アップデート。GitHub のリリースに新しい版があれば、ダウンロードして入れ替え、再起動する。
//! - Windows：インストーラー（-setup.exe）を画面なしで実行してから起動し直す
//! - Mac：新しい Aizome.app に入れ替えてから起動し直す
//! - Linux：AppImage で使っているときだけ、ファイルを入れ替えて起動し直す

use futures_util::StreamExt;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// 更新を配っているリポジトリ
const REPO: &str = "setsukashiraishi-hub/Aizome";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current: String,
    latest: Option<String>,
    available: bool,
    /// このアプリの入れ方では自動で入れ替えられない（Linux の .deb など）
    manual_only: bool,
    notes: Option<String>,
    download_url: Option<String>,
    page_url: String,
}

#[derive(Serialize, Clone)]
struct Progress {
    received: u64,
    total: u64,
}

fn client(redirects: bool) -> reqwest::Client {
    let mut b = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("Aizome/", env!("CARGO_PKG_VERSION")));
    if !redirects {
        b = b.redirect(reqwest::redirect::Policy::none());
    }
    b.build().unwrap_or_default()
}

fn parse_version(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches('v')
        .split(['.', '-', '+'])
        .take(3)
        .map(|p| p.parse::<u64>().unwrap_or(0))
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (parse_version(latest), parse_version(current));
    for i in 0..3 {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// AppImage で動いているときのファイルの場所
fn appimage_path() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_file())
}

/// この OS 用の、入れ替えに使うファイル名
fn asset_name(version: &str) -> Option<String> {
    if cfg!(windows) {
        Some(format!("Aizome_{version}_x64-setup.exe"))
    } else if cfg!(target_os = "macos") {
        Some("Aizome_universal.app.tar.gz".into())
    } else if appimage_path().is_some() {
        Some(format!("Aizome_{version}_amd64.AppImage"))
    } else {
        None
    }
}

/// 最新版の番号を調べる。API の回数制限を避けるため、まず releases/latest の転送先から読む
async fn latest_tag() -> Result<String, String> {
    let url = format!("https://github.com/{REPO}/releases/latest");
    let resp = client(false).get(&url).send().await.map_err(|e| format!("NETWORK: {e}"))?;
    if let Some(loc) = resp.headers().get("location").and_then(|l| l.to_str().ok()) {
        if let Some(tag) = loc.rsplit("/tag/").next().filter(|t| !t.contains('/') && !t.is_empty()) {
            return Ok(tag.to_string());
        }
    }
    // うまくいかなければ API で
    let api = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let v: serde_json::Value = client(true)
        .get(api)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("NETWORK: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    v.get("tag_name").and_then(|t| t.as_str()).map(String::from).ok_or_else(|| "NO_RELEASE".into())
}

async fn release_notes(tag: &str) -> Option<String> {
    let api = format!("https://api.github.com/repos/{REPO}/releases/tags/{tag}");
    let v: serde_json::Value = client(true)
        .get(api)
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    v.get("body").and_then(|b| b.as_str()).map(|s| s.chars().take(2000).collect())
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let page_url = format!("https://github.com/{REPO}/releases/latest");
    let tag = latest_tag().await?;
    let latest = tag.trim_start_matches('v').to_string();
    let available = is_newer(&latest, &current);
    let asset = asset_name(&latest);
    let notes = if available { release_notes(&tag).await } else { None };
    Ok(UpdateInfo {
        current,
        available,
        manual_only: available && asset.is_none(),
        download_url: asset.map(|a| format!("https://github.com/{REPO}/releases/download/{tag}/{a}")),
        latest: Some(latest),
        notes,
        page_url,
    })
}

async fn download(app: &AppHandle, url: &str, dest: &Path) -> Result<(), String> {
    let resp = client(true).get(url).send().await.map_err(|e| format!("NETWORK: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("NETWORK: {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if received - last_emit > 256 * 1024 || received == total {
            last_emit = received;
            let _ = app.emit("update:progress", Progress { received, total });
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    if total > 0 && received != total {
        return Err("DOWNLOAD_INCOMPLETE".into());
    }
    Ok(())
}

fn work_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("aizome-update");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 更新係として起動されたことを示す引数
pub const HELPER_FLAG: &str = "--aizome-apply-update";

/// 更新係として起動されたなら、入れ替えを行って true を返す（Windows のみ）。
/// 引数: --aizome-apply-update <インストーラー> <終わりを待つ PID> <起動し直す exe>
pub fn run_helper_if_requested() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(HELPER_FLAG) {
        return false;
    }
    #[cfg(windows)]
    {
        let (Some(installer), Some(pid), Some(exe)) = (args.get(2), args.get(3).and_then(|p| p.parse::<u32>().ok()), args.get(4)) else {
            return true;
        };
        wait_for_exit(pid);
        // NSIS のインストーラーを画面なしで実行し、終わるのを待つ
        let ok = Command::new(installer).arg("/S").status().map(|s| s.success()).unwrap_or(false);
        let _ = ok;
        let _ = Command::new(exe).spawn();
    }
    true
}

#[cfg(windows)]
fn wait_for_exit(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
    const SYNCHRONIZE: u32 = 0x0010_0000;
    unsafe {
        let h = OpenProcess(SYNCHRONIZE, 0, pid);
        if !h.is_null() {
            WaitForSingleObject(h, 60_000);
            CloseHandle(h);
        }
    }
}

/// このアプリが終わるのを待ってから、入れ替えて起動し直すスクリプトを動かす（Mac / Linux）
#[cfg(not(windows))]
fn spawn_detached_script(dir: &Path, script: String) -> Result<(), String> {
    {
        let path = dir.join("update.sh");
        std::fs::write(&path, script).map_err(|e| e.to_string())?;
        Command::new("/bin/sh")
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn q(p: &Path) -> String {
    p.to_string_lossy().replace('"', "")
}

/// ダウンロードして入れ替える。成功するとアプリは終了し、新しい版が起動する
#[tauri::command]
pub async fn update_install(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with(&format!("https://github.com/{REPO}/releases/download/")) {
        return Err("INVALID_URL".into());
    }
    let dir = work_dir()?;
    let pid = std::process::id();
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;

    #[cfg(windows)]
    {
        let installer = dir.join("Aizome-setup.exe");
        download(&app, &url, &installer).await?;
        // 動いている Aizome.exe は上書きできないので、Aizome 自身の写しを「更新係」として動かす。
        // 更新係はこのアプリが終わるのを待ち、インストーラーを実行して、新しい Aizome を起動する
        let helper = dir.join("Aizome-updater.exe");
        std::fs::copy(&exe, &helper).map_err(|e| e.to_string())?;
        use std::os::windows::process::CommandExt;
        Command::new(&helper)
            .arg(HELPER_FLAG)
            .arg(&installer)
            .arg(pid.to_string())
            .arg(&exe)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0000_0008) // このアプリから切り離す
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        // .../Aizome.app/Contents/MacOS/aizome から .app の場所を求める
        let bundle = exe
            .ancestors()
            .find(|p| p.extension().map(|e| e == "app").unwrap_or(false))
            .map(Path::to_path_buf)
            .ok_or("NOT_APP_BUNDLE")?;
        let archive = dir.join("Aizome.app.tar.gz");
        download(&app, &url, &archive).await?;
        let status = Command::new("tar").arg("-xzf").arg(&archive).arg("-C").arg(&dir).status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("EXTRACT_FAILED".into());
        }
        let new_app = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().map(|e| e == "app").unwrap_or(false))
            .ok_or("EXTRACT_FAILED")?;
        let script = format!(
            "while kill -0 {pid} 2>/dev/null; do sleep 0.5; done\n\
             rm -rf \"{old}.old\"\n\
             mv \"{old}\" \"{old}.old\" && mv \"{new}\" \"{old}\" && rm -rf \"{old}.old\" || mv \"{old}.old\" \"{old}\"\n\
             xattr -dr com.apple.quarantine \"{old}\" 2>/dev/null\n\
             open \"{old}\"\n",
            old = q(&bundle),
            new = q(&new_app),
        );
        spawn_detached_script(&dir, script)?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = appimage_path().ok_or("MANUAL_ONLY")?;
        let file = dir.join("Aizome.AppImage");
        download(&app, &url, &file).await?;
        let script = format!(
            "while kill -0 {pid} 2>/dev/null; do sleep 0.5; done\n\
             chmod +x \"{new}\"\n\
             mv -f \"{new}\" \"{old}\"\n\
             nohup \"{old}\" >/dev/null 2>&1 &\n",
            new = q(&file),
            old = q(&target),
        );
        let _ = exe;
        spawn_detached_script(&dir, script)?;
    }

    // 自分で起動した Ollama を止めてから終了する
    app.state::<crate::local_ai::LocalAiState>().shutdown();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        std::thread::sleep(Duration::from_millis(300));
        handle.exit(0);
    });
    Ok(())
}
